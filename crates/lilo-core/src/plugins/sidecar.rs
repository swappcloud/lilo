//! A plugin that runs as its own process and talks line-delimited JSON.
//!
//! Sidecar rather than a shared library, for the reasons the rest of the app
//! already follows (mpv, the wake helper, the phone-login server):
//!   * isolation — a plugin that panics or segfaults cannot take LILO with it;
//!   * any language — the contract is JSON on stdio, not a Rust ABI;
//!   * the Pi budget — no WASM runtime to carry when no plugin is loaded.
//!
//! Protocol, one JSON object per line:
//!
//! ```text
//! host → plugin  {"id":1,"method":"describe","params":null}
//! plugin → host  {"id":1,"ok":true,"result":{"tools":[…],"commands":[…]}}
//! host → plugin  {"id":2,"method":"invoke","params":{"tool":"x","args":{…}}}
//! plugin → host  {"id":2,"ok":true,"result":{…}}
//! ```
//!
//! A reply whose `id` does not match is ignored: a plugin is free to emit its
//! own events, and treating one as an answer would desynchronise the stream.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{mpsc, Mutex};

use crate::error::{AppError, Result};
use crate::tools::ToolDescriptor;

use super::manifest::PluginManifest;
use super::provider::{BoxFuture, ToolProvider};

/// Starting a process includes loading its runtime; generous but bounded.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// A tool may do real work (network, encoding), so this is the larger budget.
const INVOKE_TIMEOUT: Duration = Duration::from_secs(60);

/// What the plugin declares about itself when asked.
#[derive(Debug, Deserialize)]
pub(crate) struct DescribeResult {
    #[serde(default, rename = "voiceProviders")]
    pub(crate) voice_providers: Vec<super::voice::VoiceProviderSpec>,
    #[serde(default)]
    pub(crate) tools: Vec<ToolSpec>,
    #[serde(default)]
    pub(crate) commands: Vec<CommandSpec>,
    /// What the plugin wants on screen, if anything.
    #[serde(default)]
    pub(crate) ui: super::ui::PluginUi,
    /// One short paragraph for the model: what this plugin lets LILO do.
    #[serde(default)]
    pub(crate) prompt: Option<String>,
    #[serde(default, rename = "contextTool")]
    pub(crate) context_tool: Option<String>,
    /// Topics it wants delivered (`{"method":"event"}`).
    #[serde(default)]
    pub(crate) subscribes: Vec<String>,
    /// Topics it may publish. Anything else it publishes is dropped.
    #[serde(default)]
    pub(crate) publishes: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ToolSpec {
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) description: String,
    #[serde(default = "empty_schema")]
    pub(crate) parameters: Value,
}

fn empty_schema() -> Value {
    serde_json::json!({ "type": "object", "properties": {} })
}

/// A command a plugin contributes, in wire form.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSpec {
    pub name: String,
    #[serde(default = "default_scope")]
    pub scope: crate::commands::registry::CommandScope,
    pub tool: Option<String>,
    #[serde(default)]
    pub descriptions: Vec<(String, String)>,
    #[serde(default)]
    pub requires_confirm: bool,
    #[serde(default)]
    pub templates: Vec<(String, String)>,
    /// `{"slot": ["word", …]}`: the slot must contain one of the words.
    #[serde(default)]
    pub slot_words: std::collections::BTreeMap<String, Vec<String>>,
    /// Fixed tool args, merged under the matched slots.
    #[serde(default)]
    pub args: std::collections::BTreeMap<String, String>,
}

fn default_scope() -> crate::commands::registry::CommandScope {
    // A contributed command almost always runs a tool; without one it is prose
    // for the model, which is the other sensible default.
    crate::commands::registry::CommandScope::Tool
}

impl CommandSpec {
    pub fn into_descriptor(self) -> crate::commands::registry::CommandDescriptor {
        crate::commands::registry::CommandDescriptor {
            name: self.name,
            scope: self.scope,
            tool: self.tool,
            descriptions: self.descriptions,
            requires_confirm: self.requires_confirm,
            templates: self.templates,
            slot_words: self.slot_words.into_iter().collect(),
            args: Vec::new(),
        }
    }
}

/// Longest line a plugin may send. Without a cap, a plugin that never writes a
/// newline grows the host's buffer until the machine runs out of memory.
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
/// How much of a plugin's stderr is kept to explain a failure.
const STDERR_TAIL_LINES: usize = 12;
const STDERR_LINE_CHARS: usize = 300;
/// A plugin that keeps crashing is not restarted forever.
const MAX_RESTARTS: u32 = 3;
const RESTART_WINDOW: Duration = Duration::from_secs(60);
const SHUTDOWN_GRACE: Duration = Duration::from_millis(800);

/// How to start (and restart) the process.
struct Launch {
    dir: PathBuf,
    program: PathBuf,
    /// What the launcher needs before the plugin's own args (`cmd /C`, or
    /// `powershell -File`).
    prefix_args: Vec<OsString>,
    args: Vec<String>,
    id: String,
}

