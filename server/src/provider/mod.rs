//! Owns filesystem provider discovery, sandboxed workers, and provider channels.
mod asset;
mod builtin;
mod catalog;
mod data;
mod definition;
mod descriptor;
mod installation;
mod manifest;
mod oauth_callback;
mod protocol;
mod registry;
mod runtime;
mod state;
mod wire;
mod worker;

pub use descriptor::{
    parse_model_id, ChannelDescriptor, ProviderDescriptor, ProviderModelDescriptor,
    ProviderResourceDescriptor, ProviderResourceView, ADAPTER_ID_PREFIX,
};
pub use registry::{ImportResponse, OAuthBeginResponse, OAuthPollResponse, ProviderRegistry};
pub use runtime::{
    ProviderRuntime, ProviderRuntimePhase, ProviderRuntimeState, ProviderRuntimeStatus,
};

/// Prevents the Deno child process from popping a console window on Windows (CREATE_NO_WINDOW).
#[cfg(windows)]
fn detach_console(command: &mut tokio::process::Command) {
    command.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn detach_console(_command: &mut tokio::process::Command) {}
