//! Daemon adapter for the shared media service.
//!
//! Playback and binary provisioning stay in `lilo-core`; this host wrapper
//! gives the service the provider lifecycle expected by the daemon registry.

use std::sync::Arc;

use lilo_core::error::Result;
use lilo_core::media::service::MediaService;
use lilo_core::plugins::{BoxFuture, PluginManifest, ToolProvider};
use lilo_core::tools::ToolDescriptor;
use serde_json::Value;

pub struct DaemonMediaProvider {
    service: Arc<MediaService>,
    watcher: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    provisioned: tokio::sync::Mutex<bool>,
}

impl DaemonMediaProvider {
    pub fn new(service: Arc<MediaService>) -> Self {
        Self {
            service,
            watcher: std::sync::Mutex::new(None),
            provisioned: tokio::sync::Mutex::new(false),
        }
    }
}

impl ToolProvider for DaemonMediaProvider {
    fn manifest(&self) -> &PluginManifest {
        self.service.manifest()
    }

    fn descriptors(&self) -> Vec<ToolDescriptor> {
        self.service.descriptors()
    }

    fn handles(&self, tool: &str) -> bool {
        self.service.handles(tool)
    }

    fn invoke<'a>(&'a self, tool: &'a str, args: &'a Value) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            if matches!(tool, "media_play" | "media_radio" | "media_search") {
                let mut provisioned = self.provisioned.lock().await;
                if !*provisioned {
                    self.service.install_dependencies().await?;
                    *provisioned = true;
                }
            }
            self.service.invoke(tool, args).await
        })
    }

    fn set_publisher(&self, publisher: lilo_core::plugins::bus::Publisher) {
        self.service.set_publisher(publisher);
    }

    fn start<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let mut watcher = self.watcher.lock().expect("media watcher poisoned");
            if watcher.is_none() {
                let service = self.service.clone();
                *watcher = Some(tokio::spawn(async move {
                    service.start().await;
                }));
            }
        })
    }

    fn configure<'a>(&'a self, settings: Value) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.service
                .apply_settings(serde_json::from_value(settings)?)
                .await?;
            Ok(())
        })
    }

    fn shutdown<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            self.service.stop_playback();
            let watcher = self.watcher.lock().expect("media watcher poisoned").take();
            if let Some(watcher) = watcher {
                watcher.abort();
                let _ = watcher.await;
            }
        })
    }
}

impl Drop for DaemonMediaProvider {
    fn drop(&mut self) {
        if let Ok(watcher) = self.watcher.get_mut() {
            if let Some(watcher) = watcher.take() {
                watcher.abort();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lilo_core::plugins::ToolProvider;
    use lilo_core::settings::MediaSettings;

    #[tokio::test]
    async fn adapter_exposes_media_tools_and_status_without_playback_dependencies() {
        let data_dir =
            std::env::temp_dir().join(format!("lilo-daemon-media-{}", uuid::Uuid::new_v4()));
        let service = Arc::new(MediaService::new(
            MediaSettings::default(),
            reqwest::Client::new(),
            data_dir.clone(),
        ));
        let provider = DaemonMediaProvider::new(service);

        assert!(provider.handles("media_play"));
        assert!(provider
            .descriptors()
            .iter()
            .any(|tool| tool.name == "media_play"));
        let status = provider
            .invoke("media_status", &serde_json::json!({}))
            .await
            .unwrap();
        assert!(status.get("playerFound").is_some());

        provider.shutdown().await;
        let _ = std::fs::remove_dir_all(data_dir);
    }
}