/// The program that actually runs an entry point.
///
/// Everywhere but Windows the entry is the executable. Windows cannot start a
/// script directly: a PowerShell plugin needs `powershell.exe` and a batch
/// plugin needs `cmd.exe`. Entries without one of those extensions (a native
/// binary) are started as-is, on every platform.
fn launchable(entry: &Path) -> (PathBuf, Vec<OsString>) {
    #[cfg(windows)]
    {
        let extension = entry
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        match extension.as_deref() {
            Some("ps1") => (
                PathBuf::from("powershell.exe"),
                vec![
                    OsString::from("-NoProfile"),
                    OsString::from("-ExecutionPolicy"),
                    OsString::from("Bypass"),
                    OsString::from("-File"),
                    entry.into(),
                ],
            ),
            Some("cmd") | Some("bat") => (
                PathBuf::from("cmd.exe"),
                vec![OsString::from("/C"), entry.into()],
            ),
            _ => (entry.to_path_buf(), Vec::new()),
        }
    }
    #[cfg(not(windows))]
    {
        (entry.to_path_buf(), Vec::new())
    }
}

const MAX_PENDING_EVENTS: usize = 64;

/// Start the process, riding out a transient `ETXTBSY`.
///
/// `execve` answers `ETXTBSY` ("Text file busy") while a write handle to the
/// file is open anywhere. A plugin installed and started back to back can hit
/// it on Linux: a thread that forked between the installer's write and this
/// spawn holds a copy of the handle until its own exec. Retrying covers that
/// window; a genuinely busy entry point still fails, after the budget.
fn spawn_plugin(command: &mut Command) -> std::io::Result<tokio::process::Child> {
    const ATTEMPTS: u32 = 5;
    const RETRY: Duration = Duration::from_millis(20);
    let mut attempt = 0;
    loop {
        attempt += 1;
        match command.spawn() {
            Err(error) if is_text_file_busy(&error) && attempt < ATTEMPTS => {
                std::thread::sleep(RETRY);
            }
            result => return result,
        }
    }
}

/// `ETXTBSY` is 26 on Linux and the BSDs; Windows has no equivalent state.
fn is_text_file_busy(error: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(26)
    }
    #[cfg(not(unix))]
    {
        let _ = error;
        false
    }
}

#[derive(Default)]
struct Outlet {
    publishes: std::sync::Mutex<Vec<String>>,
    publisher: std::sync::Mutex<Option<super::bus::Publisher>>,
    pending: std::sync::Mutex<Vec<(String, Value)>>,
}

impl Outlet {
    fn allowed(&self, topic: &str) -> bool {
        self.publishes
            .lock()
            .map(|patterns| {
                patterns
                    .iter()
                    .any(|pattern| super::bus::topic_matches(pattern, topic))
            })
            .unwrap_or(false)
    }

    fn send(&self, topic: String, payload: Value) {
        let publisher = self.publisher.lock().ok().and_then(|slot| slot.clone());
        match publisher {
            Some(publisher) => {
                if self.allowed(&topic) {
                    publisher.publish(&topic, payload);
                }
            }
            None => {
                if let Ok(mut pending) = self.pending.lock() {
                    if pending.len() < MAX_PENDING_EVENTS {
                        pending.push((topic, payload));
                    }
                }
            }
        }
    }

    fn declare(&self, publishes: Vec<String>) {
        if let Ok(mut slot) = self.publishes.lock() {
            *slot = publishes;
        }
    }

    fn attach(&self, publisher: super::bus::Publisher) {
        let pending = self
            .pending
            .lock()
            .map(|mut pending| std::mem::take(&mut *pending))
            .unwrap_or_default();
        if let Ok(mut slot) = self.publisher.lock() {
            *slot = Some(publisher);
        }
        for (topic, payload) in pending {
            self.send(topic, payload);
        }
    }
}

fn voice_notification(line: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(line).ok()?;
    value.get("voice").cloned()
}

fn published_event(line: &str) -> Option<(String, Value)> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    let publish = value.get("publish")?;
    let topic = publish.get("topic")?.as_str()?.to_string();
    let payload = publish.get("payload").cloned().unwrap_or(Value::Null);
    Some((topic, payload))
}

/// One running process and the conversation with it. Kept in one struct so a
/// call holds the whole exchange, which is what makes the id matching correct.
struct Connection {
    child: tokio::process::Child,
    stdin: ChildStdin,
    replies: mpsc::UnboundedReceiver<std::result::Result<String, String>>,
    next_id: u64,
    stderr: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<String>>>,
}

