//! Embedded JavaScript plugins: the sidecar contract, in-process.
//!
//! A `quickjs` plugin is one `.js` file that defines a few global functions —
//! the same shape as the JSON a sidecar answers with, so porting one means
//! turning the `case` on `method` into functions:
//!
//! ```js
//! function describe() { return { tools: [...], commands: [...], ui: {...} }; }
//! function invoke(tool, args) { ... }        // returns the result
//! function configure(settings) { ... }
//! function event(topic, payload, source) { ... }
//! function tick(nowMs) { ... }               // timers live here
//! ```
//!
//! and publishing through the host (`lilo.publish`, `lilo.read`, `lilo.write`,
//! `lilo.log`, `lilo.exec`, `lilo.platform`, `lilo.temp`, `lilo.readBase64`,
//! and `lilo.screenshot` behind `screen:capture`).
//! One file runs identically on Windows, macOS and Linux: no
//! interpreter to install, no per-platform entry, and the script cannot reach
//! the network without declared HTTP permissions, the filesystem outside its
//! `data/` and scratch folder, or even
//! the clock except through the host — which is what makes a marketplace
//! plugin reviewable.
//!
//! Isolation is per plugin: its own QuickJS runtime on its own thread, a heap
//! ceiling and an interrupt handler that ends runaway code. The process
//! contract stays for plugins that need to be processes.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rquickjs::{
    Array, Context, Ctx, Function, Object, Runtime, String as JsString, Value as JsValue,
};
use serde_json::{Map, Number, Value};

use crate::error::{AppError, Result};
use crate::tools::ToolDescriptor;

use super::bus::{topic_matches, Publisher};
use super::manifest::PluginManifest;
use super::provider::{BoxFuture, ToolProvider};
use super::sidecar::{sanitize_prompt, CommandSpec, DescribeResult, ToolSpec};

/// How often `tick` runs. Timers are built on it, so this is the resolution of
/// a plugin's own clock; 4 Hz is invisible to a user and free on the Pi.
const TICK: Duration = Duration::from_millis(250);
/// A tool may do real work; the interrupt handler ends a script that will not.
/// The test override lets a runaway-loop test finish in half a second.
#[cfg(not(test))]
const CALL_BUDGET: Duration = Duration::from_secs(60);
#[cfg(test)]
static CALL_BUDGET_MS: AtomicU64 = AtomicU64::new(500);
const HANDSHAKE_BUDGET: Duration = Duration::from_secs(10);
const TICK_BUDGET: Duration = Duration::from_secs(2);
/// Per-plugin heap ceiling. A runaway plugin fails its own call instead of
/// taking the host down.
const MEMORY_LIMIT: usize = 32 * 1024 * 1024;
const MAX_STACK: usize = 1024 * 1024;
/// Events a plugin may publish while it is still loading before the queue is
/// dropped; a plugin announcing more than this is misbehaving.
const MAX_PENDING_PUBLISHES: usize = 32;
/// Most a plugin may read back from its scratch directory in one call. Keeps a
/// huge file from filling the 32 MB heap through one base64 string.
const MAX_SCRATCH_READ: usize = 6 * 1024 * 1024;

/// One unit of work for the plugin thread.
enum Job {
    Voice(
        super::voice::VoiceRequest,
        tokio::sync::oneshot::Sender<Result<Value>>,
    ),
    Configure(Value, tokio::sync::oneshot::Sender<Result<()>>),
    Invoke(String, Value, tokio::sync::oneshot::Sender<Result<Value>>),
    Event(
        String,
        Value,
        String,
        tokio::sync::oneshot::Sender<Result<()>>,
    ),
    Shutdown(tokio::sync::oneshot::Sender<()>),
}

/// A loaded JavaScript plugin.
pub struct QuickJsPlugin {
    manifest: PluginManifest,
    tools: Vec<ToolDescriptor>,
    voice_providers: Vec<super::voice::VoiceProviderSpec>,
    commands: Vec<crate::commands::registry::CommandDescriptor>,
    ui: super::ui::PluginUi,
    prompt: Option<String>,
    context_tool: Option<String>,
    subscribes: Vec<String>,
    /// Where publishes go. The worker reads it per publish, so a publisher set
    /// after loading is honoured.
    publisher: Arc<Mutex<Option<Publisher>>>,
    /// Events published while loading, already filtered by the declaration:
    /// they go out the moment the host sets the publisher.
    pending: Arc<Mutex<Vec<(String, Value)>>>,
    jobs: Option<Sender<Job>>,
    worker: Option<std::thread::JoinHandle<()>>,
    /// The plugin's scratch directory: where a tool it runs may write, and the
    /// only place `lilo.readBase64` may read. Emptied on every load, removed
    /// when the plugin unloads.
    scratch: PathBuf,
}

impl std::fmt::Debug for QuickJsPlugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QuickJsPlugin")
            .field("id", &self.manifest.id)
            .field("tools", &self.tools.len())
            .finish()
    }
}

impl QuickJsPlugin {
    /// Load and run the script, collecting what it says it can do.
    pub fn start(
        dir: &Path,
        manifest: PluginManifest,
        entry: &str,
        _args: &[String],
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
        let script = super::sidecar::resolve_entry(dir, entry)?;
        let data_dir = dir.join("data");
        // A tool a plugin runs may have to write a file (a screenshot). It
        // writes into the plugin's scratch directory, never into the plugin
        // folder, which an update replaces.
        let scratch = scratch_dir(&manifest.id);
        let _ = std::fs::remove_dir_all(&scratch);

        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<DescribeResult>>();
        let (job_tx, job_rx) = std::sync::mpsc::channel::<Job>();
        let publisher = Arc::new(Mutex::new(None));
        let pending = Arc::new(Mutex::new(Vec::new()));
        let worker = {
            let manifest = manifest.clone();
            let root = dir.to_path_buf();
            let scratch = scratch.clone();
            let publisher = publisher.clone();
            let pending = pending.clone();
            let label = manifest.id.clone();
            std::thread::Builder::new()
                .name(format!("plugin-{}", manifest.id))
                .spawn(move || {
                    if let Err(error) = worker(
                        &script,
                        PluginPaths {
                            root: &root,
                            data_dir: &data_dir,
                            scratch: &scratch,
                        },
                        &manifest,
                        &publisher,
                        &pending,
                        &ready_tx,
                        &job_rx,
                    ) {
                        eprintln!("[plugin {label}] {error}");
                    }
                })
                .map_err(|error| {
                    AppError::other(format!("could not start the plugin thread: {error}"))
                })?
        };

        let described = match ready_rx.recv_timeout(HANDSHAKE_BUDGET) {
            Ok(result) => result?,
            Err(_) => {
                return Err(AppError::other(
                    "the plugin did not describe itself in time",
                ));
            }
        };

        super::voice::validate_specs(&manifest, &described.voice_providers)?;
        let tools: Vec<ToolDescriptor> = described
            .tools
            .into_iter()
            .map(|tool: ToolSpec| ToolDescriptor {
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

        Ok(QuickJsPlugin {
            voice_providers: described.voice_providers,
            manifest,
            tools,
            commands,
            ui: described.ui,
            prompt: sanitize_prompt(described.prompt),
            context_tool: described.context_tool,
            subscribes: described.subscribes,
            publisher,
            pending,
            jobs: Some(job_tx),
            worker: Some(worker),
            scratch,
        })
    }

    /// Send a job and wait for its reply, respecting the call budget.
    async fn request<T>(
        &self,
        make: impl FnOnce(tokio::sync::oneshot::Sender<Result<T>>) -> Job,
        budget: Duration,
    ) -> Result<T> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let sender = self
            .jobs
            .as_ref()
            .ok_or_else(|| AppError::other("the plugin is stopped"))?;
        sender
            .send(make(tx))
            .map_err(|_| AppError::other("the plugin is gone"))?;
        match tokio::time::timeout(budget, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(AppError::other("the plugin dropped the call")),
            Err(_) => Err(AppError::other("the plugin took too long to answer")),
        }
    }
}

impl ToolProvider for QuickJsPlugin {
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
                self.request(|reply| Job::Voice(request, reply), call_budget())
                    .await?,
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
            self.request(
                |reply| Job::Invoke(tool.to_string(), args.clone(), reply),
                call_budget(),
            )
            .await
        })
    }

    fn ui(&self) -> super::ui::PluginUi {
        self.ui.clone()
    }

    fn configure<'a>(&'a self, settings: Value) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.request(|reply| Job::Configure(settings, reply), HANDSHAKE_BUDGET)
                .await
        })
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

    fn subscriptions(&self) -> Vec<String> {
        self.subscribes.clone()
    }

    fn on_event<'a>(&'a self, event: &'a super::bus::Event) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let _ = self
                .request(
                    |reply| {
                        Job::Event(
                            event.topic.clone(),
                            event.payload.clone(),
                            event.source.clone(),
                            reply,
                        )
                    },
                    HANDSHAKE_BUDGET,
                )
                .await;
        })
    }

    fn set_publisher(&self, publisher: Publisher) {
        if let Ok(mut slot) = self.publisher.lock() {
            *slot = Some(publisher.clone());
        }
        // A plugin that announced something while loading — the pomodoro
        // re-arming its timer — gets that event out now.
        let queued: Vec<(String, Value)> = self
            .pending
            .lock()
            .map(|mut queue| std::mem::take(&mut *queue))
            .unwrap_or_default();
        for (topic, payload) in queued {
            publisher
                .as_source(&self.manifest.id)
                .publish(&topic, payload);
        }
    }

    fn shutdown<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let Some(sender) = self.jobs.as_ref() else {
                return;
            };
            let (tx, rx) = tokio::sync::oneshot::channel();
            if sender.send(Job::Shutdown(tx)).is_ok() {
                let _ = tokio::time::timeout(Duration::from_secs(2), rx).await;
            }
            if let Ok(slot) = self.publisher.lock() {
                if let Some(publisher) = slot.as_ref() {
                    publisher.as_source(&self.manifest.id).cancel_interactions();
                    publisher.as_source(&self.manifest.id).cancel_voices();
                }
            }
        })
    }
}

impl Drop for QuickJsPlugin {
    fn drop(&mut self) {
        if let Ok(slot) = self.publisher.lock() {
            if let Some(publisher) = slot.as_ref() {
                publisher.as_source(&self.manifest.id).cancel_interactions();
                publisher.as_source(&self.manifest.id).cancel_voices();
            }
        }
        // Dropping the sender ends the worker's loop; uninstalling a plugin
        // must not leave its thread (and its timers) alive.
        self.jobs.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        // Nothing in the scratch directory survives the plugin: it is this
        // run's working files, not the plugin's data.
        let _ = std::fs::remove_dir_all(&self.scratch);
    }
}

