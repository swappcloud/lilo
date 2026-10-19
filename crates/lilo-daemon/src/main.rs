//! LILO with no window.
//!
//! One process, a TOML file and the same `lilo-core` the desktop app runs: the
//! command router, the tools and the plugins, with no WebView and no UI. The
//! plan is `docs/command-protocol.md` §9; the audio pipeline (wake word, STT)
//! is the next milestone, so today the transcriptions come from stdin.
//!
//! ```text
//! lilo-daemon [--config PATH] [--data-dir PATH] [--check] [--once TEXT]
//! ```

mod app;
mod broker;
mod browser_login;
mod config;
mod device;
mod interactions;
mod log;
mod management;
mod network;
mod satellite;
mod setup;
mod voice;
mod wake;
mod wifi;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use lilo_core::accounts::AccountStore;
use tokio::io::AsyncBufReadExt;

use app::{Session, TICK_MS};
use config::Config;
use wifi::Wifi;

/// Where a config lives when `--config` is not given: the system path when a
/// packager put one there, else the app's data directory for this user, beside
/// `settings.json` and `accounts.json`.
fn default_config_path() -> PathBuf {
    let system = PathBuf::from("/etc/lilo/lilo.toml");
    if system.exists() {
        return system;
    }
    match Config::default().data_dir() {
        Ok(dir) => dir.join("lilo.toml"),
        Err(_) => PathBuf::from("lilo.toml"),
    }
}

struct Args {
    login_browser: Option<String>,
    login_browser_token_file: Option<PathBuf>,
    manage: Option<std::net::SocketAddr>,
    manage_web: PathBuf,
    manage_pair_file: Option<PathBuf>,
    config: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    check: bool,
    once: Option<String>,
    setup: bool,
    /// Satellite client mode: `host:port` of a paired desktop.
    satellite: Option<String>,
    satellite_key: Option<String>,
    phrase: Option<PathBuf>,
    answer: Option<PathBuf>,
}

fn usage() -> &'static str {
    "usage: lilo-daemon [--config PATH] [--data-dir PATH] [--check] [--once TEXT]
                    [--setup] [--manage IP:PORT] [--manage-web PATH]

  --manage IP:PORT start the phone management API (explicit opt-in)
  --manage-web PATH built shared React frontend (default .tmp/daemon-web)
  --login-browser URL optional private browser host for phone provider login
  --login-browser-token-file PATH private browser host authorization file

  --config PATH    lilo.toml to read (default: /etc/lilo/lilo.toml when it
                   exists, else <data dir>/lilo.toml; a missing default file
                   means defaults, a missing --config is an error)
  --data-dir PATH  override where settings.json, accounts.json and plugins live
  --check          load everything, print the report and exit
  --once TEXT      route one transcription, run its tool, print the result and
                   exit (0 = ran, 2 = nothing matched, 3 = the tool failed)
  --setup          open the setup window (phone picks the WiFi, pastes the
                   account) even if this machine looks configured
  --satellite H:P  run the satellite client against a paired desktop at H:P
                   instead of serving: sends --phrase, presses the button and
                   writes what the assistant says to --answer
  --satellite-key  the pairing key the desktop printed (required with
                   --satellite)
  --phrase WAV     16 kHz mono PCM16 phrase to send (required with --satellite)
  --answer WAV     where to write the assistant's audio (default answer.wav)

A fresh box with no network and no account opens the setup window by itself:
its own open access point, a page and the captive-portal DNS that makes a phone
show it. Without --check or --once the daemon then serves: it reads
transcriptions from stdin until stdin closes, and keeps running (ticking the
router) until SIGTERM."
}