impl Connection {
    fn spawn(launch: &Launch, outlet: &Arc<Outlet>) -> Result<Self> {
        let mut command = Command::new(&launch.program);
        command
            .args(&launch.prefix_args)
            .args(&launch.args)
            .current_dir(&launch.dir)
            .env_clear()
            .envs(
                super::INHERITED_ENV
                    .iter()
                    .filter_map(|key| std::env::var_os(key).map(|value| (key.to_string(), value))),
            )
            .env("LILO_PLUGIN_ID", &launch.id)
            .env("LILO_PLUGIN_DIR", &launch.dir)
            .env(
                "LILO_PLUGIN_API",
                super::manifest::PLUGIN_API_VERSION.to_string(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = spawn_plugin(&mut command)
            .map_err(|error| AppError::other(format!("could not start plugin: {error}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::other("plugin stdin was not piped"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::other("plugin stdout was not piped"))?;

        // Keep the last lines of stderr: they are what explains a crash. The
        // reader also drains the pipe, so a chatty plugin cannot block on a
        // full stderr buffer.
        let tail = std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new()));
        if let Some(stderr) = child.stderr.take() {
            let tail = tail.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr);
                while let Ok(Some(line)) = read_line_limited(&mut reader).await {
                    let line: String = line.chars().take(STDERR_LINE_CHARS).collect();
                    if let Ok(mut tail) = tail.lock() {
                        if tail.len() == STDERR_TAIL_LINES {
                            tail.pop_front();
                        }
                        tail.push_back(line);
                    }
                }
            });
        }

        let (sender, replies) = mpsc::unbounded_channel();
        let outlet = outlet.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_line_limited(&mut reader).await {
                    Ok(Some(line)) => {
                        if let Some(output) = voice_notification(&line) {
                            if let Ok(slot) = outlet.publisher.lock() {
                                if let Some(publisher) = slot.as_ref() {
                                    let _ = publisher.voice_output(output);
                                }
                            }
                        } else if let Some((topic, payload)) = published_event(&line) {
                            outlet.send(topic, payload);
                        } else if sender.send(Ok(line)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let _ = sender.send(Err(error.to_string()));
                        break;
                    }
                }
            }
        });

        Ok(Connection {
            child,
            stdin,
            replies,
            next_id: 1,
            stderr: tail,
        })
    }

    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn stderr_tail(&self) -> String {
        self.stderr
            .lock()
            .map(|tail| tail.iter().cloned().collect::<Vec<_>>().join(" | "))
            .unwrap_or_default()
    }

    async fn request(&mut self, method: &str, params: Value, budget: Duration) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        let mut line =
            serde_json::json!({ "id": id, "method": method, "params": params }).to_string();
        line.push('\n');
        // Which side of the pipe notices a dead plugin first is a race: macOS
        // usually finds out on the read, Linux on the write (EPIPE).
        if let Err(error) = self.stdin.write_all(line.as_bytes()).await {
            return Err(self.write_failed(error));
        }
        if let Err(error) = self.stdin.flush().await {
            return Err(self.write_failed(error));
        }

        let deadline = tokio::time::Instant::now() + budget;
        loop {
            let read = tokio::time::timeout_at(deadline, self.replies.recv())
                .await
                .map_err(|_| AppError::other(format!("plugin timed out on {method}")))?;
            let line = read
                .transpose()
                .map_err(AppError::other)?
                .ok_or_else(|| self.gone())?;
            let Ok(reply) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if reply.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if reply.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
            }
            let message = reply
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("plugin reported a failure");
            return Err(AppError::Tool(message.to_string()));
        }
    }

    /// A plugin that stopped answering. The last lines of its stderr are what
    /// explains a crash, on either side of the pipe.
    fn gone(&self) -> AppError {
        let tail = self.stderr_tail();
        if tail.is_empty() {
            AppError::other("plugin closed its output before answering")
        } else {
            AppError::other(format!("plugin closed its output before answering: {tail}"))
        }
    }

    /// A failed write to a plugin. `EPIPE` is the crash the read side would
    /// have reported; anything else is a real I/O problem and says so.
    fn write_failed(&self, error: std::io::Error) -> AppError {
        if error.kind() == std::io::ErrorKind::BrokenPipe {
            self.gone()
        } else {
            AppError::other(format!("could not write to plugin: {error}"))
        }
    }
}

/// Read one `\n`-terminated line, refusing lines longer than `MAX_LINE_BYTES`.
/// `Ok(None)` is end of stream.
async fn read_line_limited<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Option<String>> {
    let mut buffer = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if buffer.is_empty() {
                return Ok(None);
            }
            break;
        }
        match available.iter().position(|byte| *byte == b'\n') {
            Some(end) => {
                buffer.extend_from_slice(&available[..end]);
                reader.consume(end + 1);
                break;
            }
            None => {
                let taken = available.len();
                buffer.extend_from_slice(available);
                reader.consume(taken);
            }
        }
        if buffer.len() > MAX_LINE_BYTES {
            return Err(AppError::other(format!(
                "plugin sent a line longer than {MAX_LINE_BYTES} bytes"
            )));
        }
    }
    if buffer.len() > MAX_LINE_BYTES {
        return Err(AppError::other(format!(
            "plugin sent a line longer than {MAX_LINE_BYTES} bytes"
        )));
    }
    if buffer.last() == Some(&b'\r') {
        buffer.pop();
    }
    Ok(Some(String::from_utf8_lossy(&buffer).into_owned()))
}