// --- JSON <-> JavaScript -----------------------------------------------------

fn json_to_js<'js>(ctx: &Ctx<'js>, value: &Value) -> rquickjs::Result<JsValue<'js>> {
    Ok(match value {
        Value::Null => JsValue::new_null(ctx.clone()),
        Value::Bool(value) => JsValue::new_bool(ctx.clone(), *value),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                if let Ok(int) = i32::try_from(int) {
                    JsValue::new_int(ctx.clone(), int)
                } else {
                    JsValue::new_float(ctx.clone(), int as f64)
                }
            } else {
                JsValue::new_float(ctx.clone(), number.as_f64().unwrap_or_default())
            }
        }
        Value::String(text) => JsString::from_str(ctx.clone(), text)?.into_value(),
        Value::Array(items) => {
            let array = Array::new(ctx.clone())?;
            for (index, item) in items.iter().enumerate() {
                array.set(index, json_to_js(ctx, item)?)?;
            }
            array.into_value()
        }
        Value::Object(fields) => {
            let object = Object::new(ctx.clone())?;
            for (key, item) in fields {
                object.set(key.as_str(), json_to_js(ctx, item)?)?;
            }
            object.into_value()
        }
    })
}

/// Return structured bridge results without teaching each API JavaScript conversion.
struct HostJson(Value);

impl<'js> rquickjs::IntoJs<'js> for HostJson {
    fn into_js(self, ctx: &Ctx<'js>) -> rquickjs::Result<JsValue<'js>> {
        json_to_js(ctx, &self.0)
    }
}

/// What `lilo.exec` hands back: `{ code, stdout, stderr }`.
struct ExecOutcome {
    code: i32,
    stdout: String,
    stderr: String,
}

impl<'js> rquickjs::IntoJs<'js> for ExecOutcome {
    fn into_js(self, ctx: &Ctx<'js>) -> rquickjs::Result<JsValue<'js>> {
        let object = Object::new(ctx.clone())?;
        object.set("code", self.code)?;
        object.set("stdout", self.stdout)?;
        object.set("stderr", self.stderr)?;
        Ok(object.into_value())
    }
}

fn js_to_json(value: &JsValue<'_>) -> Value {
    if value.is_null() || value.is_undefined() {
        return Value::Null;
    }
    if let Some(flag) = value.as_bool() {
        return Value::Bool(flag);
    }
    if let Some(int) = value.as_int() {
        return Value::Number(Number::from(int));
    }
    if let Some(float) = value.as_float() {
        if float.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&float) {
            return Value::Number(Number::from(float as u64));
        }
        return Number::from_f64(float)
            .map(Value::Number)
            .unwrap_or(Value::Null);
    }
    if let Some(text) = value.as_string() {
        return Value::String(text.to_string().unwrap_or_default());
    }
    if let Some(array) = value.as_array() {
        return Value::Array(
            (0..array.len())
                .filter_map(|index| array.get::<JsValue>(index).ok())
                .map(|item| js_to_json(&item))
                .collect(),
        );
    }
    if let Some(object) = value.as_object() {
        let mut fields = Map::new();
        for (key, item) in object.props::<String, JsValue>().flatten() {
            fields.insert(key, js_to_json(&item));
        }
        return Value::Object(fields);
    }
    Value::Null
}

// --- the worker thread -------------------------------------------------------

/// Epoch milliseconds, the only clock a plugin sees.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default()
}

/// Resolve a `lilo.read`/`lilo.write` name inside the plugin's own `data/`.
pub(crate) fn data_path(root: &Path, name: &str) -> Result<PathBuf> {
    let candidate = Path::new(name);
    // `has_root` also catches `/etc/passwd`, which Windows does not call
    // absolute but would still resolve outside the plugin folder.
    if candidate.has_root()
        || candidate.components().any(|part| {
            part.as_os_str().to_str().is_some_and(|name| {
                name.trim_end_matches(['.', ' '])
                    .eq_ignore_ascii_case(".lilo-state")
            })
        })
        || candidate
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(AppError::other(format!(
            "plugin data must stay inside data/: {name}"
        )));
    }
    Ok(root.join(candidate))
}

/// The plugin's scratch directory, under the OS temp dir so nothing here ever
/// mixes with the plugin folder an update replaces.
fn scratch_dir(id: &str) -> PathBuf {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    std::env::temp_dir().join(format!("lilo-plugin-{safe}"))
}

/// Resolve a `lilo.temp` name inside the scratch directory. A bare file name
/// only: a path that could leave the directory is refused, exactly like a
/// plugin's own data names.
fn scratch_path(dir: &Path, name: &str) -> Result<PathBuf> {
    let candidate = Path::new(name);
    let mut parts = candidate.components();
    let single_normal =
        matches!(parts.next(), Some(std::path::Component::Normal(_))) && parts.next().is_none();
    if name.is_empty() || candidate.has_root() || !single_normal {
        return Err(AppError::other(format!(
            "scratch names are bare file names: {name:?}"
        )));
    }
    std::fs::create_dir_all(dir)
        .map_err(|error| AppError::other(format!("could not create the scratch dir: {error}")))?;
    Ok(dir.join(candidate))
}

/// Read back what a tool wrote, only from the plugin's scratch directory.
fn read_scratch(dir: &Path, path: &str) -> Result<Vec<u8>> {
    let root = std::fs::canonicalize(dir)
        .map_err(|error| AppError::other(format!("scratch dir: {error}")))?;
    let file = std::fs::canonicalize(path)
        .map_err(|error| AppError::other(format!("no such scratch file: {error}")))?;
    if !file.starts_with(&root) {
        return Err(AppError::other(format!(
            "readBase64 may only read the plugin's own scratch files: {path}"
        )));
    }
    let size = std::fs::metadata(&file)
        .map_err(|error| AppError::other(format!("scratch file: {error}")))?
        .len();
    if size > MAX_SCRATCH_READ as u64 {
        return Err(AppError::other(format!(
            "scratch file is larger than {MAX_SCRATCH_READ} bytes"
        )));
    }
    std::fs::read(&file).map_err(|error| AppError::other(format!("scratch file: {error}")))
}

/// The error text a script threw, when there is one.
fn js_error(ctx: &Ctx<'_>, error: rquickjs::Error) -> AppError {
    let caught = ctx.catch();
    let detail = caught
        .as_exception()
        .and_then(|exception| exception.message())
        .or_else(|| caught.as_string().and_then(|value| value.to_string().ok()));
    match detail {
        Some(detail) if !detail.is_empty() => {
            AppError::other(format!("javascript error: {detail}"))
        }
        _ => AppError::other(format!("javascript error: {error}")),
    }
}

/// Borrowed directories shared by the worker and its sandboxed host API.
#[derive(Clone, Copy)]
struct PluginPaths<'a> {
    root: &'a Path,
    data_dir: &'a Path,
    scratch: &'a Path,
}

/// The plugin thread: owns the runtime, answers jobs, ticks the clock.
fn worker(
    script: &Path,
    paths: PluginPaths<'_>,
    manifest: &PluginManifest,
    publisher: &Arc<Mutex<Option<Publisher>>>,
    pending: &Arc<Mutex<Vec<(String, Value)>>>,
    ready: &Sender<Result<DescribeResult>>,
    jobs: &Receiver<Job>,
) -> Result<()> {
    let runtime = Runtime::new().map_err(|error| AppError::other(format!("quickjs: {error}")))?;
    runtime.set_memory_limit(MEMORY_LIMIT);
    runtime.set_max_stack_size(MAX_STACK);
    let deadline = Arc::new(AtomicU64::new(u64::MAX));
    let interrupt = deadline.clone();
    runtime.set_interrupt_handler(Some(Box::new(move || {
        now_ms() > interrupt.load(Ordering::Relaxed)
    })));

    let context =
        Context::full(&runtime).map_err(|error| AppError::other(format!("quickjs: {error}")))?;

    // `None` until `describe` declares them: a plugin is allowed to publish
    // while it loads (the pomodoro re-arms its timer), and those events are
    // buffered, then filtered against the declaration and delivered.
    let publishes: Arc<Mutex<Option<Vec<String>>>> = Arc::new(Mutex::new(None));
    let scheduler = Arc::new(Mutex::new(None));
    let owned_tools = Arc::new(Mutex::new(Vec::new()));

    let described = context.with(|ctx| -> Result<DescribeResult> {
        if manifest
            .capabilities
            .iter()
            .any(|cap| cap == "schedule:self")
        {
            let store = super::durable::Store::for_plugin(paths.data_dir, "scheduler")?;
            *scheduler
                .lock()
                .map_err(|_| AppError::other("Scheduler is unavailable."))? =
                Some(super::scheduler::Scheduler::load(store)?);
        }
        install_host_api(
            &ctx,
            manifest,
            paths,
            publisher,
            &publishes,
            pending,
            ScheduledBindings {
                scheduler: &scheduler,
                owned_tools: &owned_tools,
            },
        )?;
        let source = std::fs::read_to_string(script).map_err(|error| {
            AppError::other(format!("could not read {}: {error}", script.display()))
        })?;
        deadline.store(budget_ms(HANDSHAKE_BUDGET), Ordering::Relaxed);
        ctx.eval::<JsValue, _>(source.as_bytes())
            .map_err(|error| js_error(&ctx, error))?;

        let described = call_describe(&ctx)?;
        *owned_tools
            .lock()
            .map_err(|_| AppError::other("Plugin tools are unavailable."))? = described
            .tools
            .iter()
            .map(|tool| tool.name.clone())
            .collect();
        if let Ok(mut allowed) = publishes.lock() {
            *allowed = Some(described.publishes.clone());
        }
        Ok(described)
    });
    let failed = described.is_err();
    let _ = ready.send(described);
    if failed {
        return Ok(());
    }
    // Deliver only what the declaration allows; the publisher may not be set
    // yet, so whatever survives waits in the queue for `set_publisher`.
    retain_declared_publishes(&publishes, pending);

    loop {
        match jobs.recv_timeout(TICK) {
            Ok(Job::Shutdown(reply)) => {
                let _ = context.with(|ctx| {
                    deadline.store(budget_ms(TICK_BUDGET), Ordering::Relaxed);
                    call_with(&ctx, "shutdown", Value::Null)
                });
                let _ = reply.send(());
                return Ok(());
            }
            Ok(Job::Configure(settings, reply)) => {
                let result = context.with(|ctx| {
                    deadline.store(budget_ms(HANDSHAKE_BUDGET), Ordering::Relaxed);
                    call_with(&ctx, "configure", settings)
                });
                let _ = reply.send(result);
            }
            Ok(Job::Voice(request, reply)) => {
                let result = context.with(|ctx| {
                    deadline.store(budget_ms(call_budget()), Ordering::Relaxed);
                    let function = globals_function(&ctx, "voice")
                        .ok_or_else(|| AppError::other("The plugin does not implement voice()."))?;
                    let request = json_to_js(&ctx, &request.value())
                        .map_err(|error| js_error(&ctx, error))?;
                    let result: JsValue = function
                        .call((request,))
                        .map_err(|error| js_error(&ctx, error))?;
                    Ok(js_to_json(&result))
                });
                let _ = reply.send(result);
            }
            Ok(Job::Invoke(tool, args, reply)) => {
                let result = context.with(|ctx| {
                    deadline.store(budget_ms(call_budget()), Ordering::Relaxed);
                    call_invoke(&ctx, &tool, args)
                });
                let _ = reply.send(result);
            }
            Ok(Job::Event(topic, payload, source, reply)) => {
                let result = context.with(|ctx| {
                    deadline.store(budget_ms(HANDSHAKE_BUDGET), Ordering::Relaxed);
                    call_event(&ctx, &topic, payload, &source)
                });
                let _ = reply.send(result);
            }
            Err(RecvTimeoutError::Timeout) => {
                let _ = context.with(|ctx| {
                    deadline.store(budget_ms(TICK_BUDGET), Ordering::Relaxed);
                    call_tick(&ctx, now_ms())
                });
            }
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        }
        if publisher.lock().ok().is_some_and(|slot| slot.is_some()) {
            run_scheduled(&context, &scheduler, &owned_tools, &deadline);
        }
    }
}

