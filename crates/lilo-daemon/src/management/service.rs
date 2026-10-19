//! Management use cases, independent of the HTTP transport and mobile page.

use anyhow::{bail, Context};
use lilo_core::plugins::{self, marketplace, ui::FieldKind};
use serde_json::{json, Value};

use super::Operation;
use crate::app::Session;

fn validate_resolved_language(language: Option<String>) -> anyhow::Result<Option<String>> {
    let Some(language) = language else {
        return Ok(None);
    };
    anyhow::ensure!(language.len() <= 128, "Invalid resolved language.");
    let mut parts = language.split('-');
    let primary = parts.next().unwrap_or_default();
    anyhow::ensure!(
        (2..=8).contains(&primary.len()) && primary.bytes().all(|byte| byte.is_ascii_alphabetic()),
        "Invalid resolved language."
    );
    anyhow::ensure!(
        parts.all(|part| {
            (1..=8).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
        }),
        "Invalid resolved language."
    );
    Ok(Some(language))
}

#[cfg(test)]
mod resolved_language_tests {
    use super::validate_resolved_language;

    #[test]
    fn accepts_bounded_bcp47_language_tags() {
        assert_eq!(
            validate_resolved_language(Some("pt-BR".into())).unwrap(),
            Some("pt-BR".into())
        );
        assert_eq!(validate_resolved_language(None).unwrap(), None);
    }

    #[test]
    fn rejects_invalid_or_oversized_language_tags() {
        for invalid in ["", "x", "en--US", "en-🚀", "en_US"] {
            assert!(validate_resolved_language(Some(invalid.into())).is_err());
        }
        assert!(validate_resolved_language(Some(format!("en-{}", "a".repeat(127)))).is_err());
    }
}

pub async fn execute_network(
    controller: std::sync::Arc<crate::network::NetworkController>,
    operation: Operation,
) -> anyhow::Result<Value> {
    let result = tokio::task::spawn_blocking(move || match operation {
        Operation::NetworkStatus {} => {
            serde_json::to_value(controller.status()).map_err(Into::into)
        }
        Operation::NetworkScan {} => serde_json::to_value(controller.scan()?).map_err(Into::into),
        Operation::NetworkJoin { ssid, password } => {
            serde_json::to_value(controller.join(&ssid, &password)?).map_err(Into::into)
        }
        _ => bail!("Not a network operation."),
    })
    .await
    .map_err(|_| anyhow::anyhow!("Wi-Fi operation failed."))??;
    Ok(result)
}

async fn catalog(session: &Session) -> anyhow::Result<(String, plugins::MarketplaceIndex)> {
    let configured = session.settings.get().marketplace_url;
    let local = std::env::var_os("LILO_BUNDLED_MARKETPLACE")
        .map(std::path::PathBuf::from)
        .unwrap_or(std::env::current_dir()?.join("examples/plugins"));
    let source = if (configured.trim().is_empty()
        || configured == lilo_core::settings::REPO_MARKETPLACE_URL)
        && local.join("index.json").is_file()
    {
        local.to_string_lossy().into_owned()
    } else if configured.trim().is_empty() {
        lilo_core::settings::REPO_MARKETPLACE_URL.into()
    } else {
        configured
    };
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let index = marketplace::fetch_index(&http, &source).await?;
    Ok((source, index))
}

fn manageable(session: &Session, id: &str) -> anyhow::Result<()> {
    plugins::store::safe_segment(id)?;
    let manifest = plugins::store::load_manifest_value(&session.data_dir.join("plugins"), id)
        .context("Plugin is not installed or cannot be managed.")?;
    let hosts = manifest.get("hosts").and_then(Value::as_array);
    if !hosts.is_some_and(|hosts| hosts.iter().any(|host| host.as_str() == Some("daemon"))) {
        bail!("Plugin is not compatible with the daemon.");
    }
    Ok(())
}