struct Io {
    /// `None` after the process died or was stopped; the next call restarts it.
    connection: Option<Connection>,
    restarts: Vec<tokio::time::Instant>,
    /// Set once the host asked the plugin to stop: no restart after that.
    stopped: bool,
}

pub struct SidecarPlugin {
    manifest: PluginManifest,
    tools: Vec<ToolDescriptor>,
    voice_providers: Vec<super::voice::VoiceProviderSpec>,
    commands: Vec<crate::commands::registry::CommandDescriptor>,
    ui: super::ui::PluginUi,
    /// Hint for the model about what this plugin is for, from `describe`.
    prompt: Option<String>,
    context_tool: Option<String>,
    launch: Launch,
    /// Last settings pushed, replayed to a restarted process.
    settings: std::sync::Mutex<Option<Value>>,
    subscribes: Vec<String>,
    outlet: Arc<Outlet>,
    /// The running process, for the Storage panel's attribution. Zero when it
    /// is not running; refreshed on every start and restart.
    pid: std::sync::atomic::AtomicU32,
    /// The process dies with this (`kill_on_drop`): a leaked plugin process
    /// would keep running with no way to stop it, exactly like an orphaned mpv.
    io: Mutex<Io>,
}

impl std::fmt::Debug for SidecarPlugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SidecarPlugin")
            .field("id", &self.manifest.id)
            .field("tools", &self.tools.len())
            .finish()
    }
}

impl SidecarPlugin {
    /// Start a plugin and complete the handshake.
    pub async fn start(
        dir: &Path,
        manifest: PluginManifest,
        entry: &str,
        args: &[String],
    ) -> Result<Self> {
        manifest.validate_identity()?;
        if !manifest.is_compatible() {
            return Err(AppError::other(format!(
                "plugin {} speaks api {} but this host speaks {}",
                manifest.id,
                manifest.api,
                super::manifest::PLUGIN_API_VERSION
            )));
        }
        let (program, prefix_args) = launchable(&resolve_entry(dir, entry)?);
        let launch = Launch {
            dir: dir.to_path_buf(),
            program,
            prefix_args,
            args: args.to_vec(),
            id: manifest.id.clone(),
        };
        let outlet = Arc::new(Outlet::default());
        let mut connection = Connection::spawn(&launch, &outlet)?;
        let described: DescribeResult = serde_json::from_value(
            connection
                .request("describe", Value::Null, HANDSHAKE_TIMEOUT)
                .await?,
        )?;

        super::voice::validate_specs(&manifest, &described.voice_providers)?;
        let tools: Vec<ToolDescriptor> = described
            .tools
            .into_iter()
            .map(|tool| ToolDescriptor {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            })
            .collect();
        let commands = described
            .commands
            .into_iter()
            .map(CommandSpec::into_descriptor)
            .collect();

        // A description the host cannot render is a plugin bug: fail the load
        // instead of showing a half-broken page later.
        described
            .ui
            .validate()
            .map_err(|reason| AppError::other(format!("invalid ui description: {reason}")))?;
        described
            .ui
            .validate_tools(tools.iter().map(|tool| tool.name.as_str()))
            .map_err(|reason| AppError::other(format!("invalid ui description: {reason}")))?;

        Ok(SidecarPlugin {
            voice_providers: described.voice_providers,
            manifest,
            tools,
            commands,
            ui: described.ui,
            prompt: sanitize_prompt(described.prompt),
            context_tool: described.context_tool,
            launch,
            settings: std::sync::Mutex::new(None),
            subscribes: described.subscribes,
            outlet: {
                outlet.declare(described.publishes);
                outlet
            },
            pid: std::sync::atomic::AtomicU32::new(connection.child.id().unwrap_or(0)),
            io: Mutex::new(Io {
                connection: Some(connection),
                restarts: Vec::new(),
                stopped: false,
            }),
        })
    }

    /// Commands the plugin brings, ready for the router.
    pub fn commands(&self) -> Vec<crate::commands::registry::CommandDescriptor> {
        self.commands.clone()
    }

    /// What the plugin wants on screen.
    pub fn ui(&self) -> &super::ui::PluginUi {
        &self.ui
    }

    /// One request, restarting the process first if it died. A timeout or a
    /// broken pipe drops the connection, so a hung plugin is replaced on the
    /// next call instead of answering stale replies forever.
    async fn call(&self, method: &str, params: Value, budget: Duration) -> Result<Value> {
        let mut io = self.io.lock().await;
        if io.stopped {
            return Err(AppError::other(format!(
                "plugin {} was stopped",
                self.manifest.id
            )));
        }
        let dead = match io.connection.as_mut() {
            Some(connection) => !connection.alive(),
            None => true,
        };
        if dead {
            io.connection = None;
            self.restart(&mut io).await?;
        }
        let connection = io
            .connection
            .as_mut()
            .ok_or_else(|| AppError::other("plugin is not running"))?;
        let result = connection.request(method, params, budget).await;
        if let Err(error) = &result {
            // A plugin's own `ok:false` leaves the conversation intact; anything
            // else (timeout, closed pipe, oversized line) does not.
            if !matches!(error, AppError::Tool(_)) {
                io.connection = None;
            }
        }
        result
    }