fn run_scheduled(
    context: &Context,
    scheduler: &Arc<Mutex<Option<super::scheduler::Scheduler>>>,
    owned: &Arc<Mutex<Vec<String>>>,
    deadline: &AtomicU64,
) {
    for _ in 0..4 {
        let fire = scheduler.lock().ok().and_then(|mut slot| {
            slot.as_mut()
                .and_then(|scheduler| scheduler.due(now_ms()).ok().flatten())
        });
        let Some(fire) = fire else {
            return;
        };
        let valid = owned
            .lock()
            .ok()
            .is_some_and(|tools| tools.contains(&fire.tool));
        let result = if valid {
            context.with(|ctx| {
                deadline.store(budget_ms(TICK_BUDGET), Ordering::Relaxed);
                let mut args = fire.args.clone();
                if let Some(args) = args.as_object_mut() {
                    args.insert("_schedule".into(), serde_json::json!({"id":fire.id,"scheduledAt":fire.at,"deliveredAt":now_ms()}));
                }
                call_invoke(&ctx, &fire.tool, args).map(|_| ())
            })
        } else {
            Err(AppError::other(
                "Scheduled tool is no longer owned by this plugin.",
            ))
        };
        if let Ok(mut slot) = scheduler.lock() {
            if let Some(scheduler) = slot.as_mut() {
                let _ = scheduler.finish(
                    &fire,
                    if result.is_ok() {
                        "completed"
                    } else {
                        "failed"
                    },
                );
            }
        }
    }
}

fn budget_ms(budget: Duration) -> u64 {
    now_ms() + budget.as_millis() as u64
}

/// How long one `invoke` may run. Tests shrink it so the runaway-loop case
/// does not hold the suite for a minute; production keeps the real budget.
fn call_budget() -> Duration {
    #[cfg(test)]
    {
        Duration::from_millis(CALL_BUDGET_MS.load(Ordering::Relaxed))
    }
    #[cfg(not(test))]
    {
        CALL_BUDGET
    }
}

struct ScheduledBindings<'a> {
    scheduler: &'a Arc<Mutex<Option<super::scheduler::Scheduler>>>,
    owned_tools: &'a Arc<Mutex<Vec<String>>>,
}