fn parse_args() -> anyhow::Result<Args> {
    let mut args = Args {
        login_browser: None,
        login_browser_token_file: None,
        manage: None,
        manage_web: PathBuf::from(".tmp/daemon-web"),
        manage_pair_file: None,
        config: None,
        data_dir: None,
        check: false,
        once: None,
        setup: false,
        satellite: None,
        satellite_key: None,
        phrase: None,
        answer: None,
    };
    let mut argv = std::env::args().skip(1);
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--login-browser" => {
                args.login_browser = Some(argv.next().context("--login-browser needs a URL")?)
            }
            "--manage-pair-file" => {
                args.manage_pair_file = Some(PathBuf::from(
                    argv.next().context("--manage-pair-file needs a path")?,
                ))
            }
            "--login-browser-token-file" => {
                args.login_browser_token_file = Some(PathBuf::from(
                    argv.next()
                        .context("--login-browser-token-file needs a path")?,
                ))
            }
            "--manage" => {
                args.manage = Some(argv.next().context("--manage needs IP:PORT")?.parse()?)
            }
            "--manage-web" => {
                args.manage_web = PathBuf::from(argv.next().context("--manage-web needs a path")?)
            }
            "--config" => {
                args.config = Some(PathBuf::from(argv.next().context("--config needs a path")?));
            }
            "--data-dir" => {
                args.data_dir = Some(PathBuf::from(
                    argv.next().context("--data-dir needs a path")?,
                ));
            }
            "--check" => args.check = true,
            "--setup" => args.setup = true,
            "--satellite" => {
                args.satellite = Some(argv.next().context("--satellite needs host:port")?);
            }
            "--satellite-key" => {
                args.satellite_key = Some(argv.next().context("--satellite-key needs a key")?);
            }
            "--phrase" => {
                args.phrase = Some(PathBuf::from(argv.next().context("--phrase needs a path")?));
            }
            "--answer" => {
                args.answer = Some(PathBuf::from(argv.next().context("--answer needs a path")?));
            }
            "--once" => args.once = Some(argv.next().context("--once needs a text")?),
            "--help" | "-h" => {
                println!("{}", usage());
                std::process::exit(0);
            }
            other => anyhow::bail!("unknown argument {other}\n\n{}", usage()),
        }
    }
    Ok(args)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = parse_args()?;

    // The satellite client is a different program shape: no stores, no
    // plugins, one conversation with a paired desktop.
    if let Some(addr) = &args.satellite {
        let key = args
            .satellite_key
            .clone()
            .context("--satellite-key is required with --satellite")?;
        let phrase = args
            .phrase
            .clone()
            .context("--phrase is required with --satellite")?;
        let answer = args
            .answer
            .clone()
            .unwrap_or_else(|| PathBuf::from("answer.wav"));
        satellite::Client {
            addr: addr.clone(),
            key,
            phrase,
            answer,
        }
        .run()
        .await?;
        return Ok(());
    }

    let (config, source) = match &args.config {
        Some(path) => (Config::read(path)?, path.display().to_string()),
        None => {
            let path = default_config_path();
            let exists = path.exists();
            let config = Config::read_or_default(&path)?;
            let source = if exists {
                path.display().to_string()
            } else {
                format!("{} (not found; using defaults)", path.display())
            };
            (config, source)
        }
    };
    let data_dir = match &args.data_dir {
        Some(dir) => dir.clone(),
        None => config.data_dir()?,
    };

    // A fresh box has neither a network nor an account: it cannot be talked
    // to until a phone configures it. A machine with no WiFi backend (the
    // developer's Mac, Windows) never opens the window by itself. A box that is
    // already online (Ethernet, a joined Wi-Fi) or has no radio at all is on a
    // network it can use, so it does not wait for a join; and a recorded
    // completion keeps the window shut on a reboot even when the network is
    // momentarily down.
    let accounts = AccountStore::load(data_dir.join("accounts.json"));
    let wifi: Arc<dyn Wifi> = wifi::backend(&config.setup.wifi);
    let wifi_backend = wifi.available();
    let account_present = !accounts.list().is_empty();
    let configured = account_present && setup::network_ok(&*wifi);
    let complete = account_present && setup::Completion::new(&data_dir).is_complete();
    let setup_needed = setup::setup_needed(args.setup, wifi_backend, configured, complete);

    if args.check {
        let session = Session::start(&config, &data_dir).await?;
        log::info(format!("LILO daemon v{}", env!("CARGO_PKG_VERSION")));
        log::info(format!("config:  {source}"));
        for line in session.report() {
            log::info(line);
        }
        log::info(format!(
            "setup:   {}",
            if setup_needed {
                "needed (no network and/or no account)"
            } else {
                "not needed"
            }
        ));
        session.shutdown().await;
        return Ok(());
    }

    if setup_needed && args.manage.is_none() {
        log::info("setup window: the phone is the UI from here");
        let settings = config.setup.clone();
        let user_agent = lilo_core::settings::SettingsStore::load(data_dir.join("settings.json"))
            .get()
            .user_agent;
        let http = reqwest::Client::builder()
            .user_agent(user_agent.clone())
            .build()
            .context("could not build the HTTP client")?;
        tokio::select! {
            result = setup::run(
                settings,
                wifi.clone(),
                accounts,
                http,
                user_agent,
                setup::Completion::new(&data_dir),
            ) => result?,
            _ = shutdown_signal() => {
                log::info("setup cancelled");
                return Ok(());
            }
        }
    }

    let mut session = Session::start(&config, &data_dir).await?;
    log::info(format!("LILO daemon v{}", env!("CARGO_PKG_VERSION")));
    log::info(format!("config:  {source}"));
    for line in session.report() {
        log::info(line);
    }

    if let Some(text) = args.once {
        let routed = session_once(session, &text).await;
        std::process::exit(routed);
    }

    let management = match args.manage {
        Some(address) => {
            let server = match args.manage_pair_file.as_deref() {
                Some(file) => management::ManagementServer::start_with_pairing(
                    address,
                    &data_dir,
                    &args.manage_web,
                    Some(file),
                )?,
                None => management::ManagementServer::start(address, &data_dir, &args.manage_web)?,
            };
            log::info(format!("phone management listening on {}", server.address));
            log::info(format!(
                "private pairing link saved to {}",
                server.access_file.display()
            ));
            Some(server)
        }
        None => None,
    };
    if let Some(endpoint) = args.login_browser.as_ref() {
        let server = management
            .as_ref()
            .context("--login-browser requires --manage")?;
        let token_file = args
            .login_browser_token_file
            .as_ref()
            .context("--login-browser requires --login-browser-token-file")?;
        let login =
            browser_login::BrowserLogin::connect(endpoint, token_file, &server.login_key).await?;
        let capabilities = login.broker.get("/capabilities").await?;
        let providers = capabilities
            .get("voiceProviders")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
            .map(str::to_owned)
            .collect();
        session.voice = Some(voice::VoiceSession::new(login.broker.clone(), providers));
        session.browser_login = Some(login);
    }
    let network = Arc::new(network::NetworkController::new(wifi));
    serve(session, management, network).await;
    Ok(())
}