    async fn restart(&self, io: &mut Io) -> Result<()> {
        let now = tokio::time::Instant::now();
        io.restarts
            .retain(|at| now.duration_since(*at) < RESTART_WINDOW);
        if io.restarts.len() as u32 >= MAX_RESTARTS {
            return Err(AppError::other(format!(
                "plugin {} keeps crashing; restart LILO or reinstall it",
                self.manifest.id
            )));
        }
        io.restarts.push(now);
        let mut connection = Connection::spawn(&self.launch, &self.outlet)?;
        let described: DescribeResult = serde_json::from_value(
            connection
                .request("describe", Value::Null, HANDSHAKE_TIMEOUT)
                .await?,
        )
        .map_err(|_| AppError::other("Invalid provider description after restart."))?;
        super::voice::validate_specs(&self.manifest, &described.voice_providers)?;
        if described.voice_providers != self.voice_providers {
            return Err(AppError::other(
                "Voice provider declarations changed during restart.",
            ));
        }
        if let Ok(slot) = self.outlet.publisher.lock() {
            if let Some(publisher) = slot.as_ref() {
                publisher.cancel_voices();
            }
        }
        let settings = self.settings.lock().ok().and_then(|stored| stored.clone());
        if let Some(settings) = settings {
            // Best effort: a plugin without `configure` still works.
            let _ = connection
                .request("configure", settings, HANDSHAKE_TIMEOUT)
                .await;
        }
        self.pid.store(
            connection.child.id().unwrap_or(0),
            std::sync::atomic::Ordering::Relaxed,
        );
        io.connection = Some(connection);
        Ok(())
    }

    /// Where this plugin's events go. Set by the host after loading.
    pub fn set_publisher(&self, publisher: super::bus::Publisher) {
        self.outlet.attach(publisher);
    }

    /// The plugin process, while it is running. The Storage panel uses it to
    /// say which process belongs to this plugin instead of guessing by name.
    pub fn process_id(&self) -> Option<u32> {
        let pid = self.pid.load(std::sync::atomic::Ordering::Relaxed);
        (pid != 0).then_some(pid)
    }

    /// Hand the plugin its settings, so a change takes effect without a
    /// restart. A plugin that does not implement `configure` is not an error:
    /// it can simply read the file again on its next call.
    pub async fn configure(&self, settings: Value) -> Result<()> {
        if let Ok(mut stored) = self.settings.lock() {
            *stored = Some(settings.clone());
        }
        self.call("configure", settings, HANDSHAKE_TIMEOUT).await?;
        Ok(())
    }

    /// Ask the plugin to exit so it can flush what it writes, then make sure it
    /// is gone. Never restarted afterwards.
    pub async fn shutdown(&self) {
        if let Ok(slot) = self.outlet.publisher.lock() {
            if let Some(publisher) = slot.as_ref() {
                publisher.cancel_voices();
            }
        }

        let mut io = self.io.lock().await;
        io.stopped = true;
        self.pid.store(0, std::sync::atomic::Ordering::Relaxed);
        if let Some(mut connection) = io.connection.take() {
            if connection.alive() {
                let _ = connection
                    .request("shutdown", Value::Null, SHUTDOWN_GRACE)
                    .await;
                let _ = tokio::time::timeout(SHUTDOWN_GRACE, connection.child.wait()).await;
            }
            let _ = connection.child.start_kill();
        }
    }

    /// The process is up (or will be restarted on the next call).
    pub async fn is_running(&self) -> bool {
        let mut io = self.io.lock().await;
        !io.stopped && io.connection.as_mut().is_some_and(Connection::alive)
    }
}

/// A plugin's prompt hint is untrusted text headed for the model: bounded, one
/// paragraph, no control characters.
pub(crate) fn sanitize_prompt(prompt: Option<String>) -> Option<String> {
    const MAX_PROMPT_CHARS: usize = 600;
    let text: String = prompt?
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(MAX_PROMPT_CHARS).collect())
}

/// The entry point must stay inside the plugin's own directory: a manifest
/// that says `../../bin/sh` is an escape attempt, not a plugin.
pub(crate) fn resolve_entry(dir: &Path, entry: &str) -> Result<PathBuf> {
    let candidate = Path::new(entry);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(AppError::other(format!(
            "plugin entry must be a relative path inside its own directory: {entry}"
        )));
    }
    let program = dir.join(candidate);
    if !program.is_file() {
        return Err(AppError::other(format!(
            "plugin entry not found: {}",
            program.display()
        )));
    }
    Ok(program)
}

