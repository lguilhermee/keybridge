//! Normalizes provider-specific responses.
use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use crate::model::{normalize_provider_tool_call_ids, ModelInvocation};

use super::{Protocol, ProtocolStream};

pub(super) struct NormalizedProtocol {
    inner: Arc<dyn Protocol>,
}

impl NormalizedProtocol {
    pub(super) fn new(inner: Arc<dyn Protocol>) -> Self {
        Self { inner }
    }
}

impl Protocol for NormalizedProtocol {
    fn stream(
        &self,
        mut invocation: ModelInvocation,
        cancellation: CancellationToken,
    ) -> ProtocolStream {
        normalize_provider_tool_call_ids(&mut invocation.request.history);
        self.inner.stream(invocation, cancellation)
    }
}
