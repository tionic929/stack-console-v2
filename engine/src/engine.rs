//! The supervisor: one task owns all state (config, runtime, logs) and handles requests, process
//! output, exits and timers in order. Reference behaviour: `executionEngineStart` / `Stop`,
//! `markExited`, `handleCrashPolicy`, the start-order code and `detectReady` in `main.js`.

use crate::config::{ConfigStore, LoadNote, SaveError};
use crate::env::{EnvSummary, build_command_env, describe_env, mask_secrets};
use crate::lines::LineSplitter;
use crate::logs::{LogBuffer, LogLine, Stream, find_local_url, strip_ansi};
use crate::model::{Command, Database, EnvEntry};
use crate::process::{self, Kill, ProcessGroup, SpawnSpec};
use crate::secrets::SecretStore;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, mpsc, oneshot};

mod handlers;
mod watch;
pub use handlers::SHELL_PROJECT;

// ── Public types ─────────────────────────────────────────────────

/// Which service. `command_id: None` is the shared shell.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub project_id: String,
    pub command_id: Option<String>,
}

impl Target {
    pub fn new(project_id: impl Into<String>, command_id: impl Into<String>) -> Self {
        Target { project_id: project_id.into(), command_id: Some(command_id.into()) }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    #[default]
    Offline,
    Waiting,
    Starting,
    Running,
    Crashed,
}

impl Status {
    pub fn live(self) -> bool {
        matches!(self, Status::Running | Status::Starting | Status::Waiting)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EnvBadge {
    pub count: usize,
    pub file: Option<String>,
    pub secrets: usize,
}

/// What changes while a service runs. Never saved.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    pub status: Status,
    pub pid: Option<u32>,
    pub started_at: Option<u64>,
    pub url: Option<String>,
    /// A string, as the interface compares it with the configured port text.
    pub detected_port: Option<String>,
    pub exit_code: Option<i64>,
    pub ready: bool,
    pub waiting_for: Option<String>,
    pub blocked_by: Option<String>,
    pub restart_attempt: Option<u32>,
    pub restart_gave_up: bool,
    pub env_summary: Option<EnvBadge>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub project_id: String,
    pub command_id: Option<String>,
    #[serde(flatten)]
    pub line: LogLine,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    pub project_id: String,
    pub command_id: Option<String>,
    #[serde(flatten)]
    pub runtime: Runtime,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeKind {
    Crashed,
    RestartPaused,
    ConfigRecovered,
    ConfigReadOnly,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub kind: NoticeKind,
    pub project_id: Option<String>,
    pub command_id: Option<String>,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    /// Batched log lines (F2).
    Logs { lines: Vec<LogEvent> },
    /// Services whose runtime changed since the last event (F1).
    Runtime { services: Vec<RuntimeEvent> },
    ConfigChanged { revision: u64 },
    /// Something derived from disk changed (a folder appeared or went, a git branch, a master folder scan).
    FoldersChanged {},
    Notice(Notice),
}

/// Timings. The defaults are the app's; tests shorten them.
#[derive(Debug, Clone)]
pub struct Timings {
    /// Log lines and runtime changes are sent at most this often.
    pub flush: Duration,
    /// Text with no newline is sent after this much quiet.
    pub idle_line: Duration,
    /// Stop: time between the polite signal and the forced kill.
    pub stop_grace: Duration,
    /// Start order: give up waiting for a dependency after this long.
    pub wait_timeout: Duration,
    /// A run this long resets the crash-loop counter.
    pub stable_run: Duration,
    /// Restart delay unit: attempt n waits min(30, 2^n) units.
    pub restart_unit: Duration,
    /// How often a dependency's port is probed while something waits on it.
    pub ready_probe: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Timings {
            flush: Duration::from_millis(50),
            idle_line: Duration::from_millis(150),
            stop_grace: Duration::from_secs(3),
            wait_timeout: Duration::from_secs(60),
            stable_run: Duration::from_secs(60),
            restart_unit: Duration::from_secs(1),
            ready_probe: Duration::from_secs(1),
        }
    }
}

pub struct EngineOptions {
    pub data_dir: PathBuf,
    pub secrets: Arc<dyn SecretStore>,
    pub timings: Timings,
    /// Folder for the shell when no project folder applies.
    pub home_dir: Option<PathBuf>,
}

#[derive(Debug)]
pub struct EngineGone;

impl std::fmt::Display for EngineGone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the engine has stopped")
    }
}

impl std::error::Error for EngineGone {}

/// Handle to the engine. Cheap to clone; every method is a message to the engine task.
#[derive(Clone)]
pub struct Engine {
    tx: mpsc::UnboundedSender<Msg>,
    events: broadcast::Sender<Event>,
}