impl ToolProvider for SidecarPlugin {
    fn voice_providers(&self) -> Vec<super::voice::VoiceProviderSpec> {
        self.voice_providers.clone()
    }
    fn invoke_voice<'a>(
        &'a self,
        request: &'a super::voice::VoiceRequest,
    ) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            let request = super::voice::VoiceRequest::parse(request.value())?;
            if !self
                .voice_providers
                .iter()
                .any(|provider| provider.id == request.provider_id)
            {
                return Err(AppError::other(
                    "This plugin does not own the requested voice provider.",
                ));
            }
            super::voice::validate_result(
                self.call("voice", request.value(), INVOKE_TIMEOUT).await?,
            )
        })
    }

    fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }

    fn descriptors(&self) -> Vec<ToolDescriptor> {
        self.tools.clone()
    }

    fn handles(&self, tool: &str) -> bool {
        self.tools.iter().any(|owned| owned.name == tool)
    }

    fn invoke<'a>(&'a self, tool: &'a str, args: &'a Value) -> BoxFuture<'a, Result<Value>> {
        Box::pin(async move {
            if !self.handles(tool) {
                return Err(AppError::other(format!(
                    "plugin {} does not provide {tool}",
                    self.manifest.id
                )));
            }
            self.call(
                "invoke",
                serde_json::json!({ "tool": tool, "args": args }),
                INVOKE_TIMEOUT,
            )
            .await
        })
    }

    fn ui(&self) -> super::ui::PluginUi {
        self.ui.clone()
    }

    fn prompt(&self) -> Option<String> {
        self.prompt.clone()
    }
    fn context_tool(&self) -> Option<String> {
        self.context_tool.clone().filter(|tool| self.handles(tool))
    }

    fn commands(&self) -> Vec<crate::commands::registry::CommandDescriptor> {
        self.commands.clone()
    }

    fn configure<'a>(&'a self, settings: Value) -> BoxFuture<'a, Result<()>> {
        Box::pin(SidecarPlugin::configure(self, settings))
    }

    fn shutdown<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(SidecarPlugin::shutdown(self))
    }

    fn set_publisher(&self, publisher: super::bus::Publisher) {
        SidecarPlugin::set_publisher(self, publisher);
    }

    fn process_ids(&self) -> Vec<u32> {
        SidecarPlugin::process_id(self).into_iter().collect()
    }

    fn subscriptions(&self) -> Vec<String> {
        self.subscribes.clone()
    }

    fn on_event<'a>(&'a self, event: &'a super::bus::Event) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            // A plugin that does not implement `event` answers with an error;
            // delivery is best effort either way.
            let _ = self
                .call(
                    "event",
                    serde_json::to_value(event).unwrap_or(Value::Null),
                    HANDSHAKE_TIMEOUT,
                )
                .await;
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_may_not_escape_its_directory() {
        let dir = Path::new("/tmp/plugin");
        assert!(resolve_entry(dir, "../evil").is_err());
        assert!(resolve_entry(dir, "/bin/sh").is_err());
        assert!(resolve_entry(dir, "bin/../../evil").is_err());
    }

    #[test]
    fn a_missing_entry_is_reported() {
        let error = resolve_entry(Path::new("/tmp/plugin"), "nope.sh").unwrap_err();
        assert!(error.to_string().contains("not found"), "{error}");
    }

    #[test]
    fn a_native_entry_is_started_itself() {
        let entry = Path::new("/tmp/plugin/hello");
        let (program, prefix) = launchable(entry);
        assert_eq!(program, entry);
        assert!(prefix.is_empty());
    }

    /// The Windows launcher, exercised without Windows.
    #[cfg(windows)]
    #[test]
    fn a_windows_script_gets_its_interpreter() {
        let ps1 = Path::new("C:/plugin/hello.ps1");
        let (program, prefix) = launchable(ps1);
        assert_eq!(program, Path::new("powershell.exe"));
        assert_eq!(prefix[0], "-NoProfile");
        assert_eq!(prefix[prefix.len() - 2], "-File");
        assert_eq!(prefix[prefix.len() - 1], "C:/plugin/hello.ps1");

        let bat = Path::new("C:/plugin/hello.cmd");
        let (program, prefix) = launchable(bat);
        assert_eq!(program, Path::new("cmd.exe"));
        assert_eq!(prefix[0], "/C");
        assert_eq!(prefix[1], "C:/plugin/hello.cmd");
    }

    #[test]
    fn a_command_spec_becomes_a_descriptor() {
        let spec: CommandSpec = serde_json::from_value(serde_json::json!({
            "name": "hello.greet",
            "scope": "tool",
            "tool": "hello_greet",
            "descriptions": [["en", "Greet."]],
            "templates": [["en", "say hello"]],
        }))
        .unwrap();
        let descriptor = spec.into_descriptor();
        assert_eq!(descriptor.name, "hello.greet");
        assert_eq!(descriptor.tool.as_deref(), Some("hello_greet"));
        assert_eq!(descriptor.templates.len(), 1);
        assert!(!descriptor.requires_confirm);
    }

    #[test]
    fn a_command_without_a_scope_defaults_to_tool() {
        let spec: CommandSpec =
            serde_json::from_value(serde_json::json!({ "name": "x", "tool": "t" })).unwrap();
        assert_eq!(
            spec.into_descriptor().scope,
            crate::commands::registry::CommandScope::Tool
        );
    }

    /// A third-party plugin in another language, over a pipe: the contract a
    /// process plugin has to meet. (The shipped examples moved to the embedded
    /// engine; the process path stays for plugins that need to be processes.)
    #[tokio::test]
    #[cfg(unix)]
    async fn a_plugin_declares_tools_and_answers_invocations() {
        let dir = script_plugin(
            r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"describe"'*)
      printf '{"id":%s,"ok":true,"result":{"tools":[{"name":"hello_greet","description":"Greet someone by name."}],"commands":[{"name":"hello.greet","tool":"hello_greet","templates":[["en","say hello to {name}"]]}]}}\n' "$id" ;;
    *'"method":"invoke"'*)
      printf '{"id":%s,"ok":true,"result":{"greeting":"hello, Ada"}}\n' "$id" ;;
    *) printf '{"id":%s,"ok":true,"result":null}\n' "$id" ;;
  esac
