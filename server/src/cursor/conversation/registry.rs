//! Maps conversation IDs to active conversation runtimes.

use std::{collections::HashMap, sync::Arc};

use tokio::sync::{mpsc, Mutex, Notify};

use crate::{
    cursor::{
        checkpoint::SubagentCompletions, prompting::PromptCompiler, transport::TransportHandle,
    },
    model::{ConversationId, RunId},
    protocol::Provider,
    run::{CommandResult, RunHandle},
    search::WebCache,
    store::Store,
};

use super::{CompiledMessages, MessageDelivery, PendingMessages, TransportCommand};

#[derive(Clone)]
pub struct ConversationRegistry {
    inner: Arc<RegistryInner>,
}

#[derive(Clone)]
pub(crate) struct ConversationDependencies {
    pub store: Store,
    pub provider: Arc<dyn Provider>,
    pub compiler: PromptCompiler,
    pub web_cache: WebCache,
    /// The local rules service's md storage directory; merged into the request context at compile time.
    pub local_rules_dir: Option<std::path::PathBuf>,
}

struct RegistryInner {
    current: Mutex<HashMap<ConversationId, ActiveRun>>,
    pending: Mutex<HashMap<ConversationId, PendingMessages>>,
    subagent_completions: parking_lot::Mutex<HashMap<ConversationId, SubagentCompletions>>,
    changed: Notify,
    pub dependencies: ConversationDependencies,
}

#[derive(Clone)]
struct ActiveRun {
    run_id: RunId,
    handle: RunHandle,
}

impl ConversationRegistry {
    pub fn new(
        store: Store,
        provider: Arc<dyn Provider>,
        compiler: PromptCompiler,
        web_cache: WebCache,
        local_rules_dir: Option<std::path::PathBuf>,
    ) -> Self {
        Self {
            inner: Arc::new(RegistryInner {
                current: Mutex::new(HashMap::new()),
                pending: Mutex::new(HashMap::new()),
                subagent_completions: parking_lot::Mutex::new(HashMap::new()),
                changed: Notify::new(),
                dependencies: ConversationDependencies {
                    store,
                    provider,
                    compiler,
                    web_cache,
                    local_rules_dir,
                },
            }),
        }
    }

    pub(crate) fn dependencies(&self) -> &ConversationDependencies {
        &self.inner.dependencies
    }

    pub(crate) fn subagent_completions(
        &self,
        conversation_id: &ConversationId,
    ) -> SubagentCompletions {
        self.inner
            .subagent_completions
            .lock()
            .entry(conversation_id.clone())
            .or_default()
            .clone()
    }

    pub(crate) fn bind_transport(
        &self,
        handle: TransportHandle,
        receiver: mpsc::Receiver<TransportCommand>,
    ) {
        super::ConversationRuntime::spawn(self.clone(), handle, receiver);
    }

    pub(crate) async fn activate(
        &self,
        conversation_id: ConversationId,
        run_id: RunId,
        handle: RunHandle,
        automatic: bool,
    ) -> crate::Result<bool> {
        let mut current = self.inner.current.lock().await;
        if automatic
            && self
                .inner
                .dependencies
                .store
                .conversation_paused(&conversation_id)
                .await?
        {
            return Ok(false);
        }
        let previous = current.insert(
            conversation_id,
            ActiveRun {
                run_id: run_id.clone(),
                handle,
            },
        );
        if let Some(previous) = previous.filter(|previous| previous.run_id != run_id) {
            previous.handle.cancel();
        }
        Ok(true)
    }

    pub(crate) async fn set_paused(
        &self,
        conversation_id: &ConversationId,
        paused: bool,
    ) -> crate::Result<()> {
        // Serialize pause with automatic activation so a notification cannot
        // acquire ownership just after Stop has cancelled the previous run.
        let current = self.inner.current.lock().await;
        self.inner
            .dependencies
            .store
            .set_conversation_paused(conversation_id, paused)
            .await?;
        if paused {
            if let Some(active) = current.get(conversation_id) {
                active.handle.cancel();
            }
        }
        Ok(())
    }

    pub async fn deliver(
        &self,
        conversation_id: &ConversationId,
        compiled: CompiledMessages,
    ) -> crate::Result<CommandResult> {
        if compiled.delivery == MessageDelivery::Ignore {
            return Ok(CommandResult::Applied);
        }
        let active = self
            .inner
            .current
            .lock()
            .await
            .get(conversation_id)
            .cloned();
        if compiled.delivery == MessageDelivery::InsertMessages
            && self
                .inner
                .dependencies
                .store
                .conversation_paused(conversation_id)
                .await?
        {
            self.inner
                .pending
                .lock()
                .await
                .entry(conversation_id.clone())
                .or_default()
                .push(compiled);
            return Ok(CommandResult::RunEnded);
        }
        let Some(active) = active else {
            self.inner
                .pending
                .lock()
                .await
                .entry(conversation_id.clone())
                .or_default()
                .push(compiled);
            return Ok(CommandResult::RunEnded);
        };
        if compiled
            .target_run_id
            .as_ref()
            .is_some_and(|target| target != &active.run_id)
        {
            return Ok(CommandResult::StaleTarget);
        }
        let pending = compiled.clone();
        let result = match compiled.delivery {
            MessageDelivery::Ignore => CommandResult::Applied,
            MessageDelivery::InsertMessages => {
                active
                    .handle
                    .insert_messages(compiled.event_id, compiled.messages)
                    .await
            }
            MessageDelivery::BreakMessages => {
                active
                    .handle
                    .break_messages(compiled.event_id, compiled.messages)
                    .await
            }
        };
        if matches!(result, CommandResult::RunClosing | CommandResult::RunEnded) {
            self.inner
                .pending
                .lock()
                .await
                .entry(conversation_id.clone())
                .or_default()
                .push(pending);
        }
        Ok(result)
    }

    pub(crate) async fn release(&self, conversation_id: &ConversationId, run_id: &RunId) {
        let mut current = self.inner.current.lock().await;
        if current
            .get(conversation_id)
            .is_some_and(|run| &run.run_id == run_id)
        {
            current.remove(conversation_id);
            self.inner.changed.notify_waiters();
        }
    }

    pub(crate) async fn wait_until_idle(&self, conversation_id: &ConversationId) {
        loop {
            let changed = self.inner.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if !self
                .inner
                .current
                .lock()
                .await
                .contains_key(conversation_id)
            {
                return;
            }
            changed.await;
        }
    }

    pub(crate) async fn take_pending(
        &self,
        conversation_id: &ConversationId,
    ) -> Vec<CompiledMessages> {
        self.inner
            .pending
            .lock()
            .await
            .remove(conversation_id)
            .map(|mut pending| pending.drain().collect())
            .unwrap_or_default()
    }

    pub async fn shutdown(&self) {
        let current = std::mem::take(&mut *self.inner.current.lock().await);
        for active in current.into_values() {
            active.handle.cancel();
        }
    }
}