/// The `lilo` object a script sees. Everything outside it is sealed.
fn install_host_api(
    ctx: &Ctx<'_>,
    manifest: &PluginManifest,
    paths: PluginPaths<'_>,
    publisher: &Arc<Mutex<Option<Publisher>>>,
    publishes: &Arc<Mutex<Option<Vec<String>>>>,
    pending: &Arc<Mutex<Vec<(String, Value)>>>,
    scheduled: ScheduledBindings<'_>,
) -> Result<()> {
    let PluginPaths {
        root,
        data_dir,
        scratch,
    } = paths;
    let lilo = Object::new(ctx.clone()).map_err(js_err)?;
    if manifest
        .capabilities
        .iter()
        .any(|scope| scope == "provider:voice")
    {
        let api = Object::new(ctx.clone()).map_err(js_err)?;
        let voice_slot = publisher.clone();
        let publish = Function::new(
            ctx.clone(),
            move |output: JsValue| -> rquickjs::Result<bool> {
                let result = voice_slot.lock().ok().and_then(|slot| {
                    slot.as_ref()
                        .map(|publisher| publisher.voice_output(js_to_json(&output)))
                });
                match result {
                    Some(Ok(())) => Ok(true),
                    _ => Err(rquickjs::Error::new_from_js_message(
                        "voice",
                        "publish",
                        "Voice output requires an active owned session.",
                    )),
                }
            },
        )
        .map_err(js_err)?;
        api.set("publish", publish).map_err(js_err)?;
        lilo.set("voice", api).map_err(js_err)?;
        let browser = Object::new(ctx.clone()).map_err(js_err)?;
        let browser_slot = publisher.clone();
        let call = Function::new(
            ctx.clone(),
            move |provider: String, script: String, args: JsValue| -> rquickjs::Result<HostJson> {
                let publisher = browser_slot
                    .lock()
                    .ok()
                    .and_then(|slot| slot.clone())
                    .ok_or_else(|| {
                        rquickjs::Error::new_from_js_message(
                            "browser",
                            "call",
                            "Browser host is unavailable.",
                        )
                    })?;
                let args = js_to_json(&args);
                let result = (|| -> Result<Value> {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|_| AppError::other("Browser runtime is unavailable."))?;
                    runtime.block_on(publisher.browser_evaluate(&provider, &script, args))
                })()
                .map_err(|error| {
                    rquickjs::Error::new_from_js_message("browser", "call", error.to_string())
                })?;
                Ok(HostJson(result))
            },
        )
        .map_err(js_err)?;
        browser.set("call", call).map_err(js_err)?;
        lilo.set("browser", browser).map_err(js_err)?;
    }

    let topics = publishes.clone();
    let buffered = pending.clone();
    let source = manifest.id.clone();
    let slot = publisher.clone();
    let publish = Function::new(
        ctx.clone(),
        move |topic: JsValue, payload: JsValue| -> rquickjs::Result<bool> {
            let topic = js_to_json(&topic);
            let topic = topic.as_str().unwrap_or_default().to_string();
            let payload = js_to_json(&payload);
            match topics.lock().ok().and_then(|topics| topics.clone()) {
                // Still loading: the declaration is not known yet, so hold the
                // event and deliver it once `describe` has run.
                None => {
                    if let Ok(mut queue) = buffered.lock() {
                        if queue.len() < MAX_PENDING_PUBLISHES {
                            queue.push((topic, payload));
                        }
                    }
                }
                Some(patterns) => {
                    if !patterns
                        .iter()
                        .any(|pattern| topic_matches(pattern, &topic))
                    {
                        return Err(rquickjs::Error::new_from_js_message(
                            "publish",
                            "topic",
                            "not declared in the plugin's publishes",
                        ));
                    }
                    if let Some(publisher) = slot.lock().ok().and_then(|slot| slot.clone()) {
                        publisher.as_source(&source).publish(&topic, payload);
                    }
                }
            }
            Ok(true)
        },
    )
    .map_err(js_err)?;
    lilo.set("publish", publish).map_err(js_err)?;

    let data_root = data_dir.to_path_buf();
    let read = Function::new(
        ctx.clone(),
        move |name: JsValue| -> rquickjs::Result<Option<String>> {
            let name = js_to_json(&name);
            let name = name.as_str().unwrap_or_default();
            let path = data_path(&data_root, name).map_err(|error| {
                rquickjs::Error::new_from_js_message("read", "name", error.to_string())
            })?;
            Ok(std::fs::read_to_string(path).ok())
        },
    )
    .map_err(js_err)?;
    lilo.set("read", read).map_err(js_err)?;

    let data_root = data_dir.to_path_buf();
    let write = Function::new(
        ctx.clone(),
        move |name: JsValue, text: JsValue| -> rquickjs::Result<bool> {
            let name = js_to_json(&name);
            let name = name.as_str().unwrap_or_default();
            let path = data_path(&data_root, name).map_err(|error| {
                rquickjs::Error::new_from_js_message("write", "name", error.to_string())
            })?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| {
                    rquickjs::Error::new_from_js_message("write", "path", error.to_string())
                })?;
            }
            let text = js_to_json(&text);
            let text = text.as_str().unwrap_or_default();
            std::fs::write(&path, text).map_err(|error| {
                rquickjs::Error::new_from_js_message("write", "path", error.to_string())
            })?;
            Ok(true)
        },
    )
    .map_err(js_err)?;
    lilo.set("write", write).map_err(js_err)?;

    let data = data_dir.to_path_buf();
    let permitted = manifest
        .capabilities
        .iter()
        .any(|cap| cap == "storage:self");
    let memory = Function::new(
        ctx.clone(),
        move |operation: String, args: JsValue| -> rquickjs::Result<HostJson> {
            let result = (|| -> Result<Value> {
                if !permitted {
                    return Err(AppError::other("Memory requires storage:self."));
                }
                super::durable::Store::for_plugin(&data, "memory")?
                    .request(&operation, js_to_json(&args))
            })()
            .map_err(|error| {
                rquickjs::Error::new_from_js_message("memory", "request", error.to_string())
            })?;
            Ok(HostJson(result))
        },
    )
    .map_err(js_err)?;
    lilo.set("memory", memory).map_err(js_err)?;

    let can_read_session = manifest
        .capabilities
        .iter()
        .any(|cap| cap == "session:read");
    let context_slot = publisher.clone();
    let session = Function::new(ctx.clone(), move || -> rquickjs::Result<HostJson> {
        if !can_read_session {
            return Err(rquickjs::Error::new_from_js_message(
                "session",
                "read",
                "Session context requires session:read.",
            ));
        }
        let context = context_slot
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(Publisher::session_context))
            .unwrap_or_default();
        serde_json::to_value(context).map(HostJson).map_err(|_| {
            rquickjs::Error::new_from_js_message(
                "session",
                "read",
                "Session context is unavailable.",
            )
        })
    })
    .map_err(js_err)?;
    lilo.set("session", session).map_err(js_err)?;

    let can_interact = manifest
        .capabilities
        .iter()
        .any(|cap| cap == "interaction:self");
    let interaction_slot = publisher.clone();
    let interaction_owner = manifest.id.clone();
    let interaction = Function::new(
        ctx.clone(),
        move |operation: String, args: JsValue| -> rquickjs::Result<HostJson> {
            let result = (|| {
                if !can_interact {
                    return Err(AppError::other("Questions require interaction:self."));
                }
                let slot = interaction_slot
                    .lock()
                    .map_err(|_| AppError::other("Interaction host is unavailable."))?;
                let publisher = slot
                    .as_ref()
                    .ok_or_else(|| AppError::other("Interaction host is not attached yet."))?;
                publisher
                    .as_source(&interaction_owner)
                    .interaction(&operation, js_to_json(&args))
            })()
            .map_err(|error| {
                rquickjs::Error::new_from_js_message("interaction", "request", error.to_string())
            })?;
            Ok(HostJson(result))
        },
    )
    .map_err(js_err)?;
    lilo.set("interaction", interaction).map_err(js_err)?;

    let scheduler = scheduled.scheduler.clone();
    let owned = scheduled.owned_tools.clone();
    let schedule = Function::new(
        ctx.clone(),
        move |operation: String, args: JsValue| -> rquickjs::Result<HostJson> {
            let result = (|| -> Result<Value> {
                let tools = owned
                    .lock()
                    .map_err(|_| AppError::other("Plugin tools are unavailable."))?;
                let mut slot = scheduler
                    .lock()
                    .map_err(|_| AppError::other("Scheduler is unavailable."))?;
                slot.as_mut()
                    .ok_or_else(|| AppError::other("Scheduling requires schedule:self."))?
                    .request(&operation, js_to_json(&args), &tools)
            })()
            .map_err(|error| {
                rquickjs::Error::new_from_js_message("schedule", "request", error.to_string())
            })?;
            Ok(HostJson(result))
        },
    )
    .map_err(js_err)?;
    lilo.set("schedule", schedule).map_err(js_err)?;

    let permissions = manifest.capabilities.clone();
    let http = Function::new(
        ctx.clone(),
        move |url: String, options: JsValue| -> rquickjs::Result<HostJson> {
            let result = super::http::request(&permissions, &url, js_to_json(&options)).map_err(
                |error| rquickjs::Error::new_from_js_message("http", "request", error.to_string()),
            )?;
            let value = serde_json::to_value(result).map_err(|_| {
                rquickjs::Error::new_from_js_message(
                    "http",
                    "response",
                    "HTTP response serialization failed.",
                )
            })?;
            Ok(HostJson(value))
        },
    )
    .map_err(js_err)?;
    lilo.set("http", http).map_err(js_err)?;

    // The one door to the machine: a bare binary name the manifest declared as
    // `exec:<name>`, run as argv without a shell, bounded by `exec::run`.
    let capabilities = manifest.capabilities.clone();
    let cwd = root.to_path_buf();
    let exec = Function::new(
        ctx.clone(),
        move |program: JsValue, args: JsValue| -> rquickjs::Result<ExecOutcome> {
            let program = js_to_json(&program);
            let program = program.as_str().unwrap_or_default().to_string();
            if !super::exec::declared(&capabilities, &program) {
                return Err(rquickjs::Error::new_from_js_message(
                    "exec",
                    "program",
                    format!(
                        "{program:?} is not declared — a plugin may run only its `exec:<name>` capabilities"
                    ),
                ));
            }
            let args = js_to_json(&args);
            let argv: Vec<String> = match args {
                Value::Null => Vec::new(),
                Value::Array(items) => {
                    let mut argv = Vec::with_capacity(items.len());
                    for item in items {
                        match item.as_str() {
                            Some(text) => argv.push(text.to_string()),
                            None => {
                                return Err(rquickjs::Error::new_from_js_message(
                                    "exec",
                                    "args",
                                    "every argument must be a string",
                                ));
                            }
                        }
                    }
                    argv
                }
                _ => {
                    return Err(rquickjs::Error::new_from_js_message(
                        "exec",
                        "args",
                        "args must be an array of strings",
                    ));
                }
            };
            let output = super::exec::run(&cwd, &program, &argv).map_err(|error| {
                rquickjs::Error::new_from_js_message("exec", "program", error.to_string())
            })?;
            Ok(ExecOutcome {
                code: output.code,
                stdout: output.stdout,
                stderr: output.stderr,
            })
        },
    )
    .map_err(js_err)?;
    lilo.set("exec", exec).map_err(js_err)?;

    // Desktop permissions are checked again for each operation before native access.
    if manifest
        .capabilities
        .iter()
        .any(|capability| matches!(capability.as_str(), "desktop:apps" | "desktop:text"))
    {
        let capabilities = manifest.capabilities.clone();
        let desktop = Arc::new(Mutex::new(super::desktop::DesktopHost::new()));
        let api = Function::new(
            ctx.clone(),
            move |operation: String, args: JsValue| -> rquickjs::Result<String> {
                let mut host = desktop.lock().map_err(|_| {
                    rquickjs::Error::new_from_js_message(
                        "desktop",
                        "host",
                        "Desktop service is unavailable.",
                    )
                })?;
                Ok(host
                    .request(&capabilities, &operation, js_to_json(&args))
                    .to_string())
            },
        )
        .map_err(js_err)?;
        lilo.set("desktop", api).map_err(js_err)?;
    }

    // Which OS this is. A plugin that has to run a different tool per platform
    // (macOS `screencapture`, Linux `grim`, Windows PowerShell) branches on it
    // instead of shipping one file per OS.
    lilo.set("platform", std::env::consts::OS).map_err(js_err)?;

    // A path under the plugin's scratch directory for a tool to write to.
    let scratch_root = scratch.to_path_buf();
    let temp = Function::new(
        ctx.clone(),
        move |name: JsValue| -> rquickjs::Result<String> {
            let name = js_to_json(&name);
            let name = name.as_str().unwrap_or_default();
            let path = scratch_path(&scratch_root, name).map_err(|error| {
                rquickjs::Error::new_from_js_message("temp", "name", error.to_string())
            })?;
            Ok(path.to_string_lossy().to_string())
        },
    )
    .map_err(js_err)?;
    lilo.set("temp", temp).map_err(js_err)?;

    // The bytes of what a tool wrote there — the only way binary output (a
    // JPEG, a PNG) crosses into JavaScript, as base64. Reads are confined to
    // the scratch directory.
    let scratch_root = scratch.to_path_buf();
    let read_base64 = Function::new(
        ctx.clone(),
        move |path: JsValue| -> rquickjs::Result<String> {
            let path = js_to_json(&path);
            let path = path.as_str().unwrap_or_default();
            let bytes = read_scratch(&scratch_root, path).map_err(|error| {
                rquickjs::Error::new_from_js_message("readBase64", "path", error.to_string())
            })?;
            use base64::Engine as _;
            Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
        },
    )
    .map_err(js_err)?;
    lilo.set("readBase64", read_base64).map_err(js_err)?;

    // The primary screen as a base64 JPEG, captured in-process — only for a
    // plugin that declared `screen:capture`. On Windows this replaces a
    // PowerShell capture script that antivirus engines block.
    if manifest.capabilities.iter().any(|c| c == "screen:capture") {
        let screenshot = Function::new(
            ctx.clone(),
            move |max_edge: JsValue| -> rquickjs::Result<String> {
                let max_edge = js_to_json(&max_edge).as_u64().unwrap_or(1600).min(8192) as u32;
                let bytes = super::screen::capture_jpeg(max_edge).map_err(|error| {
                    rquickjs::Error::new_from_js_message("screenshot", "screen", error)
                })?;
                use base64::Engine as _;
                Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
            },
        )
        .map_err(js_err)?;
        lilo.set("screenshot", screenshot).map_err(js_err)?;
    }

    let name = manifest.id.clone();
    let log = Function::new(ctx.clone(), move |message: JsValue| {
        let message = js_to_json(&message);
        eprintln!("[plugin {name}] {}", message.as_str().unwrap_or_default());
    })
    .map_err(js_err)?;
    lilo.set("log", log).map_err(js_err)?;

    // Derive discovery from the bridge actually installed for this plugin.
    let mut apis = lilo
        .keys::<String>()
        .collect::<rquickjs::Result<Vec<_>>>()
        .map_err(js_err)?;
    apis.retain(|name| name != "platform");
    apis.push("hostInfo".into());
    apis.sort();
    let info = serde_json::json!({
        "api": super::manifest::PLUGIN_API_VERSION,
        "hostVersion": env!("CARGO_PKG_VERSION"),
        "runtime": "quickjs", "platform": std::env::consts::OS,
        "apis": apis, "permissions": manifest.capabilities,
        "features": ["contextTool", "conversationEvents", "localizedUi", "languagePacks", "atomicMemory", "persistentSchedules", "sessionContext", "linkedInteractions"],
        "limits": {"memoryBytes": MEMORY_LIMIT,
            "httpTimeoutMs": super::http::MAX_TIMEOUT_MS,
            "httpRequestBytes": super::http::MAX_REQUEST_BYTES,
            "httpResponseBytes": super::http::MAX_RESPONSE_BYTES,
            "memoryJsonBytes": super::durable::MAX_JSON_BYTES,
            "memoryRecords": super::durable::MAX_RECORDS,
            "scheduleJobs": super::scheduler::MAX_JOBS,
            "scheduleArgsBytes": super::scheduler::MAX_ARGS_BYTES,
            "interactionOptionsBytes": super::interactions::MAX_OPTIONS_BYTES,
            "interactionHistory": super::interactions::MAX_HISTORY},
        "nativeScreenCapture": cfg!(windows) && manifest.capabilities.iter().any(|cap| cap == "screen:capture")
    });
    let host_info = Function::new(ctx.clone(), move || HostJson(info.clone())).map_err(js_err)?;
    lilo.set("hostInfo", host_info).map_err(js_err)?;

    ctx.globals().set("lilo", lilo).map_err(js_err)?;
    Ok(())
}