done
"#,
        );
        let manifest = PluginManifest::new("com.lilo.hello", "Hello", "1.0.0");
        let plugin = SidecarPlugin::start(&dir, manifest, "run.sh", &[])
            .await
            .expect("the plugin must start");

        assert!(plugin.handles("hello_greet"));
        assert!(!plugin.handles("something_else"));
        assert_eq!(plugin.descriptors().len(), 1);

        let result = plugin
            .invoke("hello_greet", &serde_json::json!({ "name": "Ada" }))
            .await
            .expect("the call must succeed");
        assert_eq!(result["greeting"], "hello, Ada");

        // Commands travel with the plugin and become matchable in the router.
        let commands = plugin.commands();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "hello.greet");
        assert_eq!(commands[0].tool.as_deref(), Some("hello_greet"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn a_plugin_that_dies_before_answering_is_an_error() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("lilo-plugin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("dies.sh");
        let mut file = std::fs::File::create(&script).unwrap();
        // Exits immediately without ever answering the handshake.
        file.write_all(b"#!/bin/sh\nexit 3\n").unwrap();
        drop(file);
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let manifest = PluginManifest::new("com.acme.dies", "Dies", "1.0.0");
        let error = SidecarPlugin::start(&dir, manifest, "dies.sh", &[])
            .await
            .expect_err("a plugin that never answers must not be registered");
        assert!(error.to_string().contains("closed its output"), "{error}");

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn an_incompatible_plugin_is_refused_before_it_starts() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/plugins/hello");
        let mut manifest = PluginManifest::new("com.lilo.hello", "Hello", "1.0.0");
        manifest.api = super::super::PLUGIN_API_VERSION + 1;
        let error = SidecarPlugin::start(&dir, manifest, "hello.js", &[])
            .await
            .unwrap_err();
        assert!(error.to_string().contains("speaks api"), "{error}");
    }

    /// Write an executable test plugin and return its folder.
    #[cfg(unix)]
    fn script_plugin(body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("lilo-plugin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("run.sh");
        std::fs::write(&script, body).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        dir
    }

    /// Answers describe/configure/shutdown; `invoke` runs `$INVOKE`.
    #[cfg(unix)]
    const SCRIPT_HEAD: &str = r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"describe"'*)
      printf '{"id":%s,"ok":true,"result":{"tools":[{"name":"t"}],"prompt":"Keeps\\n  a  test\\tnotebook."}}\n' "$id" ;;
    *'"method":"configure"'*)
      printf '%s' "$line" > configured.json
      printf '{"id":%s,"ok":true,"result":null}\n' "$id" ;;
    *'"method":"shutdown"'*)
      touch stopped
      printf '{"id":%s,"ok":true,"result":null}\n' "$id"; exit 0 ;;
    *'"method":"invoke"'*)
"#;

    #[cfg(unix)]
    const SCRIPT_TAIL: &str = r#"      ;;
  esac
