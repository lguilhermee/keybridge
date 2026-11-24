//! Serializes write transactions that mutate Conversation state.
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

use tokio::sync::{Mutex, MutexGuard, Notify};

#[derive(Clone, Default)]
pub(crate) struct WriteCoordinator {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    lock: Mutex<()>,
    foreground_waiters: AtomicUsize,
    foreground_ready: Notify,
}

struct ForegroundWaiter<'a>(&'a Inner);

impl Drop for ForegroundWaiter<'_> {
    fn drop(&mut self) {
        self.0.foreground_waiters.fetch_sub(1, Ordering::SeqCst);
        self.0.foreground_ready.notify_waiters();
    }
}

impl WriteCoordinator {
    pub(crate) async fn lock(&self) -> MutexGuard<'_, ()> {
        self.inner.foreground_waiters.fetch_add(1, Ordering::SeqCst);
        let waiter = ForegroundWaiter(&self.inner);
        let guard = self.inner.lock.lock().await;
        drop(waiter);
        guard
    }

    pub(crate) async fn lock_background(&self) -> MutexGuard<'_, ()> {
        loop {
            let ready = self.inner.foreground_ready.notified();
            tokio::pin!(ready);
            ready.as_mut().enable();
            if self.inner.foreground_waiters.load(Ordering::SeqCst) != 0 {
                ready.await;
                continue;
            }
            let guard = self.inner.lock.lock().await;
            if self.inner.foreground_waiters.load(Ordering::SeqCst) == 0 {
                return guard;
            }
            drop(guard);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn foreground_write_passes_queued_background_writes() {
        let writer = WriteCoordinator::default();
        let held = writer.lock().await;
        let (finished, mut arrivals) = tokio::sync::mpsc::unbounded_channel();

        for _ in 0..2 {
            let writer = writer.clone();
            let finished = finished.clone();
            tokio::spawn(async move {
                let _guard = writer.lock_background().await;
                finished.send("background").unwrap();
            });
        }
        tokio::task::yield_now().await;
        let writer_for_foreground = writer.clone();
        tokio::spawn(async move {
            let _guard = writer_for_foreground.lock().await;
            finished.send("foreground").unwrap();
        });
        tokio::task::yield_now().await;
        drop(held);

        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), arrivals.recv())
                .await
                .unwrap(),
            Some("foreground")
        );
        for _ in 0..2 {
            assert_eq!(
                tokio::time::timeout(std::time::Duration::from_secs(1), arrivals.recv())
                    .await
                    .unwrap(),
                Some("background")
            );
        }
    }
}