/// Keep only the events a plugin published while loading that its declaration
/// allows; an undeclared one is dropped, not fatal.
fn retain_declared_publishes(
    publishes: &Arc<Mutex<Option<Vec<String>>>>,
    pending: &Arc<Mutex<Vec<(String, Value)>>>,
) {
    let patterns = publishes
        .lock()
        .ok()
        .and_then(|declared| declared.clone())
        .unwrap_or_default();
    if let Ok(mut queue) = pending.lock() {
        queue.retain(|(topic, _)| patterns.iter().any(|pattern| topic_matches(pattern, topic)));
    }
}

fn js_err(error: rquickjs::Error) -> AppError {
    AppError::other(format!("javascript error: {error}"))
}

fn globals_function<'js>(ctx: &Ctx<'js>, name: &str) -> Option<Function<'js>> {
    ctx.globals()
        .get::<_, JsValue>(name)
        .ok()
        .and_then(|value| value.as_function().cloned())
}

fn call_describe(ctx: &Ctx<'_>) -> Result<DescribeResult> {
    let Some(function) = globals_function(ctx, "describe") else {
        return serde_json::from_value(Value::Object(Map::new()))
            .map_err(|error| AppError::other(format!("invalid describe(): {error}")));
    };
    let value: JsValue = function.call(()).map_err(|error| js_error(ctx, error))?;
    serde_json::from_value(js_to_json(&value))
        .map_err(|error| AppError::other(format!("describe() returned something else: {error}")))
}

fn call_invoke(ctx: &Ctx<'_>, tool: &str, args: Value) -> Result<Value> {
    let Some(function) = globals_function(ctx, "invoke") else {
        return Err(AppError::other("the plugin does not implement invoke()"));
    };
    let tool = JsString::from_str(ctx.clone(), tool).map_err(|error| js_error(ctx, error))?;
    let args = json_to_js(ctx, &args).map_err(|error| js_error(ctx, error))?;
    let value: JsValue = function
        .call((tool, args))
        .map_err(|error| js_error(ctx, error))?;
    Ok(js_to_json(&value))
}

fn call_with(ctx: &Ctx<'_>, name: &str, settings: Value) -> Result<()> {
    let Some(function) = globals_function(ctx, name) else {
        return Ok(());
    };
    let settings = json_to_js(ctx, &settings).map_err(|error| js_error(ctx, error))?;
    function
        .call::<_, JsValue>((settings,))
        .map_err(|error| js_error(ctx, error))?;
    Ok(())
}

fn call_event(ctx: &Ctx<'_>, topic: &str, payload: Value, source: &str) -> Result<()> {
    let Some(function) = globals_function(ctx, "event") else {
        return Ok(());
    };
    let topic = JsString::from_str(ctx.clone(), topic).map_err(|error| js_error(ctx, error))?;
    let payload = json_to_js(ctx, &payload).map_err(|error| js_error(ctx, error))?;
    let source = JsString::from_str(ctx.clone(), source).map_err(|error| js_error(ctx, error))?;
    function
        .call::<_, JsValue>((topic, payload, source))
        .map_err(|error| js_error(ctx, error))?;
    Ok(())
}