/// One transcription, out and back, with a shell-friendly exit code.
async fn session_once(mut session: Session, text: &str) -> i32 {
    let routed = session.route(text, "once").await;
    let mut code = 2;
    for entry in &routed {
        log_routed(entry);
        if entry.error.is_some() {
            code = 3;
        } else if code == 2 {
            code = 0;
        }
    }
    if routed.is_empty() {
        log::info(format!("no command matches \"{text}\""));
    }
    session.shutdown().await;
    code
}

/// The loop: transcriptions in, results out, the router ticked on its own
/// clock, and a clean stop on SIGTERM (systemd) or Ctrl-C.
async fn serve(
    mut session: Session,
    mut management: Option<management::ManagementServer>,
    network: Arc<network::NetworkController>,
) {
    log::info("ready for managed voice sessions and stdin commands");
    let mut stdin_open = true;
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut ticker = tokio::time::interval(Duration::from_millis(TICK_MS));
    let mut turn = 0u64;

    loop {
        tokio::select! {
            request = async {
                match management.as_mut() {
                    Some(server) => server.receive().await,
                    None => std::future::pending().await,
                }
            } => {
                if let Some(request) = request {
                    let result = execute_management_request(
                        &mut session,
                        network.clone(),
                        request.operation,
                    )
                    .await;
                    let _ = request.reply.send(result);
                } else {
                    management = None;
                }
            }
            _ = shutdown_signal() => {
                log::info("stopping");
                break;
            }
            _ = ticker.tick() => {
                session.poll_voice().await;
                session.poll_wake().await;
                for entry in session.tick().await {
                    log_routed(&entry);
                }
            }
            line = lines.next_line(), if stdin_open => {
                match line {
                    Ok(Some(text)) => {
                        let text = text.trim().to_string();
                        if text.is_empty() {
                            continue;
                        }
                        turn += 1;
                        log::info(format!("heard: {text}"));
                        let routed = session.route(&text, &format!("turn-{turn}")).await;
                        if routed.is_empty() {
                            log::info("no command matches");
                        }
                        for entry in routed {
                            log_routed(&entry);
                        }
                    }
                    Ok(None) => {
                        stdin_open = false;
                        log::info("stdin closed; managed voice and wake listening remain available");
                    }
                    Err(error) => {
                        stdin_open = false;
                        log::warn(format!("stdin failed: {error}"));
                    }
                }
            }
        }
    }

    session.shutdown().await;
}

async fn execute_management_request(
    session: &mut Session,
    network: Arc<network::NetworkController>,
    operation: management::Operation,
) -> Result<serde_json::Value, String> {
    match operation {
        operation @ (management::Operation::NetworkStatus {}
        | management::Operation::NetworkScan {}
        | management::Operation::NetworkJoin { .. }) => {
            management::execute_network(network, operation)
                .await
                .map_err(|_| "Management operation failed.".to_string())
        }
        operation => management::execute(session, operation)
            .await
            .map_err(|_| "Management operation failed.".to_string()),
    }
}

/// One routed command, one log line. The tool name is kept: over ssh on a
/// board, "which tool ran" is the first question a failure raises.
fn log_routed(entry: &app::Routed) {
    let label = match &entry.tool {
        Some(tool) => format!("{} ({tool})", entry.command),
        None => entry.command.clone(),
    };
    match (&entry.summary, &entry.error) {
        (Some(summary), _) => log::info(format!("{label} -> {summary}")),
        (None, Some(error)) => log::warn(format!("{label} -> {error}")),
        (None, None) => log::info(label),
    }
}

/// SIGTERM (what systemd sends) or Ctrl-C, on every platform.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("a SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn management_loop_dispatches_network_operations_to_the_wifi_controller() {
        let data_dir =
            std::env::temp_dir().join(format!("lilo-daemon-network-{}", uuid::Uuid::new_v4()));
        let mut session = Session::start(&Config::default(), &data_dir).await.unwrap();
        let wifi: Arc<dyn Wifi> = Arc::new(wifi::Fake::new());
        let network = Arc::new(network::NetworkController::new(wifi));

        let scan = execute_management_request(
            &mut session,
            network.clone(),
            management::Operation::NetworkScan {},
        )
        .await
        .unwrap();
        assert_eq!(scan["networks"][0]["ssid"], "casa");

        let joined = execute_management_request(
            &mut session,
            network,
            management::Operation::NetworkJoin {
                ssid: "casa".into(),
                password: "secret-pass".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(joined["currentSsid"], "casa");

        session.shutdown().await;
        let _ = std::fs::remove_dir_all(data_dir);
    }
}