done
"#;

    #[tokio::test]
    #[cfg(unix)]
    async fn a_crashed_plugin_is_restarted_with_its_settings() {
        let dir = script_plugin(&format!(
            "{SCRIPT_HEAD}      if [ -f crashed ]; then printf '{{\"id\":%s,\"ok\":true,\"result\":\"back\"}}\\n' \"$id\"; else touch crashed; echo 'boom: out of cheese' >&2; exit 1; fi\n{SCRIPT_TAIL}"
        ));
        let plugin = SidecarPlugin::start(
            &dir,
            PluginManifest::new("com.t.crash", "Crash", "1"),
            "run.sh",
            &[],
        )
        .await
        .unwrap();
        assert_eq!(plugin.prompt().as_deref(), Some("Keeps a test notebook."));
        plugin
            .configure(serde_json::json!({ "max": 7 }))
            .await
            .unwrap();

        let first = plugin
            .invoke("t", &serde_json::json!({}))
            .await
            .unwrap_err();
        assert!(
            first.to_string().contains("out of cheese"),
            "stderr explains the crash: {first}"
        );

        let second = plugin.invoke("t", &serde_json::json!({})).await.unwrap();
        assert_eq!(second, "back");
        let replayed = std::fs::read_to_string(dir.join("configured.json")).unwrap();
        assert!(
            replayed.contains("\"max\":7"),
            "settings are replayed: {replayed}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn a_plugin_does_not_inherit_the_host_environment() {
        std::env::set_var("LILO_TEST_SECRET_TOKEN", "hunter2");
        let dir = script_plugin(&format!(
            "{SCRIPT_HEAD}      printf '{{\"id\":%s,\"ok\":true,\"result\":\"%s|%s\"}}\\n' \"$id\" \"$LILO_TEST_SECRET_TOKEN\" \"$LILO_PLUGIN_ID\"\n{SCRIPT_TAIL}"
        ));
        let plugin = SidecarPlugin::start(
            &dir,
            PluginManifest::new("com.t.env", "Env", "1"),
            "run.sh",
            &[],
        )
        .await
        .unwrap();
        let result = plugin.invoke("t", &serde_json::json!({})).await.unwrap();
        assert_eq!(result, "|com.t.env");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn shutdown_lets_the_plugin_stop_and_it_stays_stopped() {
        let dir = script_plugin(&format!(
            "{SCRIPT_HEAD}      printf '{{\"id\":%s,\"ok\":true,\"result\":1}}\\n' \"$id\"\n{SCRIPT_TAIL}"
        ));
        let plugin = SidecarPlugin::start(
            &dir,
            PluginManifest::new("com.t.stop", "Stop", "1"),
            "run.sh",
            &[],
        )
        .await
        .unwrap();
        assert!(plugin.is_running().await);
        plugin.shutdown().await;
        assert!(dir.join("stopped").exists(), "the plugin was asked to stop");
        assert!(!plugin.is_running().await);
        assert!(plugin.invoke("t", &serde_json::json!({})).await.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn an_event_published_between_calls_reaches_the_bus_without_another_call() {
        let dir = script_plugin(
            r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"describe"'*)
      printf '{"id":%s,"ok":true,"result":{"tools":[{"name":"t"}],"publishes":["tick.*"]}}\n' "$id" ;;
    *'"method":"invoke"'*)
      ( sleep 0.3
        printf '{"publish":{"topic":"other.topic","payload":{}}}\n'
        printf '{"publish":{"topic":"tick.done","payload":{"n":1}}}\n' ) &
      printf '{"id":%s,"ok":true,"result":"armed"}\n' "$id" ;;
    *) printf '{"id":%s,"ok":true,"result":null}\n' "$id" ;;
  esac
done
"#,
        );
        let plugin = SidecarPlugin::start(
            &dir,
            PluginManifest::new("com.t.tick", "Tick", "1"),
            "run.sh",
            &[],
        )
        .await
        .unwrap();
        let (bus, mut events) = super::super::bus::EventBus::new();
        plugin.set_publisher(bus.publisher("com.t.tick"));

        assert_eq!(
            plugin.invoke("t", &serde_json::json!({})).await.unwrap(),
            "armed"
        );

        let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("the event arrives while no call is running")
            .unwrap();
        assert_eq!(event.topic, "tick.done");
        assert_eq!(event.payload["n"], 1);
        assert_eq!(event.source, "com.t.tick");
        plugin.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn an_endless_line_is_refused_instead_of_buffered() {
        let huge = vec![b'x'; MAX_LINE_BYTES + 10];
        let mut reader = BufReader::new(&huge[..]);
        let error = read_line_limited(&mut reader).await.unwrap_err();
        assert!(error.to_string().contains("longer than"), "{error}");

        let mut ok = BufReader::new(&b"{\"id\":1}\r\nnext"[..]);
        assert_eq!(
            read_line_limited(&mut ok).await.unwrap().as_deref(),
            Some("{\"id\":1}")
        );
        assert_eq!(
            read_line_limited(&mut ok).await.unwrap().as_deref(),
            Some("next")
        );
        assert_eq!(read_line_limited(&mut ok).await.unwrap(), None);
    }
}

#[cfg(test)]
mod voice_tests {
    #[test]
    fn test_private_voice_notifications_are_not_public_topic_events() {
        let line = r#"{"voice":{"providerId":"voice","sessionId":"fixture-session","events":[{"type":"response_started"}]}}"#;
        assert!(super::published_event(line).is_none());
        assert!(super::voice_notification(line).is_some());
        assert!(super::voice_notification(r#"{"id":1,"result":{}}"#).is_none());
    }
}