fn call_tick(ctx: &Ctx<'_>, now: u64) -> Result<()> {
    let Some(function) = globals_function(ctx, "tick") else {
        return Ok(());
    };
    function
        .call::<_, JsValue>((now as f64,))
        .map_err(|error| js_error(ctx, error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn test_interaction_ask_bridge_requires_permission_and_reports_missing_voice_channel() {
        let dir = plugin_dir(
            "interaction-bridge",
            r#"
            function describe() { return {tools:[{name:"ask",parameters:{type:"object"}}]}; }
            function invoke() { return lilo.interaction("ask",{
              question:"How many minutes?",
              answer:{kind:"number",min:5,max:60},
              confirmation:{question:"You said {answer}. Confirm?",accept:["yes"],reject:["no"]}
            }); }
        "#,
        );
        let denied =
            QuickJsPlugin::start(&dir, manifest("com.test.ask.denied"), "plugin.js", &[]).unwrap();
        assert!(denied
            .invoke("ask", &serde_json::json!({}))
            .await
            .unwrap_err()
            .to_string()
            .contains("interaction:self"));
        denied.shutdown().await;
        let plugin = QuickJsPlugin::start(
            &dir,
            manifest("com.test.ask").with_capabilities(&["interaction:self"]),
            "plugin.js",
            &[],
        )
        .unwrap();
        let (bus, _) = super::super::bus::EventBus::new();
        plugin.set_publisher(bus.publisher("com.test.ask"));
        assert_eq!(
            plugin.invoke("ask", &serde_json::json!({})).await.unwrap()["status"],
            "unsupported"
        );
        plugin.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }
    #[tokio::test]
    async fn test_session_bridge_is_read_only_live_and_permission_scoped() {
        let dir = plugin_dir(
            "session-bridge",
            r#"
            function describe() { return {tools:[{name:"context",parameters:{type:"object"}}]}; }
            function invoke(tool, args) {
                const context = lilo.session();
                if (args.mutate) context.supportLanguage = "en-US";
                return args.mutate ? lilo.session() : context;
            }
        "#,
        );
        assert!(
            QuickJsPlugin::start(&dir, manifest("host"), "plugin.js", &[])
                .err()
                .unwrap()
                .to_string()
                .contains("reserved")
        );
        let denied =
            QuickJsPlugin::start(&dir, manifest("com.test.context.denied"), "plugin.js", &[])
                .unwrap();
        assert!(denied
            .invoke("context", &serde_json::json!({}))
            .await
            .unwrap_err()
            .to_string()
            .contains("session:read"));
        denied.shutdown().await;
        let plugin = QuickJsPlugin::start(
            &dir,
            manifest("com.test.context").with_capabilities(&["session:read"]),
            "plugin.js",
            &[],
        )
        .unwrap();
        let (bus, _) = super::super::bus::EventBus::new();
        plugin.set_publisher(bus.publisher("com.test.context"));
        let event = super::super::bus::Event {
            topic: "session.changed".into(),
            source: "host".into(),
            payload: serde_json::json!({"state":"connected","sessionId":"voice-123","supportLanguage":"pt-BR"}),
        };
        bus.accept(&event, &super::super::registry::ToolRegistry::new());
        let context = plugin
            .invoke("context", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(context["supportLanguage"], "pt-BR");
        assert_eq!(context["state"], "connected");
        assert_eq!(
            plugin
                .invoke("context", &serde_json::json!({"mutate":true}))
                .await
                .unwrap()["supportLanguage"],
            "pt-BR"
        );
        plugin.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }
    use super::*;
    use std::io::Write;

    fn plugin_dir(tag: &str, script: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lilo-quickjs-{tag}-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut file = std::fs::File::create(dir.join("plugin.js")).unwrap();
        file.write_all(script.as_bytes()).unwrap();
        dir
    }

    fn manifest(id: &str) -> PluginManifest {
        PluginManifest {
            id: id.to_string(),
            name: id.to_string(),
            description: String::new(),
            localized: std::collections::BTreeMap::new(),
            languages: Vec::new(),
            version: "1.0.0".to_string(),
            api: super::super::manifest::PLUGIN_API_VERSION,
            capabilities: Vec::new(),
            hosts: vec!["desktop".to_string()],
        }
    }

    #[tokio::test]
    async fn test_memory_bridge_is_structured_and_permission_scoped() {
        let dir = plugin_dir(
            "memory-bridge",
            r#"
            function describe() { return {tools:[{name:"memory_tool",parameters:{type:"object"}}]}; }
            function invoke(tool,args) {
                if (args.write) lilo.memory("write", {key:"plan",schemaVersion:1,value:{next:"Review"}});
                return lilo.memory("read", {key:"plan"});
            }
        "#,
        );
        let denied =
            QuickJsPlugin::start(&dir, manifest("com.test.memory.denied"), "plugin.js", &[])
                .unwrap();
        assert!(denied
            .invoke("memory_tool", &serde_json::json!({"write":true}))
            .await
            .unwrap_err()
            .to_string()
            .contains("storage:self"));
        denied.shutdown().await;
        let allowed = manifest("com.test.memory").with_capabilities(&["storage:self"]);
        let plugin = QuickJsPlugin::start(&dir, allowed, "plugin.js", &[]).unwrap();
        let result = plugin
            .invoke("memory_tool", &serde_json::json!({"write":true}))
            .await
            .unwrap();
        assert_eq!(result["value"]["next"], "Review");
        assert_eq!(result["revision"], 1);
        plugin.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn test_scheduled_tool_restarts_and_delivers_once_through_the_generic_bus() {
        let dir = plugin_dir(
            "scheduled-tool",
            r#"
            function describe() { return {tools:[{name:"arm",parameters:{type:"object"}},{name:"deliver",parameters:{type:"object"}}],publishes:["notify"]}; }
            function invoke(tool,args) {
                if(tool==="arm") return lilo.schedule("put",{id:"daily",tool:"deliver",at:Date.now()+500});
                lilo.publish("notify",{summary:"Time to review",id:args._schedule.id});
                return {ok:true};
            }
        "#,
        );
        let allowed = manifest("com.test.schedule").with_capabilities(&["schedule:self"]);
        let denied =
            QuickJsPlugin::start(&dir, manifest("com.test.schedule.denied"), "plugin.js", &[])
                .unwrap();
        assert!(denied
            .invoke("arm", &serde_json::json!({}))
            .await
            .unwrap_err()
            .to_string()
            .contains("schedule:self"));
        denied.shutdown().await;
        let plugin = QuickJsPlugin::start(&dir, allowed.clone(), "plugin.js", &[]).unwrap();
        plugin.invoke("arm", &serde_json::json!({})).await.unwrap();
        plugin.shutdown().await;
        let plugin = QuickJsPlugin::start(&dir, allowed.clone(), "plugin.js", &[]).unwrap();
        let (bus, mut events) = super::super::bus::EventBus::new();
        plugin.set_publisher(bus.publisher("com.test.schedule"));
        let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.payload["id"], "daily");
        plugin.shutdown().await;
        let plugin = QuickJsPlugin::start(&dir, allowed, "plugin.js", &[]).unwrap();
        plugin.set_publisher(bus.publisher("com.test.schedule"));
        assert!(
            tokio::time::timeout(Duration::from_millis(750), events.recv())
                .await
                .is_err()
        );
        plugin.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn test_all_bundled_javascript_plugins_expose_a_valid_public_contract() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins");
        for entry in std::fs::read_dir(root).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path().join("plugin.json");
            if !path.is_file() {
                continue;
            }
            let file: super::super::loader::PluginFile =
                serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
            if file.runtime != "quickjs"
                || !file.supports(std::env::consts::OS)
                || super::super::loader::is_retired(&file.id)
            {
                continue;
            }
            let dir = copied_example(entry.file_name().to_str().unwrap());
            let plugin =
                QuickJsPlugin::start(&dir, file.manifest(), file.entry_for_this_platform(), &[])
                    .unwrap();
            plugin.ui().validate().unwrap();
            for command in plugin.commands() {
                assert!(
                    command
                        .tool
                        .as_ref()
                        .is_some_and(|tool| plugin.handles(tool)),
                    "{} references a tool it does not own",
                    file.id
                );
            }
            if let Some(tool) = plugin.context_tool() {
                let result = plugin.invoke(&tool, &serde_json::json!({})).await.unwrap();
                assert!(
                    result["context"].is_string(),
                    "{} has invalid context",
                    file.id
                );
            }
            plugin.shutdown().await;
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[tokio::test]
    async fn test_plugin_discovers_public_apis_without_native_feature_ids() {
        let dir = plugin_dir(
            "host-discovery",
            r#"
            function describe() { return {tools: [{name: "inspect_host", parameters: {type: "object"}}]}; }
            function invoke() { return lilo.hostInfo(); }
        "#,
        );
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.test.host"), "plugin.js", &[]).unwrap();
        let value = plugin
            .invoke("inspect_host", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(value["api"], 1);
        assert_eq!(value["runtime"], "quickjs");
        assert_eq!(value["platform"], std::env::consts::OS);
        assert!(value["apis"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == "http"));
        assert!(value["apis"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == "read"));
        assert!(value["permissions"].as_array().unwrap().is_empty());
        for api in ["memory", "schedule"] {
            assert!(value["apis"]
                .as_array()
                .unwrap()
                .iter()
                .any(|name| name == api));
        }
        assert_eq!(value["limits"]["scheduleJobs"], 32);
        plugin.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn test_plugin_http_denies_an_undeclared_domain_before_network_access() {
        let dir = plugin_dir(
            "http-denial",
            r#"
            function describe() { return {tools: [{name: "fetch_data", parameters: {type: "object"}}]}; }
            function invoke() { return lilo.http("https://example.org/private?token=secret", {}); }
        "#,
        );
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.test.http"), "plugin.js", &[]).unwrap();
        let error = plugin
            .invoke("fetch_data", &serde_json::json!({}))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("HTTP domain is not permitted"), "{error}");
        assert!(!error.contains("secret"));
        plugin.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn author_guide_notebook_runs_in_the_embedded_engine() {
        let guide = include_str!("../../../../docs/plugin-authoring.md").replace("\r\n", "\n");
        let script = guide
            .split_once("```js\n")
            .unwrap()
            .1
            .split_once("\n```")
            .unwrap()
            .0;
        let dir = plugin_dir("author-guide", script);
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.example.notebook"), "plugin.js", &[]).unwrap();
        plugin
            .invoke(
                "acme_notebook_add",
                &serde_json::json!({"text": "Continue tomorrow"}),
            )
            .await
            .unwrap();
        let context = plugin
            .invoke("acme_notebook_context", &serde_json::json!({}))
            .await
            .unwrap();
        assert!(context["context"]
            .as_str()
            .unwrap()
            .contains("Continue tomorrow"));
        plugin.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_translation_only_plugin_loads_without_tools_or_permissions() {
        let dir = copied_example("language-es");
        let file: super::super::loader::PluginFile =
            serde_json::from_str(&std::fs::read_to_string(dir.join("plugin.json")).unwrap())
                .unwrap();
        let plugin = QuickJsPlugin::start(&dir, file.manifest(), &file.entry, &[]).unwrap();
        assert!(plugin.descriptors().is_empty());
        assert_eq!(plugin.manifest().languages[0].tag, "es-ES");
        assert_eq!(
            plugin.ui().localized["es"]["Translation coverage"],
            "Cobertura de traducción"
        );
        plugin.shutdown().await;
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn json_round_trips_through_javascript() {
        let runtime = Runtime::new().unwrap();
        let context = Context::full(&runtime).unwrap();
        let original = serde_json::json!({
            "text": "olá",
            "count": 3,
            "ratio": 1.5,
            "flag": true,
            "missing": null,
            "list": [1, "two", { "deep": [] }],
        });
        context.with(|ctx| {
            let js = json_to_js(&ctx, &original).unwrap();
            let back = js_to_json(&js);
            assert_eq!(back, original);
        });
    }

    #[tokio::test]
    async fn desktop_api_checks_capabilities_before_native_actions() {
        let dir = plugin_dir(
            "desktop-permissions",
            r#"
            function describe() { return {tools:[{name:"check"}]}; }
            function invoke() {
                if (typeof lilo.desktop !== "function") return {available:false};
                return JSON.parse(lilo.desktop("type", {app:"Editor",text:"literal text"}));
            }
        "#,
        );
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.test.desktop.none"), "plugin.js", &[])
                .unwrap();
        assert_eq!(
            plugin
                .invoke("check", &serde_json::json!({}))
                .await
                .unwrap()["available"],
            false
        );
        let mut declared = manifest("com.test.desktop.apps");
        declared.capabilities = vec!["desktop:apps".into()];
        let plugin = QuickJsPlugin::start(&dir, declared, "plugin.js", &[]).unwrap();
        let result = plugin
            .invoke("check", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(result["error"]["code"], "permission_denied");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn data_names_cannot_escape_the_plugin_folder() {
        let directory = std::env::temp_dir().join("lilo-test-plugin-data");
        let root = directory.as_path();
        assert!(data_path(root, "notes.txt").is_ok());
        assert!(data_path(root, "../secrets").is_err());
        assert!(data_path(root, "/etc/passwd").is_err());
        assert!(data_path(root, ".lilo-state/memory/plan.json").is_err());
        assert!(data_path(root, ".LILO-STATE/memory/plan.json").is_err());
        assert!(data_path(root, ".lilo-state. /memory/plan.json").is_err());
    }

    #[tokio::test]
    async fn a_script_describes_and_invokes() {
        let dir = plugin_dir(
            "invoke",
            r#"
            function describe() {
              return {
                tools: [{ name: "greet", description: "Greet.", parameters: { type: "object" } }],
                commands: [{ name: "x.greet", tool: "greet", templates: [["en", "hi"]] }],
                prompt: "Greets."
              };
            }
            function invoke(tool, args) {
              if (tool !== "greet") throw new Error("unknown tool");
              return { greeting: "hello, " + args.name };
            }
            "#,
        );
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.test.greet"), "plugin.js", &[]).unwrap();
        assert_eq!(plugin.descriptors().len(), 1);
        assert_eq!(plugin.prompt().as_deref(), Some("Greets."));

        let result = plugin
            .invoke("greet", &serde_json::json!({ "name": "Ada" }))
            .await
            .unwrap();
        assert_eq!(result["greeting"], "hello, Ada");

        let error = plugin
            .invoke("nope", &serde_json::json!({}))
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("does not provide nope"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn a_script_reads_and_writes_its_own_data() {
        let dir = plugin_dir(
            "data",
            r#"
            function describe() { return { tools: [{ name: "save" }] }; }
            function invoke(tool, args) {
              lilo.write("notes.txt", args.text);
              return { readBack: lilo.read("notes.txt") };
            }
            "#,
        );
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.test.data"), "plugin.js", &[]).unwrap();
        let result = plugin
            .invoke("save", &serde_json::json!({ "text": "buy bread" }))
            .await
            .unwrap();
        assert_eq!(result["readBack"], "buy bread");
        assert_eq!(
            std::fs::read_to_string(dir.join("data/notes.txt")).unwrap(),
            "buy bread"
        );
    }

    #[tokio::test]
    async fn tick_publishes_what_it_declared() {
        let dir = plugin_dir(
            "tick",
            r#"
            function describe() {
              return { tools: [], publishes: ["notify"] };
            }
            function tick(now) {
              lilo.publish("notify", { summary: "Focus done." });
            }
            "#,
        );
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.test.tick"), "plugin.js", &[]).unwrap();
        let (bus, mut events) = super::super::bus::EventBus::new();
        plugin.set_publisher(bus.publisher("com.test.tick"));

        let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("a tick must publish within the tick interval")
            .expect("the bus must stay open");
        assert_eq!(event.topic, "notify");
        assert_eq!(event.payload["summary"], "Focus done.");
    }

    /// A plugin may publish while it loads: the pomodoro re-arms its timer in
    /// the script's last line, before the host has seen `publishes`. The event
    /// is buffered, filtered by the declaration, and delivered as soon as the
    /// host connects the publisher.
    #[tokio::test]
    async fn a_publish_during_load_is_delivered_once_the_host_connects() {
        let dir = plugin_dir(
            "loadpublish",
            r#"
            function describe() { return { tools: [], publishes: ["statusbar"] }; }
            lilo.publish("statusbar", { label: "Focus", endsAt: 1 });
            lilo.publish("secret", { nope: true });
            "#,
        );
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.test.loadpublish"), "plugin.js", &[]).unwrap();
        let (bus, mut events) = super::super::bus::EventBus::new();
        plugin.set_publisher(bus.publisher("com.test.loadpublish"));

        // The plugin thread only has to be scheduled: 1 s was fine alone and
        // flaky under the whole workspace's parallel load.
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("the load-time event must be delivered")
            .unwrap();
        assert_eq!(event.topic, "statusbar");
        assert_eq!(event.payload["label"], "Focus");
        assert!(
            tokio::time::timeout(Duration::from_millis(200), events.recv())
                .await
                .is_err(),
            "an undeclared topic is dropped, not delivered"
        );
    }

    #[tokio::test]
    async fn an_undeclared_topic_is_refused() {
        let dir = plugin_dir(
            "nodeclare",
            r#"
            function describe() { return { tools: [] }; }
            function tick() { lilo.publish("notify", { summary: "nope" }); }
            "#,
        );
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.test.none"), "plugin.js", &[]).unwrap();
        let (bus, mut events) = super::super::bus::EventBus::new();
        plugin.set_publisher(bus.publisher("com.test.none"));
        // The refusal throws inside tick; nothing may reach the bus.
        assert!(
            tokio::time::timeout(Duration::from_millis(600), events.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn a_script_with_a_syntax_error_fails_to_load() {
        let dir = plugin_dir("broken", "function describe( {");
        let error = QuickJsPlugin::start(&dir, manifest("com.test.broken"), "plugin.js", &[])
            .expect_err("must not load");
        let text = error.to_string();
        assert!(text.contains("javascript"), "{text}");
    }

    /// A hermetic copy of a shipped example: tests must not write into the
    /// repository, and a plugin's own folder is the only place it may write.
    fn copied_example(name: &str) -> PathBuf {
        fn copy(from: &Path, to: &Path) {
            std::fs::create_dir_all(to).unwrap();
            for entry in std::fs::read_dir(from).unwrap().flatten() {
                let target = to.join(entry.file_name());
                if entry.path().is_dir() {
                    copy(&entry.path(), &target);
                } else {
                    std::fs::copy(entry.path(), &target).unwrap();
                }
            }
        }
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/plugins")
            .join(name);
        let dir =
            std::env::temp_dir().join(format!("lilo-example-{name}-{}", uuid::Uuid::new_v4()));
        let _ = std::fs::remove_dir_all(&dir);
        copy(&source, &dir);
        dir
    }

    #[tokio::test]
    async fn the_hello_example_answers() {
        let dir = copied_example("hello");
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.lilo.hello"), "hello.js", &[]).unwrap();
        let result = plugin
            .invoke("hello_greet", &serde_json::json!({ "name": "Ada" }))
            .await
            .unwrap();
        assert_eq!(result["greeting"], "hello, Ada");

        // The settings are real: they change the answer.
        plugin
            .configure(serde_json::json!({ "greeting": "olá", "loud": true }))
            .await
            .unwrap();
        let result = plugin
            .invoke("hello_greet", &serde_json::json!({ "name": "Ada" }))
            .await
            .unwrap();
        assert_eq!(result["greeting"], "OLÁ, ADA");
    }

    #[tokio::test]
    async fn the_notes_example_saves_lists_and_bounds() {
        let dir = copied_example("notes");
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.lilo.notes"), "notes.js", &[]).unwrap();
        plugin
            .configure(serde_json::json!({ "max": 2 }))
            .await
            .unwrap();

        for text in ["primeira", "segunda", "terceira"] {
            plugin
                .invoke("notes_add", &serde_json::json!({ "text": text }))
                .await
                .unwrap();
        }
        let listed = plugin
            .invoke("notes_list", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(listed["count"], 2, "the oldest note is dropped past max");
        assert_eq!(listed["notes"][1], "terceira");

        let cleared = plugin
            .invoke("notes_clear", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(cleared["cleared"], 2);
    }

    #[tokio::test]
    async fn test_context_tool_is_declared_and_reads_fresh_memory() {
        let dir = plugin_dir(
            "context",
            r#"
            let memory = "first";
            function describe() { return { tools: [{name: "memory"}], contextTool: "memory" }; }
            function invoke() { return { context: memory }; }
            function configure() { memory = "updated"; }
        "#,
        );
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.test.context"), "plugin.js", &[]).unwrap();
        assert_eq!(plugin.context_tool().as_deref(), Some("memory"));
        plugin.configure(serde_json::json!({})).await.unwrap();
        let context = plugin
            .invoke("memory", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(context["context"], "updated");
        let mut registry = super::super::registry::ToolRegistry::new();
        registry.register(std::sync::Arc::new(plugin)).unwrap();
        let notes = registry.context_notes().await;
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].1, "updated");
    }

    #[tokio::test]
    async fn test_study_improvement_request_routes_to_the_existing_language() {
        let dir = copied_example("study");
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.lilo.study"), "study.js", &[]).unwrap();
        let mut registry =
            crate::commands::registry::Registry::with_locales("lilo", &["pt".into()]);
        registry.register(plugin.commands()).unwrap();
        for utterance in [
            "quero melhorar meu inglês",
            "Lilo, quero melhorar o meu ingles",
        ] {
            let intent = registry
                .match_utterance(utterance)
                .expect("an improvement request starts study");
            assert_eq!(intent.tool.as_deref(), Some("study_start"));
            let result = plugin
                .invoke("study_start", &serde_json::to_value(&intent.args).unwrap())
                .await
                .unwrap();
            let context: Value = serde_json::from_str(result["context"].as_str().unwrap()).unwrap();
            assert_eq!(context["targetLanguage"], "English");
        }
    }

    #[tokio::test]
    async fn test_js_shutdown_callback_flushes_plugin_data() {
        let dir = plugin_dir(
            "shutdowncallback",
            r#"
            function describe() { return {tools: []}; }
            function shutdown() { lilo.write("checkpoint.json", JSON.stringify({saved: true})); }
        "#,
        );
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.test.shutdown"), "plugin.js", &[]).unwrap();
        plugin.shutdown().await;
        let saved = std::fs::read_to_string(dir.join("data/checkpoint.json"))
            .expect("JavaScript shutdown must flush data");
        assert_eq!(
            serde_json::from_str::<Value>(&saved).unwrap()["saved"],
            true
        );
    }

    #[tokio::test]
    async fn the_gallery_example_keeps_lists_and_deletes_pictures() {
        let dir = copied_example("gallery");
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.lilo.gallery"), "gallery.js", &[]).unwrap();
        let (bus, mut events) = super::super::bus::EventBus::new();
        plugin.set_publisher(bus.publisher("com.lilo.gallery"));
        assert_eq!(plugin.subscriptions(), vec!["image.created".to_string()]);

        let created = |id: &str, mime: &str| super::super::bus::Event {
            topic: "image.created".into(),
            payload: serde_json::json!({
                "id": id, "prompt": "a red fox", "mime": mime, "data": "iVBORw0KGgo=",
                "provider": "grok-web", "createdAt": 1_790_000_000_000u64,
            }),
            source: "host".into(),
        };
        plugin.on_event(&created("img-1", "image/png")).await;
        // The host re-delivers its last picture after a restart: kept once.
        plugin.on_event(&created("img-1", "image/png")).await;
        // A format the host would not draw is not kept.
        plugin.on_event(&created("img-2", "image/svg+xml")).await;

        let changed = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("an open gallery is told to re-read")
            .unwrap();
        assert_eq!(changed.topic, "gallery.changed");

        // "create an image of …" asks the live session's backend to draw it.
        let asked = plugin
            .invoke(
                "gallery_create",
                &serde_json::json!({ "prompt": " a blue whale " }),
            )
            .await
            .unwrap();
        assert_eq!(asked["imagine"]["prompt"], "a blue whale");
        let empty = plugin
            .invoke("gallery_create", &serde_json::json!({ "prompt": "  " }))
            .await
            .unwrap();
        assert!(empty.get("imagine").is_none());

        let listed = plugin
            .invoke("gallery_list", &serde_json::json!({}))
            .await
            .unwrap();
        let items = listed["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["label"], "a red fox");
        assert_eq!(items[0]["image"]["file"], "img/img-1.b64");
        // The host draws the row's picture from the plugin's own data/.
        let root = dir.parent().unwrap();
        let id = dir.file_name().unwrap().to_str().unwrap();
        assert_eq!(
            super::super::images::data_url(root, id, "img/img-1.b64", "image/png").unwrap(),
            "data:image/png;base64,iVBORw0KGgo="
        );

        // "show me the image" names the stored picture for the host to draw.
        let shown = plugin
            .invoke("gallery_show", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(shown["summary"], "showing the picture: a red fox");
        let show = loop {
            let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
                .await
                .expect("the host is told which picture to show")
                .unwrap();
            if event.topic == "image.show" {
                break event;
            }
        };
        assert_eq!(show.payload["file"], "img/img-1.b64");
        assert_eq!(show.payload["mime"], "image/png");

        let deleted = plugin
            .invoke("gallery_delete", &serde_json::json!({ "id": "img-1" }))
            .await
            .unwrap();
        assert_eq!(deleted["summary"], "deleted the picture");
        let listed = plugin
            .invoke("gallery_list", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(listed["items"].as_array().unwrap().len(), 0);
        assert_eq!(
            std::fs::read_to_string(dir.join("data/img/img-1.b64")).unwrap(),
            ""
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn the_history_example_records_lists_and_replays() {
        let dir = copied_example("history");
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.lilo.history"), "history.js", &[]).unwrap();
        let (bus, mut events) = super::super::bus::EventBus::new();
        plugin.set_publisher(bus.publisher("com.lilo.history"));
        assert_eq!(plugin.subscriptions(), vec!["media.playing".to_string()]);
        assert_eq!(plugin.ui().list.as_ref().unwrap().tool, "history_list");

        let playing = |id: &str, title: &str| super::super::bus::Event {
            topic: "media.playing".into(),
            payload: serde_json::json!({ "id": id, "title": title, "artist": "Alex Warren" }),
            source: "core.media".into(),
        };
        plugin.on_event(&playing("a", "Ordinary")).await;
        // Re-announced while still at the top: one play, not two.
        plugin.on_event(&playing("a", "Ordinary")).await;
        plugin.on_event(&playing("b", "Carry You Home")).await;

        let changed = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("an open page is told to re-read")
            .unwrap();
        assert_eq!(changed.topic, "history.changed");

        let listed = plugin
            .invoke("history_list", &serde_json::json!({}))
            .await
            .unwrap();
        let items = listed["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["label"], "Carry You Home", "newest first");
        assert_eq!(items[1]["action"]["tool"], "history_replay");
        assert_eq!(items[1]["action"]["args"]["index"], 1);
        assert_eq!(items[0]["deleteAction"]["tool"], "history_remove");

        let replay = plugin
            .invoke("history_replay", &serde_json::json!({ "index": 1 }))
            .await
            .unwrap();
        assert_eq!(replay["play"]["track"], "Ordinary");
        assert_eq!(replay["play"]["artist"], "Alex Warren");

        let remove_args = items[0]["deleteAction"]["args"].clone();
        plugin.invoke("history_remove", &remove_args).await.unwrap();
        let after_remove = plugin
            .invoke("history_list", &serde_json::json!({}))
            .await
            .unwrap();
        let remaining = after_remove["items"].as_array().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0]["label"], "Ordinary");

        plugin
            .invoke("history_clear", &serde_json::json!({}))
            .await
            .unwrap();
        let empty = plugin
            .invoke("history_list", &serde_json::json!({}))
            .await
            .unwrap();
        assert!(empty["items"].as_array().unwrap().is_empty());
        let missing = plugin
            .invoke("history_replay", &serde_json::json!({ "index": 0 }))
            .await
            .unwrap();
        assert!(
            missing.get("play").is_none(),
            "nothing to replay asks for nothing"
        );
    }

    #[tokio::test]
    async fn the_pomodoro_example_runs_a_timer() {
        let dir = copied_example("pomodoro");
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.lilo.pomodoro"), "pomodoro.js", &[]).unwrap();
        let (bus, mut events) = super::super::bus::EventBus::new();
        plugin.set_publisher(bus.publisher("com.lilo.pomodoro"));

        for tool in [
            "pomodoro_start",
            "pomodoro_break",
            "pomodoro_stop",
            "pomodoro_status",
            "pomodoro_pause",
            "pomodoro_resume",
            "pomodoro_skip",
        ] {
            assert!(plugin.handles(tool), "{tool}");
        }
        assert!(plugin
            .commands()
            .iter()
            .any(|command| command.name == "pomodoro.start"));

        let idle = plugin
            .invoke("pomodoro_status", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(idle["phase"], "idle");

        let started = plugin
            .invoke("pomodoro_start", &serde_json::json!({ "minutes": 50 }))
            .await
            .unwrap();
        assert_eq!(started["minutes"], 50);
        assert_eq!(
            started["endSession"], true,
            "starting a focus ends the voice call"
        );

        let shown = loop {
            let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
                .await
                .expect("the countdown reaches the status bar")
                .unwrap();
            if event.topic == "statusbar" && event.payload.get("label").is_some() {
                break event;
            }
        };
        assert_eq!(shown.payload["label"], "Focus");
        assert!(shown.payload["endsAt"].as_i64().unwrap() > now_ms() as i64 / 1000 + 2900);

        let again = plugin
            .invoke("pomodoro_start", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(
            again["alreadyRunning"], true,
            "a misheard start never restarts a focus"
        );
        assert!(
            again.get("endSession").is_none(),
            "and never hangs up on the user"
        );

        let paused = plugin
            .invoke("pomodoro_pause", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(paused["paused"], true);
        let resumed = plugin
            .invoke("pomodoro_resume", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(resumed["phase"], "focus");
        assert!(
            resumed["secondsLeft"].as_i64().unwrap() > 2900,
            "resuming keeps the time left"
        );

        let stopped = plugin
            .invoke("pomodoro_stop", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(stopped["phase"], "idle");
        let cleared = loop {
            let event = tokio::time::timeout(Duration::from_secs(3), events.recv())
                .await
                .expect("stopping clears the status bar")
                .unwrap();
            if event.topic == "statusbar" && event.payload.get("label").is_none() {
                break event;
            }
        };
        assert_eq!(cleared.payload, serde_json::json!({}));
    }

    /// The one door to the machine: a bare name the manifest declared, no
    /// shell, and nothing else.
    #[tokio::test]
    #[cfg(unix)]
    async fn exec_reaches_only_the_declared_binaries() {
        let dir = plugin_dir(
            "exec",
            r#"
            function describe() { return { tools: [{ name: "run" }] }; }
            function invoke(tool, args) {
              const result = lilo.exec(args.program, args.args || []);
              return { code: result.code, out: result.stdout.trim() };
            }
            "#,
        );
        let mut declared = manifest("com.test.exec");
        declared.capabilities = vec!["exec:echo".to_string()];
        let plugin = QuickJsPlugin::start(&dir, declared, "plugin.js", &[]).unwrap();

        let ok = plugin
            .invoke(
                "run",
                &serde_json::json!({ "program": "echo", "args": ["hi there"] }),
            )
            .await
            .unwrap();
        assert_eq!(ok["code"], 0);
        assert_eq!(ok["out"], "hi there");
        let _ = std::fs::remove_dir_all(dir);

        // A binary the manifest did not declare throws; a path is never a
        // declared name, however it is spelled.
        let dir = plugin_dir(
            "exec-refused",
            r#"
            function describe() { return { tools: [{ name: "run" }] }; }
            function invoke(tool, args) { return lilo.exec(args.program, []); }
            "#,
        );
        let mut declared = manifest("com.test.exec.refused");
        declared.capabilities = vec!["exec:echo".to_string()];
        let plugin = QuickJsPlugin::start(&dir, declared, "plugin.js", &[]).unwrap();
        for program in ["sh", "/bin/echo", "../echo"] {
            let error = plugin
                .invoke("run", &serde_json::json!({ "program": program }))
                .await
                .unwrap_err();
            assert!(
                error.to_string().contains("not declared"),
                "{program}: {error}"
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn scratch_names_cannot_escape_the_scratch_folder() {
        let dir = std::env::temp_dir().join(format!("lilo-scratch-{}", uuid::Uuid::new_v4()));
        assert!(scratch_path(&dir, "shot.jpg").is_ok());
        assert!(scratch_path(&dir, "").is_err());
        assert!(scratch_path(&dir, "../shot.jpg").is_err());
        assert!(scratch_path(&dir, "sub/shot.jpg").is_err());
        assert!(scratch_path(&dir, "/etc/shot.jpg").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn the_script_sees_the_platform_constant() {
        let dir = plugin_dir(
            "platform",
            r#"
            function describe() { return { tools: [{ name: "p" }] }; }
            function invoke() { return { os: lilo.platform }; }
            "#,
        );
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.test.platform"), "plugin.js", &[]).unwrap();
        let result = plugin.invoke("p", &serde_json::json!({})).await.unwrap();
        assert_eq!(result["os"], std::env::consts::OS);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The bytes path: a tool writes into the scratch folder, the script reads
    /// them back as base64 — the only way binary output crosses into JS.
    #[tokio::test]
    #[cfg(unix)]
    async fn a_script_reads_bytes_a_tool_wrote_to_its_scratch_folder() {
        let dir = plugin_dir(
            "scratch",
            r#"
            function describe() { return { tools: [{ name: "shot" }] }; }
            function invoke() {
              const path = lilo.temp("copy.bin");
              const result = lilo.exec("cp", ["/etc/hosts", path]);
              if (result.code !== 0) throw new Error("cp failed");
              return { base64: lilo.readBase64(path) };
            }
            "#,
        );
        let mut declared = manifest("com.test.scratch");
        declared.capabilities = vec!["exec:cp".to_string()];
        let plugin = QuickJsPlugin::start(&dir, declared, "plugin.js", &[]).unwrap();
        let result = plugin.invoke("shot", &serde_json::json!({})).await.unwrap();
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(result["base64"].as_str().unwrap())
            .unwrap();
        assert_eq!(bytes, std::fs::read("/etc/hosts").unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn read_base64_refuses_files_outside_the_scratch_folder() {
        let dir = plugin_dir(
            "scratch-refuse",
            r#"
            function describe() { return { tools: [{ name: "read" }] }; }
            function invoke(tool, args) { return { data: lilo.readBase64(args.path) }; }
            "#,
        );
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.test.scratch.refuse"), "plugin.js", &[])
                .unwrap();
        let error = plugin
            .invoke("read", &serde_json::json!({ "path": "/etc/hosts" }))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("scratch"), "{error}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The screen example: one `.js` file for every OS, reaching the machine
    /// only through the binaries the manifest declares. `describe` is
    /// exercised; `invoke` never runs — it would photograph the machine.
    #[tokio::test]
    async fn the_screen_example_declares_its_tool_and_permission_action() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins/screen");
        let file: super::super::loader::PluginFile =
            serde_json::from_str(&std::fs::read_to_string(dir.join("plugin.json")).unwrap())
                .unwrap();
        assert_eq!(file.runtime, "quickjs", "one file covers every OS");
        let plugin = QuickJsPlugin::start(
            &dir,
            file.manifest(),
            file.entry_for_this_platform(),
            &file.args,
        )
        .expect("the screen plugin must start");

        assert!(plugin.handles("screen_look"));
        assert!(plugin.handles("screen_permission"));
        let commands = plugin.commands();
        let look = commands
            .iter()
            .find(|command| command.name == "screen.look")
            .expect("screen.look");
        assert_eq!(look.tool.as_deref(), Some("screen_look"));
        assert!(!look.requires_confirm, "looking should never ask twice");
        assert!(!look.templates.is_empty());
        // The plugin's own Settings page carries the permission action.
        assert!(
            plugin
                .ui()
                .actions
                .iter()
                .any(|action| action.tool == "screen_permission"),
            "the Screen page must own the permission"
        );
    }

    /// The real restart: a focus was running when the plugin stopped, and the
    /// script announces it again while loading. This is what used to fail the
    /// load ("not declared in the plugin's publishes").
    #[tokio::test]
    async fn the_pomodoro_example_rearms_a_running_timer_at_load() {
        let dir = copied_example("pomodoro");
        std::fs::create_dir_all(dir.join("data")).unwrap();
        let ends = now_ms() / 1000 + 600;
        std::fs::write(
            dir.join("data/state.json"),
            format!(r#"{{"phase":"focus","ends":{ends},"round":1,"paused":false,"left":0}}"#),
        )
        .unwrap();

        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.lilo.pomodoro"), "pomodoro.js", &[]).unwrap();
        let (bus, mut events) = super::super::bus::EventBus::new();
        plugin.set_publisher(bus.publisher("com.lilo.pomodoro"));

        let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .expect("re-arming must reach the status bar")
            .unwrap();
        assert_eq!(event.topic, "statusbar");
        assert_eq!(event.payload["label"], "Focus");
        // JavaScript numbers are doubles; compare the value, not the repr.
        assert_eq!(
            event.payload["endsAt"].as_f64().map(|value| value as i64),
            Some(ends as i64)
        );
    }

    #[tokio::test]
    async fn an_endless_loop_is_interrupted() {
        let dir = plugin_dir(
            "loop",
            r#"
            function describe() { return { tools: [{ name: "spin" }] }; }
            function invoke() { while (true) {} }
            "#,
        );
        let plugin =
            QuickJsPlugin::start(&dir, manifest("com.test.loop"), "plugin.js", &[]).unwrap();
        // The load-time budget is 10s; prove the interrupt fires by shrinking
        // the per-call budget for this test would need a knob. Instead the call
        // uses the real budget, so this only asserts it is bounded, not fast.
        let result = plugin.invoke("spin", &serde_json::json!({})).await;
        assert!(result.is_err(), "an endless loop must not return a value");
    }
}