pub async fn execute(session: &mut Session, operation: Operation) -> anyhow::Result<Value> {
    let root = session.data_dir.join("plugins");
    match operation {
        Operation::NetworkStatus {} | Operation::NetworkScan {} | Operation::NetworkJoin { .. } => {
            bail!("Network management is not initialized.")
        }
        Operation::VoiceStart {
            provider_id,
            email,
            resolved_language,
        } => {
            let resolved_language = validate_resolved_language(resolved_language)?;
            session
                .start_voice(&provider_id, &email, resolved_language)
                .await
        }
        Operation::VoiceStatus {} => Ok(serde_json::to_value(
            session
                .voice
                .as_ref()
                .context("Voice is unavailable.")?
                .status(),
        )?),
        Operation::VoiceStop {} => session.stop_voice().await,
        Operation::VoiceMute { muted } => Ok(serde_json::to_value(
            session
                .voice
                .as_mut()
                .context("Voice is unavailable.")?
                .mute(muted)
                .await?,
        )?),
        Operation::VoiceInterrupt {} => Ok(serde_json::to_value(
            session
                .voice
                .as_mut()
                .context("Voice is unavailable.")?
                .interrupt()
                .await?,
        )?),
        Operation::VoiceText { text } => Ok(serde_json::to_value(
            session
                .voice
                .as_mut()
                .context("Voice is unavailable.")?
                .text(&text)
                .await?,
        )?),
        Operation::SetDevicePreferences { preferences } => {
            session.set_device_preferences(preferences)?;
            Ok(json!({"ok": true}))
        }
        Operation::Browser { payload } => {
            session.wake.pause_for_login();
            let login = session
                .browser_login
                .as_mut()
                .context("Provider login is unavailable on this daemon.")?;
            login
                .exchange(payload, &session.accounts, &session.data_dir)
                .await
        }
        Operation::State {} => Ok(session.management_state().await),
        Operation::Settings {} => {
            let mut settings = lilo_core::settings::Settings::default();
            settings.provider_id = session.settings.get().provider_id;
            settings.marketplace_url = session.settings.get().marketplace_url;
            settings.media = session.settings.get().media;
            settings.default_voice = session.settings.get().default_voice;
            settings.voice_mode = session.settings.get().voice_mode;
            Ok(serde_json::to_value(settings)?)
        }
        Operation::SetPreferences {
            provider_id,
            marketplace_url,
            media,
            default_voice,
            voice_mode,
        } => {
            if marketplace_url.len() > 2048
                || (!marketplace_url.is_empty() && !marketplace_url.starts_with("https://"))
            {
                bail!("Marketplace must use HTTPS.");
            }
            if media.backend != "mpv"
                || !["auto", "yt-dlp", "http"].contains(&media.resolver.as_str())
                || media.volume > 100
                || media.duck_percent > 100
                || !["high", "low"].contains(&media.audio_quality.as_str())
                || media.mpv_path.len() > 4096
                || media.yt_dlp_path.len() > 4096
                || media.http_resolver_url.len() > 2048
                || !media.http_resolver_url.starts_with("https://")
            {
                bail!("Invalid media settings.");
            }
            if default_voice.trim().is_empty()
                || default_voice.len() > 64
                || default_voice.chars().any(char::is_control)
                || !["standard", "advanced", "wingman"].contains(&voice_mode.as_str())
            {
                bail!("Invalid voice preferences.");
            }
            let mut settings = session.settings.get();
            if let Some(provider) = provider_id {
                if provider != settings.provider_id
                    && !session
                        .voice
                        .as_ref()
                        .is_some_and(|voice| voice.providers().contains(&provider))
                {
                    bail!("Selected voice provider is unavailable on this daemon.");
                }
                settings.provider_id = provider;
            }
            settings.marketplace_url = marketplace_url;
            settings.media = media.clone();
            settings.default_voice = default_voice;
            settings.voice_mode = voice_mode;
            session.settings.set(settings)?;
            if let Some(provider) = session.plugin_provider("core.media").await {
                provider.configure(serde_json::to_value(media)?).await?;
            }
            Ok(json!({"ok": true}))
        }
        Operation::SetMarketplace { url } => {
            if url.len() > 2048 || (!url.is_empty() && !url.starts_with("https://")) {
                bail!("Marketplace must use HTTPS.");
            }
            let mut settings = session.settings.get();
            settings.marketplace_url = url;
            session.settings.set(settings)?;
            Ok(json!({"ok": true}))
        }
        Operation::Catalog {} => {
            let (_, index) = catalog(session).await?;
            Ok(json!(marketplace::annotate_for_host(
                index, &root, "daemon"
            )))
        }
        Operation::Plugin { id } => {
            let provider = session
                .plugin_provider(&id)
                .await
                .context("Plugin is not running.")?;
            let ui = provider.ui();
            let mut settings = plugins::store::load(&root, &id);
            // Secret controls are write-only. A blank value preserves the saved secret.
            if let Some(object) = settings.as_object_mut() {
                for field in &ui.settings {
                    if field.kind == FieldKind::Password {
                        object.remove(&field.key);
                    }
                }
            }
            Ok(json!({"ui": ui, "settings": settings}))
        }
        Operation::Install { id } => {
            plugins::store::safe_segment(&id)?;
            if session.plugin_provider(&id).await.is_some() {
                manageable(session, &id)?;
            }
            let (source, index) = catalog(session).await?;
            let entry = index
                .plugins
                .iter()
                .find(|entry| entry.id == id)
                .context("Plugin is not in the configured marketplace.")?;
            if !entry.supports_host("daemon") {
                bail!("Plugin is not compatible with the daemon.");
            }
            session.stop_plugin(&id).await;
            let http = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()?;
            let installed = marketplace::install(&http, &source, entry, &root).await;
            let loaded = session.reload_plugin(&id).await;
            installed?;
            loaded?;
            Ok(json!({"ok": true}))
        }
        Operation::Enable { id, enabled } => {
            manageable(session, &id)?;
            plugins::store::set_enabled(&root, &id, enabled)?;
            session.reload_plugin(&id).await?;
            Ok(json!({"ok": true}))
        }
        Operation::Remove { id } => {
            manageable(session, &id)?;
            session.stop_plugin(&id).await;
            if let Err(error) = marketplace::uninstall(&root, &id) {
                let _ = session.reload_plugin(&id).await;
                return Err(error.into());
            }
            Ok(json!({"ok": true}))
        }
        Operation::Configure { id, settings } => {
            let provider = session
                .plugin_provider(&id)
                .await
                .context("Plugin is not running.")?;
            let ui = provider.ui();
            let incoming = settings
                .as_object()
                .context("Settings must be an object.")?;
            let mut next = plugins::store::load(&root, &id)
                .as_object()
                .cloned()
                .unwrap_or_default();
            for (key, value) in incoming {
                let field = ui
                    .settings
                    .iter()
                    .find(|field| &field.key == key)
                    .context("Unknown plugin setting.")?;
                let valid = match field.kind {
                    FieldKind::Text | FieldKind::Password => {
                        value.as_str().is_some_and(|text| text.len() <= 8192)
                    }
                    FieldKind::Switch => value.is_boolean(),
                    FieldKind::Select => value.as_str().is_some_and(|text| {
                        field.options.iter().any(|option| option.value == text)
                    }),
                    FieldKind::Range => value.as_i64().is_some_and(|number| {
                        field.min.map_or(true, |min| number >= min)
                            && field.max.map_or(true, |max| number <= max)
                    }),
                };
                if !valid {
                    bail!("Invalid plugin setting.");
                }
                if field.kind == FieldKind::Password && value.as_str() == Some("") {
                    continue;
                }
                if field.kind == FieldKind::Password {
                    bail!("Secret settings require an encrypted management transport.");
                }
                next.insert(key.clone(), value.clone());
            }
            let next = Value::Object(next);
            provider.configure(next.clone()).await?;
            plugins::store::save(&root, &id, &next)?;
            Ok(json!({"ok": true}))
        }
        Operation::Invoke { id, tool, args } => {
            let provider = session
                .plugin_provider(&id)
                .await
                .context("Plugin is not running.")?;
            if !provider.handles(&tool) {
                bail!("Tool does not belong to this plugin.");
            }
            let result = provider.invoke(&tool, &args).await?;
            if plugins::result_ends_session(&result)
                && session.voice.as_ref().is_some_and(|voice| {
                    matches!(
                        voice.status().state,
                        crate::voice::VoiceState::Starting | crate::voice::VoiceState::Connected
                    )
                })
            {
                session.stop_voice().await?;
            }
            if result.get("context").and_then(Value::as_str).is_some() {
                if let Some(voice) = session.voice.as_mut() {
                    if voice.status().state == crate::voice::VoiceState::Connected {
                        let summary = result
                            .get("summary")
                            .and_then(Value::as_str)
                            .unwrap_or("Plugin action completed.");
                        voice
                            .context(&lilo_core::commands::manifest::hidden_note_with_context(
                                summary, &result,
                            ))
                            .await?;
                    }
                }
            }
            Ok(result)
        }
        Operation::RemoveAccount { provider, email } => {
            if session.voice.as_ref().is_some_and(|voice| {
                voice.status().provider_id.as_deref() == Some(provider.as_str())
            }) {
                session.stop_voice().await?;
            }
            if let Some(login) = session.browser_login.as_mut() {
                login.forget(&provider, &email).await?;
            }
            session.accounts.remove(&provider, &email)?;
            Ok(json!({"ok": true}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use std::path::Path;

    #[tokio::test]
    async fn mobile_preferences_persist_without_overwriting_private_gateway_settings() {
        let root = std::env::temp_dir().join(format!("lilo-preferences-{}", uuid::Uuid::new_v4()));
        let mut session = Session::start(&Config::default(), &root).await.unwrap();
        let mut settings = session.settings.get();
        settings.gateway_auth_key = "private-gateway-value".into();
        settings.provider_id = "saved-provider".into();
        session.settings.set(settings).unwrap();
        let mut media = lilo_core::settings::MediaSettings::default();
        media.volume = 42;
        execute(
            &mut session,
            Operation::SetPreferences {
                provider_id: Some("saved-provider".into()),
                marketplace_url: String::new(),
                media: media.clone(),
                default_voice: "cove".into(),
                voice_mode: "standard".into(),
            },
        )
        .await
        .unwrap();
        let public = execute(&mut session, Operation::Settings {}).await.unwrap();
        assert_eq!(public["providerId"], "saved-provider");
        assert_eq!(public["media"]["volume"], 42);
        assert_eq!(public["voiceMode"], "standard");
        assert!(!public.to_string().contains("private-gateway-value"));
        assert_eq!(
            session.settings.get().gateway_auth_key,
            "private-gateway-value"
        );
        media.volume = 101;
        assert!(execute(
            &mut session,
            Operation::SetPreferences {
                provider_id: None,
                marketplace_url: String::new(),
                media,
                default_voice: "cove".into(),
                voice_mode: "standard".into()
            }
        )
        .await
        .is_err());
        assert_eq!(session.settings.get().media.volume, 42);
        let saved_media = session.settings.get().media;
        assert!(execute(
            &mut session,
            Operation::SetPreferences {
                provider_id: Some("unavailable-provider".into()),
                marketplace_url: String::new(),
                media: saved_media,
                default_voice: "cove".into(),
                voice_mode: "standard".into(),
            }
        )
        .await
        .is_err());
        assert_eq!(session.settings.get().provider_id, "saved-provider");
        session.shutdown().await;
        drop(session);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn installed_plugin_is_live_and_its_data_survives_disable_and_restart() {
        let root = std::env::temp_dir().join(format!("lilo-mobile-{}", uuid::Uuid::new_v4()));
        let config = Config::default();
        let mut session = Session::start(&config, &root).await.unwrap();
        let mut settings = session.settings.get();
        settings.marketplace_url = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/plugins")
            .to_string_lossy()
            .into_owned();
        settings.gateway_auth_key = "private-gateway-value".into();
        session.settings.set(settings).unwrap();
        let mut account = lilo_core::accounts::Account::chatgpt(
            "fixture.invalid",
            "Fixture",
            "private-account-value",
        );
        account.proxy = "private-proxy-value".into();
        account.session_cookie = "private-cookie-value".into();
        session.accounts.add(account).unwrap();
        let public = execute(&mut session, Operation::State {})
            .await
            .unwrap()
            .to_string();
        for secret in [
            "private-account-value",
            "private-proxy-value",
            "private-cookie-value",
        ] {
            assert!(!public.contains(secret));
        }
        assert!(!execute(&mut session, Operation::Settings {})
            .await
            .unwrap()
            .to_string()
            .contains("private-gateway-value"));
        let id = "com.lilo.notes".to_string();
        execute(&mut session, Operation::Install { id: id.clone() })
            .await
            .unwrap();
        execute(
            &mut session,
            Operation::Invoke {
                id: id.clone(),
                tool: "notes_add".into(),
                args: json!({"text":"Persistent mobile note"}),
            },
        )
        .await
        .unwrap();
        assert!(execute(
            &mut session,
            Operation::Invoke {
                id: id.clone(),
                tool: "get_current_time".into(),
                args: json!({})
            }
        )
        .await
        .is_err());
        execute(
            &mut session,
            Operation::Enable {
                id: id.clone(),
                enabled: false,
            },
        )
        .await
        .unwrap();
        assert!(session.plugin_provider(&id).await.is_none());
        session.shutdown().await;
        drop(session);
        let mut session = Session::start(&config, &root).await.unwrap();
        assert!(session.plugin_provider(&id).await.is_none());
        execute(
            &mut session,
            Operation::Enable {
                id: id.clone(),
                enabled: true,
            },
        )
        .await
        .unwrap();
        let notes = execute(
            &mut session,
            Operation::Invoke {
                id: id.clone(),
                tool: "notes_list".into(),
                args: json!({}),
            },
        )
        .await
        .unwrap();
        assert!(notes.to_string().contains("Persistent mobile note"));
        execute(
            &mut session,
            Operation::Enable {
                id: id.clone(),
                enabled: false,
            },
        )
        .await
        .unwrap();
        std::fs::write(
            root.join("plugins").join(&id).join("notes.js"),
            "invalid JavaScript {",
        )
        .unwrap();
        assert!(execute(
            &mut session,
            Operation::Enable {
                id: id.clone(),
                enabled: true
            },
        )
        .await
        .is_err());
        assert!(session.plugin_provider(&id).await.is_none());
        execute(&mut session, Operation::Remove { id: id.clone() })
            .await
            .unwrap();
        assert!(!root.join("plugins").join(&id).exists());
        let time = session.route("what time is it", "after-removal").await;
        assert_eq!(time.len(), 1);
        assert!(time[0].error.is_none());
        session.shutdown().await;
        drop(session);
        std::fs::remove_dir_all(root).unwrap();
    }
}