impl Engine {
    /// Loads the config and starts the engine task on the current tokio runtime.
    pub fn start(opts: EngineOptions) -> std::io::Result<(Engine, Vec<LoadNote>)> {
        let (store, notes) = ConfigStore::open(&opts.data_dir)?;
        let (tx, rx) = mpsc::unbounded_channel();
        let (events, _) = broadcast::channel(4096);
        let core = Core {
            timings: opts.timings,
            secrets: opts.secrets,
            home_dir: opts.home_dir,
            store,
            services: HashMap::new(),
            tx: tx.clone(),
            events: events.clone(),
            pending_logs: Vec::new(),
            dirty: BTreeSet::new(),
            flush_at: None,
            next_token: 0,
            shutdown_waiters: Vec::new(),
            pending_specs: HashMap::new(),
            root_scans: HashMap::new(),
            scanning: std::collections::HashSet::new(),
            pending_root_pick: None,
            active_command_to_edit: None,
            last_port_check: None,
            folder_signature: String::new(),
            watch: watch::Watching::new(),
        };
        tokio::spawn(core.run(rx));
        let _ = tx.send(Msg::Call(Box::new(|c: &mut Core| c.start_watching())));
        Ok((Engine { tx, events }, notes))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    async fn call<R: Send + 'static>(&self, f: impl FnOnce(&mut Core) -> R + Send + 'static) -> Result<R, EngineGone> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Msg::Call(Box::new(move |core| {
                let _ = tx.send(f(core));
            })))
            .map_err(|_| EngineGone)?;
        rx.await.map_err(|_| EngineGone)
    }

    /// Starts a service. `now` skips its start order.
    pub async fn start_service(&self, t: Target, now: bool) -> Result<(), String> {
        self.call(move |c| c.request_start(&t, now)).await.map_err(|e| e.to_string())?
    }

    /// Stops a service. Returns at once; the process tree is ended in the background.
    pub async fn stop_service(&self, t: Target) -> Result<(), String> {
        self.call(move |c| c.request_stop(&t)).await.map_err(|e| e.to_string())?
    }

    pub async fn restart_service(&self, t: Target) -> Result<(), String> {
        self.call(move |c| {
            c.request_stop(&t)?;
            c.request_start(&t, true)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn start_project(&self, project_id: String) -> Result<(), String> {
        self.call(move |c| {
            for t in c.project_targets(&project_id)? {
                c.start(&t, StartOpts::default());
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn stop_project(&self, project_id: String) -> Result<(), String> {
        self.call(move |c| {
            for t in c.project_targets(&project_id)? {
                c.stop(&t);
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Stops every service that is running, starting or waiting, in every project.
    pub async fn stop_everything(&self) -> Result<(), EngineGone> {
        self.call(|c| c.stop_everything()).await
    }

    /// Types a line into a running service or the shell.
    pub async fn send_input(&self, t: Target, text: String) -> Result<(), String> {
        self.call(move |c| c.send_input(&t, &text)).await.map_err(|e| e.to_string())?
    }

    pub async fn logs(&self, t: Target) -> Result<(u64, Vec<LogLine>), EngineGone> {
        self.call(move |c| c.services.get(&t).map(|s| (s.logs.seq(), s.logs.lines())).unwrap_or((0, Vec::new())))
            .await
    }

    pub async fn clear_logs(&self, t: Target) -> Result<(), EngineGone> {
        self.call(move |c| {
            if let Some(s) = c.services.get_mut(&t) {
                s.logs.clear();
            }
        })
        .await
    }

    pub async fn status(&self) -> Result<Vec<RuntimeEvent>, EngineGone> {
        self.call(|c| {
            let mut v: Vec<RuntimeEvent> = c.services.iter().map(|(t, s)| c.runtime_event(t, s)).collect();
            v.sort_by(|a, b| (&a.project_id, &a.command_id).cmp(&(&b.project_id, &b.command_id)));
            v
        })
        .await
    }

    pub async fn config(&self) -> Result<Database, EngineGone> {
        self.call(|c| c.store.db().clone()).await
    }

    /// Applies a change to the config and saves it. Services whose command disappeared are stopped.
    pub async fn update_config(&self, f: impl FnOnce(&mut Database) + Send + 'static) -> Result<(), String> {
        self.call(move |c| c.update_config(f)).await.map_err(|e| e.to_string())?
    }

    /// Stops everything and waits until every process tree is gone, at most `timeout`; whatever is
    /// left after that is killed. Used on every quit path (P4).
    pub async fn shutdown(&self, timeout: Duration) {
        let (tx, rx) = oneshot::channel();
        let sent = self.call(move |c| {
            c.stop_everything();
            c.shutdown_waiters.push(tx);
            c.check_shutdown();
        });
        if sent.await.is_err() {
            return;
        }
        if tokio::time::timeout(timeout, rx).await.is_err() {
            let _ = self.call(|c| c.force_kill_all()).await;
        }
    }
}

// ── Engine task ──────────────────────────────────────────────────

enum Msg {
    Call(Box<dyn FnOnce(&mut Core) + Send>),
    Output { t: Target, run: u64, data: Vec<u8> },
    Exited { t: Target, run: u64, code: Option<i64> },
    Timer { t: Target, token: u64, kind: TimerKind },
}

#[derive(Debug)]
enum TimerKind {
    /// Startup delay over: spawn now.
    Spawn,
    /// Crash-restart delay over.
    Restart,
    /// Start order: the dependency took too long.
    WaitTimeout,
    /// Stop grace period over: kill what is left of this run.
    ForceKill { run: u64 },
    /// Result of probing the dependency's port.
    ReadyProbe { open: bool },
}

struct Run {
    id: u64,
    #[allow(dead_code)] // for port-free: "that process belongs to StackConsole"
    pid: u32,
    group: Arc<ProcessGroup>,
    writer: Box<dyn Write + Send>,
    /// Stopped by the user; its exit is not a crash.
    stopping: bool,
    started: Instant,
    _master: Box<dyn portable_pty::MasterPty + Send>,
}

struct Waiter {
    dep: Target,
    dep_name: String,
    token: u64,
}

#[derive(Default)]
struct Service {
    rt: Runtime,
    logs: LogBuffer,
    run: Option<Run>,
    /// A start waiting on its delay or a crash restart: (token, is_restart).
    pending: Option<(u64, bool)>,
    waiter: Option<Waiter>,
    restart_attempts: u32,
    ready_pattern: String,
    secrets: Vec<String>,
    splitter: LineSplitter,
    last_output: Option<Instant>,
    /// Start again once the run being stopped has exited (restart, or start right after stop).
    start_after_exit: bool,
    ready_probe: Option<u64>,
}

#[derive(Default, Clone)]
struct StartOpts {
    force: bool,
    is_restart: bool,
}

struct Core {
    timings: Timings,
    secrets: Arc<dyn SecretStore>,
    home_dir: Option<PathBuf>,
    store: ConfigStore,
    services: HashMap<Target, Service>,
    tx: mpsc::UnboundedSender<Msg>,
    events: broadcast::Sender<Event>,
    pending_logs: Vec<LogEvent>,
    dirty: BTreeSet<Target>,
    flush_at: Option<Instant>,
    next_token: u64,
    shutdown_waiters: Vec<oneshot::Sender<()>>,
    /// Spawns waiting on their startup delay.
    pending_specs: HashMap<Target, SpawnSpec>,
    /// Master folder scans by root key, and the roots being scanned right now.
    root_scans: HashMap<String, serde_json::Value>,
    scanning: std::collections::HashSet<String>,
    /// A folder the app's picker returned, waiting for the window to confirm what to do with it.
    pending_root_pick: Option<handlers::RootPick>,
    /// Which command the Edit window opens (a UI hint, kept in memory only).
    active_command_to_edit: Option<String>,
    /// The only pid `portFree` may stop: (pid, when it was seen).
    last_port_check: Option<(u32, Instant)>,
    /// Folder existence + git HEADs at the last check, to tell whether anything changed.
    folder_signature: String,
    watch: watch::Watching,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Core {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Msg>) {
        loop {
            let msg = match self.flush_at {
                Some(at) => tokio::select! {
                    m = rx.recv() => m,
                    _ = tokio::time::sleep_until(at.into()) => { self.flush(); continue; }
                },
                None => rx.recv().await,
            };
            match msg {
                None => break,
                Some(Msg::Call(f)) => f(&mut self),
                Some(Msg::Output { t, run, data }) => self.on_output(&t, run, &data),
                Some(Msg::Exited { t, run, code }) => self.on_exit(&t, run, code),
                Some(Msg::Timer { t, token, kind }) => self.on_timer(&t, token, kind),
            }
        }
    }

    fn token(&mut self) -> u64 {
        self.next_token += 1;
        self.next_token
    }

    fn after(&self, delay: Duration, t: &Target, token: u64, kind: TimerKind) {
        let tx = self.tx.clone();
        let t = t.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let _ = tx.send(Msg::Timer { t, token, kind });
        });
    }

    fn want_flush(&mut self, at: Instant) {
        self.flush_at = Some(match self.flush_at {
            Some(existing) if existing <= at => existing,
            _ => at,
        });
    }

    // ── Logs and runtime ─────────────────────────────────────────

    fn append_log(&mut self, t: &Target, text: &str, stream: Stream) {
        if text.is_empty() {
            return;
        }
        let svc = self.services.entry(t.clone()).or_default();
        let text = mask_secrets(text, &svc.secrets);
        let line = svc.logs.push(now_ms(), stream, text.clone());
        self.pending_logs.push(LogEvent { project_id: t.project_id.clone(), command_id: t.command_id.clone(), line });
        self.want_flush(Instant::now() + self.timings.flush);
        if t.command_id.is_some() && matches!(stream, Stream::Stdout | Stream::Stderr) {
            self.detect_ready(t, &text);
        }
    }

    fn system(&mut self, t: &Target, text: &str) {
        self.append_log(t, text, Stream::System);
    }

    fn set_runtime(&mut self, t: &Target, f: impl FnOnce(&mut Runtime)) {
        let svc = self.services.entry(t.clone()).or_default();
        let before = svc.rt.clone();
        f(&mut svc.rt);
        if svc.rt != before {
            self.dirty.insert(t.clone());
            self.want_flush(Instant::now() + self.timings.flush);
        }
    }

    fn status_of(&self, t: &Target) -> Status {
        self.services.get(t).map(|s| s.rt.status).unwrap_or_default()
    }

    fn runtime_event(&self, t: &Target, s: &Service) -> RuntimeEvent {
        RuntimeEvent { project_id: t.project_id.clone(), command_id: t.command_id.clone(), runtime: s.rt.clone() }
    }

    fn emit(&self, e: Event) {
        let _ = self.events.send(e);
    }

    /// Sends batched logs and coalesced runtime changes; sends quiet partial lines.
    fn flush(&mut self) {
        self.flush_at = None;
        let now = Instant::now();
        let idle = self.timings.idle_line;
        let mut partial: Vec<(Target, String)> = Vec::new();
        let mut next_partial: Option<Instant> = None;
        for (t, s) in self.services.iter_mut() {
            if !s.splitter.has_partial() {
                continue;
            }
            let due = s.last_output.map(|at| at + idle).unwrap_or(now);
            if due <= now {
                if let Some(text) = s.splitter.flush_partial() {
                    partial.push((t.clone(), text));
                }
            } else {
                next_partial = Some(next_partial.map_or(due, |n: Instant| n.min(due)));
            }
        }
        for (t, text) in partial {
            self.append_log(&t, &text, Stream::Stdout);
        }
        if !self.pending_logs.is_empty() {
            let lines = std::mem::take(&mut self.pending_logs);
            self.emit(Event::Logs { lines });
        }
        if !self.dirty.is_empty() {
            let dirty = std::mem::take(&mut self.dirty);
            let services = dirty
                .iter()
                .filter_map(|t| self.services.get(t).map(|s| self.runtime_event(t, s)))
                .collect();
            self.emit(Event::Runtime { services });
        }
        // append_log above may have asked for another flush; keep the earliest
        self.flush_at = None;
        if let Some(at) = next_partial {
            self.want_flush(at);
        }
        if !self.pending_logs.is_empty() || !self.dirty.is_empty() {
            self.want_flush(now + self.timings.flush);
        }
    }

    // ── Ready detection ──────────────────────────────────────────

    /// Ready = the service printed its local URL, or the command's own ready line.
    fn detect_ready(&mut self, t: &Target, text: &str) {
        let Some(svc) = self.services.get(t) else { return };
        if !matches!(svc.rt.status, Status::Running | Status::Starting) || (svc.rt.url.is_some() && svc.rt.ready) {
            return;
        }
        let plain = strip_ansi(text);
        let found = if svc.rt.url.is_none() { find_local_url(&plain) } else { None };
        let has_url = found.is_some() || svc.rt.url.is_some();
        let pattern = svc.ready_pattern.clone();
        let becomes_ready =
            !svc.rt.ready && if pattern.is_empty() { has_url } else { plain.to_lowercase().contains(&pattern) };
        if found.is_none() && !becomes_ready {
            return;
        }
        self.set_runtime(t, |rt| {
            if let Some((url, port)) = found {
                rt.url = Some(url);
                rt.detected_port = Some(port.to_string());
            }
            if becomes_ready {
                rt.ready = true;
            }
        });
        if becomes_ready {
            self.release_waiters(t);
        }
    }

    // ── Start ────────────────────────────────────────────────────

    fn command_for(&self, t: &Target) -> Option<(Option<String>, Command)> {
        let cid = t.command_id.as_deref()?;
        let (p, c) = self.store.db().command(&t.project_id, cid)?;
        Some((p.base_dir().map(str::to_string), c.clone()))
    }

    fn project_targets(&self, project_id: &str) -> Result<Vec<Target>, String> {
        let p = self.store.db().project(project_id).ok_or("Unknown project.")?;
        Ok(p.commands.iter().map(|c| Target::new(&p.id, &c.id)).collect())
    }

    fn request_start(&mut self, t: &Target, now: bool) -> Result<(), String> {
        self.command_for(t).ok_or("Unknown command.")?;
        self.start(t, StartOpts { force: now, is_restart: false });
        Ok(())
    }

    fn request_stop(&mut self, t: &Target) -> Result<(), String> {
        if t.command_id.is_some() {
            self.command_for(t).ok_or("Unknown command.")?;
        }
        self.stop(t);
        Ok(())
    }

    fn start(&mut self, t: &Target, opts: StartOpts) {
        let Some((base_dir, cmd)) = self.command_for(t) else { return };
        let svc = self.services.entry(t.clone()).or_default();
        let active = svc.run.as_ref().is_some_and(|r| !r.stopping);
        if active || svc.pending.is_some() {
            return;
        }
        if !opts.is_restart && matches!(svc.rt.status, Status::Running | Status::Starting) {
            return;
        }
        if !opts.force && svc.waiter.is_some() {
            return;
        }
        if !opts.is_restart {
            svc.restart_attempts = 0;
        }

        // Start order: wait for the dependency to be ready, and start it if it isn't running
        let dep = if opts.force { None } else { cmd.start_after().filter(|d| *d != cmd.id) };
        if let Some(dep_id) = dep {
            let dep_t = Target::new(&t.project_id, &dep_id);
            if let Some((_, dep_cmd)) = self.command_for(&dep_t) {
                if self.creates_cycle(&t.project_id, &cmd.id, &dep_id) {
                    self.system(
                        t,
                        &format!(
                            "\n[info] Start order ignored: {} and {} wait for each other. Starting right away.\n",
                            cmd.name(),
                            dep_cmd.name()
                        ),
                    );
                } else if !self.services.get(&dep_t).is_some_and(|s| s.rt.ready) {
                    let token = self.token();
                    // Register the wait first: a dependency that fails at once must find (and block) it
                    self.services.get_mut(t).unwrap().waiter =
                        Some(Waiter { dep: dep_t.clone(), dep_name: dep_cmd.name().to_string(), token });
                    self.after(self.timings.wait_timeout, t, token, TimerKind::WaitTimeout);
                    self.system(t, &format!("\n[system] Waiting for {} to be ready\n", dep_cmd.name()));
                    let dep_name = dep_cmd.name().to_string();
                    self.set_runtime(t, |rt| {
                        rt.status = Status::Waiting;
                        rt.waiting_for = Some(dep_name);
                        rt.blocked_by = None;
                        rt.exit_code = None;
                    });
                    if !self.status_of(&dep_t).live() {
                        self.start(&dep_t, StartOpts::default());
                    }
                    if self.services.get(t).is_some_and(|s| s.waiter.is_some()) {
                        self.ensure_ready_probe(&dep_t);
                    }
                    return;
                }
            }
        }
        if let Some(svc) = self.services.get_mut(t) {
            svc.waiter = None;
        }

        // The previous run is still being stopped: start once it has exited (its port is free then)
        if self.services.get(t).is_some_and(|s| s.run.as_ref().is_some_and(|r| r.stopping)) {
            self.services.get_mut(t).unwrap().start_after_exit = true;
            self.set_runtime(t, |rt| {
                rt.status = Status::Starting;
                rt.waiting_for = None;
                rt.blocked_by = None;
            });
            return;
        }

        let working_dir = resolve_working_dir(base_dir.as_deref(), cmd.working_directory.as_deref(), self.home_dir.as_deref());
        if !working_dir.is_dir() {
            self.system(
                t,
                &format!(
                    "\n[error] Folder not found: {}. Check the project folder or the command's working directory.\n",
                    working_dir.display()
                ),
            );
            self.set_runtime(t, |rt| {
                rt.status = Status::Crashed;
                rt.pid = None;
                rt.exit_code = None;
                rt.waiting_for = None;
            });
            self.block_waiters(t, "could not start");
            return;
        }

        let secrets = self.secrets.clone();
        let decrypt = move |e: &EnvEntry| -> Option<String> {
            match &e.enc {
                Some(enc) => secrets.decrypt(enc),
                None => e.value.clone(),
            }
        };
        let env = build_command_env(&cmd, &working_dir, base_dir.as_deref().map(Path::new), &decrypt);
        let note = describe_env(&env.summary);
        {
            let svc = self.services.get_mut(t).unwrap();
            svc.secrets = env.secret_values.clone();
            svc.ready_pattern = cmd.ready_pattern();
            svc.splitter = LineSplitter::new();
        }
        for w in &env.summary.warnings {
            self.system(t, &format!("[info] {w}\n"));
        }
        let env_note = if note.is_empty() { String::new() } else { format!(" (env: {note})") };
        self.system(t, &format!("\n[system] Spawning: {} inside {}{}\n", cmd.command, working_dir.display(), env_note));
        let badge = badge(&env.summary);
        self.set_runtime(t, |rt| {
            rt.status = Status::Starting;
            rt.pid = None;
            rt.started_at = None;
            rt.url = None;
            rt.detected_port = None;
            rt.exit_code = None;
            rt.ready = false;
            rt.waiting_for = None;
            rt.blocked_by = None;
            rt.restart_gave_up = false;
            rt.env_summary = badge;
        });

        let spec = SpawnSpec { command: Some(cmd.command.clone()), cwd: working_dir, env: env.vars };
        let delay = cmd.startup_delay_secs();
        if delay > 0.0 {
            let token = self.token();
            self.services.get_mut(t).unwrap().pending = Some((token, false));
            self.pending_specs.insert(t.clone(), spec);
            self.after(Duration::from_secs_f64(delay), t, token, TimerKind::Spawn);
        } else {
            self.spawn_now(t, spec);
        }
    }

    fn spawn_now(&mut self, t: &Target, spec: SpawnSpec) {
        match process::spawn(spec) {
            Ok(sp) => {
                let run_id = self.token();
                let group = Arc::new(sp.group);
                self.spawn_threads(t, run_id, sp.reader, sp.child, group.clone());
                let svc = self.services.get_mut(t).unwrap();
                svc.run = Some(Run {
                    id: run_id,
                    pid: sp.pid,
                    group,
                    writer: sp.writer,
                    stopping: false,
                    started: Instant::now(),
                    _master: sp.master,
                });
                let pid = sp.pid;
                self.set_runtime(t, |rt| {
                    rt.status = Status::Running;
                    rt.pid = Some(pid);
                    rt.started_at = Some(now_ms());
                    rt.restart_attempt = None;
                });
            }
            Err(e) => {
                // P9: a failed spawn blocks its waiters at once instead of leaving them to time out
                self.system(t, &format!("\n[error] Could not start: {e}\n"));
                self.set_runtime(t, |rt| {
                    rt.status = Status::Crashed;
                    rt.pid = None;
                });
                self.block_waiters(t, "could not start");
            }
        }
    }

    /// One thread reads the terminal; one waits for the process. The exit is reported after the
    /// output has drained (or 2 s, if something still holds the terminal open).
    fn spawn_threads(
        &self,
        t: &Target,
        run: u64,
        mut reader: Box<dyn Read + Send>,
        mut child: Box<dyn portable_pty::Child + Send + Sync>,
        group: Arc<ProcessGroup>,
    ) {
        let (eof_tx, eof_rx) = std::sync::mpsc::channel::<()>();
        let tx = self.tx.clone();
        let tt = t.clone();
        std::thread::Builder::new()
            .name("sc-read".into())
            .spawn(move || {
                let mut buf = vec![0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break, // EOF, or EIO once the terminal closes
                        Ok(n) => {
                            if tx.send(Msg::Output { t: tt.clone(), run, data: buf[..n].to_vec() }).is_err() {
                                break;
                            }
                        }
                    }
                }
                let _ = eof_tx.send(());
            })
            .expect("spawn reader thread");
        let tx = self.tx.clone();
        let tt = t.clone();
        std::thread::Builder::new()
            .name("sc-wait".into())
            .spawn(move || {
                let code = match child.wait() {
                    Ok(st) if st.signal().is_none() => Some(st.exit_code() as i64),
                    _ => None,
                };
                // Whatever the command left running (its children) goes with it, so ports are freed
                group.kill(Kill::Force);
                let _ = eof_rx.recv_timeout(Duration::from_secs(2));
                let _ = tx.send(Msg::Exited { t: tt, run, code });
            })
            .expect("spawn waiter thread");
    }

    fn on_output(&mut self, t: &Target, run: u64, data: &[u8]) {
        let Some(svc) = self.services.get_mut(t) else { return };
        if svc.run.as_ref().map(|r| r.id) != Some(run) {
            return;
        }
        let lines = svc.splitter.push(data);
        let partial = svc.splitter.has_partial();
        if partial {
            svc.last_output = Some(Instant::now());
        }
        for line in lines {
            self.append_log(t, &line, Stream::Stdout);
        }
        if partial {
            self.want_flush(Instant::now() + self.timings.idle_line);
        }
    }

    // ── Exit and crash policy ────────────────────────────────────

    fn on_exit(&mut self, t: &Target, run: u64, code: Option<i64>) {
        let Some(svc) = self.services.get_mut(t) else { return };
        if svc.run.as_ref().map(|r| r.id) != Some(run) {
            return;
        }
        let finished = svc.run.take().unwrap();
        let rest = svc.splitter.finish();
        if let Some(text) = rest {
            self.append_log(t, &text, Stream::Stdout);
        }
        if t.command_id.is_none() {
            // The shared shell
            self.system(t, "\n[info] Shell session ended. Open the shell again to start a new one.\n");
            self.set_runtime(t, |rt| *rt = Runtime::default());
            self.check_shutdown();
            return;
        }
        if finished.stopping {
            let again = std::mem::take(&mut self.services.get_mut(t).unwrap().start_after_exit);
            if again {
                self.set_runtime(t, |rt| rt.status = Status::Offline);
                self.start(t, StartOpts { force: true, is_restart: false });
            }
            self.check_shutdown();
            return;
        }

        let crashed = code != Some(0);
        match code {
            Some(0) => self.system(t, "\n[info] Process exited with code 0\n"),
            Some(c) => self.system(t, &format!("\n[error] Process exited with code {c}\n")),
            None => self.system(t, "\n[error] Process stopped unexpectedly (killed by a signal)\n"),
        }
        self.set_runtime(t, |rt| {
            rt.status = if crashed { Status::Crashed } else { Status::Offline };
            rt.pid = None;
            rt.started_at = None;
            rt.url = None;
            rt.detected_port = None;
            rt.ready = false;
            rt.exit_code = if crashed { code } else { None };
        });
        self.block_waiters(t, if crashed { "crashed" } else { "stopped" });
        if crashed {
            self.crash_policy(t, code, finished.started);
        }
        self.check_shutdown();
    }

    fn notice(&self, kind: NoticeKind, t: &Target, cmd: &Command, body: String) {
        if !cmd.notify() {
            return;
        }
        self.emit(Event::Notice(Notice {
            kind,
            project_id: Some(t.project_id.clone()),
            command_id: t.command_id.clone(),
            title: format!("{} crashed", cmd.name()),
            body,
        }));
    }

    fn crash_policy(&mut self, t: &Target, code: Option<i64>, started: Instant) {
        let Some((_, cmd)) = self.command_for(t) else { return };
        let exit_text = match code {
            Some(c) => format!("exit code {c}"),
            None => "it stopped unexpectedly".to_string(),
        };
        if !cmd.restarts_on_crash() || !self.shutdown_waiters.is_empty() {
            self.notice(NoticeKind::Crashed, t, &cmd, format!("It stopped with {exit_text}."));
            return;
        }
        let limit = cmd.restart_limit();
        let svc = self.services.get_mut(t).unwrap();
        if started.elapsed() > self.timings.stable_run {
            svc.restart_attempts = 0;
        }
        let attempt = svc.restart_attempts + 1;
        if attempt > limit {
            svc.restart_attempts = 0;
            self.system(t, &format!("[system] Auto-restart paused after {limit} attempts\n"));
            self.set_runtime(t, |rt| {
                rt.restart_gave_up = true;
                rt.restart_attempt = None;
            });
            self.notice(
                NoticeKind::RestartPaused,
                t,
                &cmd,
                format!("Crashed {limit} times in a row ({exit_text}). Auto-restart is paused."),
            );
            return;
        }
        svc.restart_attempts = attempt;
        let units = 2u32.saturating_pow(attempt).min(30);
        let token = self.token();
        self.services.get_mut(t).unwrap().pending = Some((token, true));
        self.system(t, &format!("[system] Restarting in {units}s (attempt {attempt} of {limit})\n"));
        self.set_runtime(t, |rt| {
            rt.status = Status::Starting;
            rt.restart_attempt = Some(attempt);
            rt.restart_gave_up = false;
        });
        self.notice(
            NoticeKind::Crashed,
            t,
            &cmd,
            format!("It stopped with {exit_text}. Restarting in {units}s ({attempt} of {limit})."),
        );
        self.after(self.timings.restart_unit * units, t, token, TimerKind::Restart);
    }

    // ── Timers ───────────────────────────────────────────────────

    fn on_timer(&mut self, t: &Target, token: u64, kind: TimerKind) {
        match kind {
            TimerKind::Spawn | TimerKind::Restart => {
                let Some(svc) = self.services.get_mut(t) else { return };
                if svc.pending.map(|p| p.0) != Some(token) {
                    return; // cancelled
                }
                svc.pending = None;
                if matches!(kind, TimerKind::Spawn) {
                    if let Some(spec) = self.pending_specs.remove(t) {
                        self.spawn_now(t, spec);
                    }
                } else {
                    self.start(t, StartOpts { force: true, is_restart: true });
                }
            }
            TimerKind::WaitTimeout => {
                let Some(svc) = self.services.get_mut(t) else { return };
                let Some(w) = svc.waiter.take_if(|w| w.token == token) else { return };
                self.system(
                    t,
                    &format!(
                        "\n[error] Gave up waiting for {} after {}s. If it never prints a local URL, give it a port or a \"ready\" log line.\n",
                        w.dep_name,
                        self.timings.wait_timeout.as_secs()
                    ),
                );
                self.set_runtime(t, |rt| {
                    rt.status = Status::Offline;
                    rt.waiting_for = None;
                    rt.blocked_by = Some(w.dep_name.clone());
                });
                // P9: whatever waits on this one is blocked too
                self.block_waiters(t, "was not started");
            }
            TimerKind::ForceKill { run } => {
                if let Some(r) = self.services.get(t).and_then(|s| s.run.as_ref()).filter(|r| r.id == run) {
                    r.group.kill(Kill::Force);
                }
            }
            TimerKind::ReadyProbe { open } => self.on_ready_probe(t, token, open),
        }
    }

    // ── Start order ──────────────────────────────────────────────

    fn creates_cycle(&self, project_id: &str, command_id: &str, dep_id: &str) -> bool {
        let Some(p) = self.store.db().project(project_id) else { return false };
        let mut seen = BTreeSet::from([command_id.to_string()]);
        let mut current = Some(dep_id.to_string());
        while let Some(c) = current {
            if !seen.insert(c.clone()) {
                return true;
            }
            current = p.command(&c).and_then(|c| c.start_after());
        }
        false
    }

    fn waiting_on(&self, dep: &Target) -> Vec<(Target, String)> {
        let mut v: Vec<(Target, String)> = self
            .services
            .iter()
            .filter_map(|(t, s)| s.waiter.as_ref().filter(|w| &w.dep == dep).map(|w| (t.clone(), w.dep_name.clone())))
            .collect();
        v.sort();
        v
    }

    fn release_waiters(&mut self, dep: &Target) {
        for (t, dep_name) in self.waiting_on(dep) {
            self.services.get_mut(&t).unwrap().waiter = None;
            self.system(&t, &format!("[system] {dep_name} is ready, starting\n"));
            self.start(&t, StartOpts { force: true, is_restart: false });
        }
    }

    fn block_waiters(&mut self, dep: &Target, how: &str) {
        for (t, dep_name) in self.waiting_on(dep) {
            self.services.get_mut(&t).unwrap().waiter = None;
            self.system(&t, &format!("\n[error] Not started: {dep_name} {how} before it was ready\n"));
            self.set_runtime(&t, |rt| {
                rt.status = Status::Offline;
                rt.waiting_for = None;
                rt.blocked_by = Some(dep_name.clone());
            });
            self.block_waiters(&t, "was not started");
        }
    }

    /// Ready by port: a dependency that never prints a URL (MySQL, Redis) counts as ready once its
    /// configured port is listening. Probed only while something waits on it, and only when it has
    /// no ready line of its own.
    fn ensure_ready_probe(&mut self, dep: &Target) {
        let Some((_, cmd)) = self.command_for(dep) else { return };
        let Some(port) = cmd.port() else { return };
        if !cmd.ready_pattern().is_empty() || self.services.get(dep).is_some_and(|s| s.ready_probe.is_some()) {
            return;
        }
        let token = self.token();
        self.services.entry(dep.clone()).or_default().ready_probe = Some(token);
        self.schedule_probe(dep, token, port);
    }

    fn schedule_probe(&self, dep: &Target, token: u64, port: u16) {
        let tx = self.tx.clone();
        let t = dep.clone();
        let every = self.timings.ready_probe;
        tokio::spawn(async move {
            tokio::time::sleep(every).await;
            let open = tokio::task::spawn_blocking(move || crate::ports::port_open(port, Duration::from_millis(250)))
                .await
                .unwrap_or(false);
            let _ = tx.send(Msg::Timer { t, token, kind: TimerKind::ReadyProbe { open } });
        });
    }

    fn on_ready_probe(&mut self, dep: &Target, token: u64, open: bool) {
        let Some(svc) = self.services.get(dep) else { return };
        if svc.ready_probe != Some(token) {
            return;
        }
        let wanted = !self.waiting_on(dep).is_empty();
        let status = svc.rt.status;
        if svc.rt.ready || !wanted || !matches!(status, Status::Running | Status::Starting) {
            self.services.get_mut(dep).unwrap().ready_probe = None;
            return;
        }
        let Some(port) = self.command_for(dep).and_then(|(_, c)| c.port()) else { return };
        if open && status == Status::Running {
            self.services.get_mut(dep).unwrap().ready_probe = None;
            self.system(dep, &format!("[system] Port {port} is listening, ready\n"));
            self.set_runtime(dep, |rt| rt.ready = true);
            self.release_waiters(dep);
        } else {
            self.schedule_probe(dep, token, port);
        }
    }

    // ── Stop ─────────────────────────────────────────────────────

    /// User stop. Also cancels a start waiting on its delay, a dependency or a restart. Never blocks:
    /// the tree gets a polite signal now and a forced kill after the grace period (F4).
    fn stop(&mut self, t: &Target) {
        let grace = self.timings.stop_grace;
        let Some(svc) = self.services.get_mut(t) else { return };
        let running = svc.run.as_ref().is_some_and(|r| !r.stopping);
        let was_active = running || svc.pending.is_some() || svc.waiter.is_some() || svc.start_after_exit;
        svc.restart_attempts = 0;
        svc.pending = None;
        svc.waiter = None;
        svc.start_after_exit = false;
        svc.ready_probe = None;
        let mut force_after = None;
        if let Some(run) = svc.run.as_mut().filter(|r| !r.stopping) {
            run.stopping = true;
            if cfg!(windows) {
                let _ = run.writer.write_all(b"\x03"); // Ctrl+C through the console
                let _ = run.writer.flush();
            }
            run.group.kill(Kill::Terminate);
            force_after = Some(run.id);
        }
        self.pending_specs.remove(t);
        if let Some(run) = force_after {
            let token = self.token();
            self.after(grace, t, token, TimerKind::ForceKill { run });
        }
        if was_active {
            self.system(t, "\n[system] Stopped by user\n");
        }
        self.set_runtime(t, |rt| {
            *rt = Runtime { env_summary: rt.env_summary.clone(), ..Runtime::default() };
        });
        self.block_waiters(t, "was stopped");
    }

    fn stop_everything(&mut self) {
        let targets: Vec<Target> = self
            .services
            .iter()
            .filter(|(_, s)| {
                s.run.as_ref().is_some_and(|r| !r.stopping) || s.pending.is_some() || s.waiter.is_some() || s.start_after_exit
            })
            .map(|(t, _)| t.clone())
            .collect();
        for t in targets {
            self.stop(&t);
        }
    }

    fn force_kill_all(&mut self) {
        for s in self.services.values() {
            if let Some(r) = &s.run {
                r.group.kill(Kill::Force);
            }
        }
    }

    fn check_shutdown(&mut self) {
        if self.shutdown_waiters.is_empty() {
            return;
        }
        if self.services.values().all(|s| s.run.is_none()) {
            for w in self.shutdown_waiters.drain(..) {
                let _ = w.send(());
            }
        }
    }

    fn send_input(&mut self, t: &Target, text: &str) -> Result<(), String> {
        let svc = self.services.get_mut(t).ok_or("That service isn't running.")?;
        let run = svc.run.as_mut().filter(|r| !r.stopping).ok_or("That service isn't running.")?;
        let line = format!("{text}\r");
        run.writer.write_all(line.as_bytes()).and_then(|_| run.writer.flush()).map_err(|e| e.to_string())
    }

    // ── Config ───────────────────────────────────────────────────

    fn update_config(&mut self, f: impl FnOnce(&mut Database)) -> Result<(), String> {
        let before = self.store.revision();
        self.store.update(f).map_err(|e: SaveError| e.to_string())?;
        // A command (or project) removed while running would keep running with no way to stop it
        let gone: Vec<Target> = self
            .services
            .keys()
            .filter(|t| t.command_id.is_some() && self.command_for(t).is_none())
            .cloned()
            .collect();
        for t in gone {
            self.stop(&t);
        }
        if self.store.revision() != before {
            self.folder_signature = self.compute_signature();
            self.rewatch();
            self.emit(Event::ConfigChanged { revision: self.store.revision() });
        }
        Ok(())
    }
}

fn badge(s: &EnvSummary) -> Option<EnvBadge> {
    (s.count > 0).then(|| EnvBadge { count: s.count, file: s.file.clone(), secrets: s.secrets })
}

/// The command's working directory: relative to the project folder, or absolute.
pub fn resolve_working_dir(base: Option<&str>, wd: Option<&str>, home: Option<&Path>) -> PathBuf {
    let base = base
        .map(PathBuf::from)
        .or_else(|| home.map(Path::to_path_buf))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    match wd.map(str::trim).filter(|s| !s.is_empty()) {
        Some(w) if Path::new(w).is_absolute() => PathBuf::from(w),
        Some(w) => base.join(w),
        None => base,
    }
}
