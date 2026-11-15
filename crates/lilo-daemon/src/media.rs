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
    provisioned: Arc<tokio::sync::Mutex<bool>>,
}

impl DaemonMediaProvider {
    pub fn new(service: Arc<MediaService>) -> Self {
        Self {
            service,
            watcher: std::sync::Mutex::new(None),
            provisioned: Arc::new(tokio::sync::Mutex::new(false)),
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
                if let Ok(mut provisioned) = self.provisioned.try_lock() {
                    if !*provisioned {
                        if self.service.install_dependencies().await.is_err() {
                            crate::log::warn(
                                "Media tool update failed; continuing with available tools.",
                            );
                        }
                        // Retry on the next daemon launch or explicit install,
                        // rather than blocking every command on the same download.
                        *provisioned = true;
                    }
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
                let provisioned = self.provisioned.clone();
                *watcher = Some(tokio::spawn(async move {
                    let updating = async {
                        let mut ready = provisioned.lock().await;
                        if !*ready {
                            if service.install_dependencies().await.is_err() {
                                crate::log::warn(
                                    "Media tool update failed; continuing with available tools.",
                                );
                            }
                            *ready = true;
                        }
                    };
                    // Status and playback observation continue while an
                    // optional download is waiting on the network.
                    tokio::join!(updating, service.start());
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
    async fn failed_tool_updates_do_not_block_media_dispatch_or_repeat_every_command() {
        let data =
            std::env::temp_dir().join(format!("lilo-daemon-update-{}", uuid::Uuid::new_v4()));
        let previous = lilo_core::media::provision::managed_path(&data, "yt-dlp");
        std::fs::create_dir_all(previous.parent().unwrap()).unwrap();
        std::fs::write(&previous, b"previous tool").unwrap();
        let http = lilo_core::http::builder()
            .proxy(reqwest::Proxy::all("http://127.0.0.1:1").unwrap())
            .build()
            .unwrap();
        let provider = DaemonMediaProvider::new(Arc::new(MediaService::new(
            MediaSettings::default(),
            http,
            data.clone(),
        )));
        for _ in 0..2 {
            let error = provider
                .invoke("media_search", &serde_json::json!({}))
                .await
                .unwrap_err();
            assert!(
                error.to_string().contains("nothing to search for"),
                "{error}"
            );
            assert!(*provider.provisioned.lock().await);
            assert_eq!(std::fs::read(&previous).unwrap(), b"previous tool");
        }
        std::fs::remove_dir_all(data).unwrap();
    }

    #[tokio::test]
    async fn an_upgrade_in_progress_does_not_delay_media_dispatch() {
        let data =
            std::env::temp_dir().join(format!("lilo-daemon-updating-{}", uuid::Uuid::new_v4()));
        let provider = DaemonMediaProvider::new(Arc::new(MediaService::new(
            MediaSettings::default(),
            lilo_core::http::client(),
            data,
        )));
        let _updating = provider.provisioned.lock().await;
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            provider.invoke("media_search", &serde_json::json!({})),
        )
        .await
        .expect("media dispatch must not wait for the update")
        .unwrap_err();
        assert!(error.to_string().contains("nothing to search for"));
    }

    #[tokio::test]
    async fn adapter_exposes_media_tools_and_status_without_playback_dependencies() {
        let data_dir =
            std::env::temp_dir().join(format!("lilo-daemon-media-{}", uuid::Uuid::new_v4()));
        let service = Arc::new(MediaService::new(
            MediaSettings::default(),
            lilo_core::http::client(),
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
