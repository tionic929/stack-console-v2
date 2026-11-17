//! Real processes through the engine (macOS / Linux shell commands).
#![cfg(unix)]

use serde_json::json;
use stackconsole_engine::logs::Stream;
use stackconsole_engine::model::{Command, Project};
use stackconsole_engine::secrets::PlainSecrets;
use stackconsole_engine::{Engine, EngineOptions, Event, NoticeKind, Status, Target, Timings};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Harness {
    engine: Engine,
    events: Arc<Mutex<Vec<Event>>>,
    _data: tempfile::TempDir,
    dir: tempfile::TempDir,
}

fn fast() -> Timings {
    Timings {
        flush: Duration::from_millis(20),
        idle_line: Duration::from_millis(100),
        stop_grace: Duration::from_millis(600),
        wait_timeout: Duration::from_secs(10),
        stable_run: Duration::from_secs(60),
        restart_unit: Duration::from_millis(20),
        ready_probe: Duration::from_millis(100),
    }
}

fn cmd(id: &str, command: &str, extra: serde_json::Value) -> Command {
    let mut c = Command { id: id.into(), display_name: id.to_uppercase(), command: command.into(), ..Default::default() };
    if let serde_json::Value::Object(m) = extra {
        c.extra = m;
    }
    c
}

async fn harness(timings: Timings, commands: Vec<Command>) -> Harness {
    let data = tempfile::tempdir().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let (engine, _) = Engine::start(EngineOptions {
        data_dir: data.path().into(),
        secrets: Arc::new(PlainSecrets),
        timings,
        home_dir: None,
    })
    .unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let mut rx = engine.subscribe();
    let sink = events.clone();
    tokio::spawn(async move {
        while let Ok(e) = rx.recv().await {
            sink.lock().unwrap().push(e);
        }
    });
    let base = dir.path().to_string_lossy().into_owned();
    engine
        .update_config(move |db| {
            db.projects.push(Project { id: "p".into(), name: "P".into(), base_directory: Some(base), commands, ..Default::default() })
        })
        .await
        .unwrap();
    Harness { engine, events, _data: data, dir }
}

fn t(id: &str) -> Target {
    Target::new("p", id)
}

impl Harness {
    /// Log lines of one service, in order, as received through events.
    fn lines(&self, id: &str) -> Vec<(Stream, String)> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| if let Event::Logs { lines } = e { Some(lines.clone()) } else { None })
            .flatten()
            .filter(|l| l.command_id.as_deref() == Some(id))
            .map(|l| (l.line.stream, l.line.text))
            .collect()
    }

    fn output(&self, id: &str) -> Vec<String> {
        self.lines(id).into_iter().filter(|(s, _)| *s == Stream::Stdout).map(|(_, t)| t).collect()
    }

    fn text(&self, id: &str) -> String {
        self.lines(id).into_iter().map(|(_, t)| t).collect()
    }

    async fn status(&self, id: &str) -> stackconsole_engine::Runtime {
        self.engine
            .status()
            .await
            .unwrap()
            .into_iter()
            .find(|r| r.command_id.as_deref() == Some(id))
            .map(|r| r.runtime)
            .unwrap_or_default()
    }

    async fn wait(&self, what: &str, timeout: Duration, mut f: impl FnMut(&Self) -> bool) {
        let start = Instant::now();
        while !f(self) {
            if start.elapsed() > timeout {
                panic!("timed out waiting for {what}\nevents: {:#?}", self.events.lock().unwrap());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn wait_status(&self, id: &str, want: Status, timeout: Duration) -> stackconsole_engine::Runtime {
        let start = Instant::now();
        loop {
            let rt = self.status(id).await;
            if rt.status == want {
                return rt;
            }
            if start.elapsed() > timeout {
                panic!("{id}: wanted {want:?}, still {rt:?}\nlog: {}", self.text(id));
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks existence
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn gone_within(pid: i32, timeout: Duration) -> bool {
    let start = Instant::now();
    while alive(pid) {
        if start.elapsed() > timeout {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    true
}

const SEC: Duration = Duration::from_secs(1);

#[tokio::test(flavor = "multi_thread")]
async fn start_and_stop_with_correct_lines() {
    // P1, P2 and the audit's exact line, through a real terminal
    let script = r#"printf 'App->handle() => 200 <div>ok</div>\nbad \202 byte\ncaf\303\251\n'; echo READY; sleep 30"#;
    let h = harness(fast(), vec![cmd("api", script, json!({}))]).await;
    h.engine.start_service(t("api"), false).await.unwrap();
    let rt = h.wait_status("api", Status::Running, 5 * SEC).await;
    let pid = rt.pid.unwrap() as i32;
    h.wait("READY", 5 * SEC, |h| h.output("api").iter().any(|l| l.contains("READY"))).await;
    assert_eq!(
        h.output("api"),
        vec!["App->handle() => 200 <div>ok</div>\n", "bad \u{fffd} byte\n", "café\n", "READY\n"]
    );
    let sys = h.text("api");
    assert!(sys.contains("[system] Spawning: printf"), "{sys}");

    let started = Instant::now();
    h.engine.stop_service(t("api")).await.unwrap();
    assert!(started.elapsed() < Duration::from_millis(100), "stop must not block");
    assert_eq!(h.status("api").await.status, Status::Offline);
    assert!(gone_within(pid, 3 * SEC).await, "process should be gone");
    h.wait("stopped line", 2 * SEC, |h| h.text("api").contains("[system] Stopped by user")).await;
    // A user stop is not a crash and writes no exit line
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!h.text("api").contains("exited with code"));
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_ends_the_whole_process_group() {
    // P15: the service's own children go too
    let h = harness(fast(), vec![cmd("api", "sleep 300 & echo child:$!; sleep 300", json!({}))]).await;
    h.engine.start_service(t("api"), false).await.unwrap();
    h.wait("child pid", 5 * SEC, |h| h.output("api").iter().any(|l| l.starts_with("child:"))).await;
    let child: i32 = h.output("api").iter().find_map(|l| l.trim().strip_prefix("child:").map(|s| s.parse().unwrap())).unwrap();
    let leader = h.status("api").await.pid.unwrap() as i32;
    assert!(alive(child) && alive(leader));
    h.engine.stop_service(t("api")).await.unwrap();
    assert!(gone_within(leader, 3 * SEC).await);
    assert!(gone_within(child, 3 * SEC).await, "background child survived the stop");
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_never_blocks_and_forces_after_grace() {
    // F4: a tree that ignores SIGTERM is killed after the grace period, and stop returns at once
    let h = harness(fast(), vec![cmd("api", "trap '' TERM; echo up; while :; do sleep 0.1; done", json!({}))]).await;
    h.engine.start_service(t("api"), false).await.unwrap();
    h.wait("up", 5 * SEC, |h| h.output("api").contains(&"up\n".to_string())).await;
    let pid = h.status("api").await.pid.unwrap() as i32;
    let started = Instant::now();
    h.engine.stop_service(t("api")).await.unwrap();
    assert!(started.elapsed() < Duration::from_millis(100));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(alive(pid), "still in its grace period");
    assert!(gone_within(pid, 3 * SEC).await, "forced kill after the grace period");
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_codes() {
    let h = harness(fast(), vec![cmd("ok", "echo done", json!({})), cmd("bad", "exit 3", json!({"notify": false}))]).await;
    h.engine.start_service(t("ok"), false).await.unwrap();
    h.engine.start_service(t("bad"), false).await.unwrap();
    h.wait("exit lines", 5 * SEC, |h| h.text("ok").contains("exited with code 0") && h.text("bad").contains("exited with code 3"))
        .await;
    let ok = h.status("ok").await;
    assert_eq!((ok.status, ok.exit_code), (Status::Offline, None));
    let bad = h.status("bad").await;
    assert_eq!((bad.status, bad.exit_code), (Status::Crashed, Some(3)));
    assert!(h.text("ok").contains("[info] Process exited with code 0"));
    assert!(h.text("bad").contains("[error] Process exited with code 3"));
    // notify: false means no notice for "bad"
    let notices = h.events.lock().unwrap().iter().filter(|e| matches!(e, Event::Notice(_))).count();
    assert_eq!(notices, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn crash_policy_backs_off_then_pauses() {
    let h = harness(fast(), vec![cmd("w", "echo run; exit 1", json!({"onCrash": "restart", "restartLimit": "2"}))]).await;
    h.engine.start_service(t("w"), false).await.unwrap();
    h.wait("paused", 10 * SEC, |h| h.text("w").contains("Auto-restart paused after 2 attempts")).await;
    let text = h.text("w");
    assert!(text.contains("Restarting in 2s (attempt 1 of 2)"), "{text}");
    assert!(text.contains("Restarting in 4s (attempt 2 of 2)"), "{text}");
    assert_eq!(h.output("w").iter().filter(|l| *l == "run\n").count(), 3, "first run plus two restarts");
    let rt = h.wait_status("w", Status::Crashed, 2 * SEC).await;
    assert!(rt.restart_gave_up);
    let kinds: Vec<NoticeKind> = h
        .events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| if let Event::Notice(n) = e { Some(n.kind) } else { None })
        .collect();
    assert_eq!(kinds, vec![NoticeKind::Crashed, NoticeKind::Crashed, NoticeKind::RestartPaused]);
}

#[tokio::test(flavor = "multi_thread")]
async fn start_order_waits_for_local_url() {
    let h = harness(
        fast(),
        vec![
            cmd("db", "sleep 0.4; echo '  Local:   http://localhost:5999/'; sleep 30", json!({})),
            cmd("web", "echo web-up; sleep 30", json!({"startAfter": "db"})),
        ],
    )
    .await;
    h.engine.start_service(t("web"), false).await.unwrap();
    let rt = h.status("web").await;
    assert_eq!(rt.status, Status::Waiting);
    assert_eq!(rt.waiting_for.as_deref(), Some("DB"));
    assert_eq!(h.status("db").await.status, Status::Running, "the dependency was started for it");
    h.wait("web up", 5 * SEC, |h| h.output("web").contains(&"web-up\n".to_string())).await;
    let db = h.status("db").await;
    assert!(db.ready);
    assert_eq!(db.url.as_deref(), Some("http://localhost:5999"));
    assert_eq!(db.detected_port.as_deref(), Some("5999"));
    assert!(h.text("web").contains("[system] DB is ready, starting"));
    h.engine.stop_project("p".into()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn ready_by_port() {
    let listener_port = {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        l.local_addr().unwrap().port()
    };
    let h = harness(
        fast(),
        vec![
            cmd("redis", "sleep 30", json!({"port": listener_port.to_string()})),
            cmd("app", "echo app-up; sleep 30", json!({"startAfter": "redis"})),
        ],
    )
    .await;
    h.engine.start_service(t("app"), false).await.unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(h.status("app").await.status, Status::Waiting, "port not open yet");
    let _l = std::net::TcpListener::bind(("127.0.0.1", listener_port)).unwrap();
    h.wait("app up", 5 * SEC, |h| h.output("app").contains(&"app-up\n".to_string())).await;
    assert!(h.text("redis").contains(&format!("[system] Port {listener_port} is listening, ready")));
    h.engine.stop_project("p".into()).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_dependency_blocks_the_whole_chain_at_once() {
    // P9: c waits on b waits on a; a can't start (folder missing) -> b and c blocked immediately
    let h = harness(
        fast(),
        vec![
            cmd("a", "sleep 30", json!({})),
            cmd("b", "sleep 30", json!({"startAfter": "a"})),
            cmd("c", "sleep 30", json!({"startAfter": "b"})),
        ],
    )
    .await;
    h.engine
        .update_config(|db| db.projects[0].commands[0].working_directory = Some("missing-folder".into()))
        .await
        .unwrap();
    let started = Instant::now();
    h.engine.start_service(t("c"), false).await.unwrap();
    let c = h.status("c").await;
    let b = h.status("b").await;
    assert!(started.elapsed() < SEC);
    assert_eq!(h.status("a").await.status, Status::Crashed);
    assert_eq!((b.status, b.blocked_by.as_deref()), (Status::Offline, Some("A")));
    assert_eq!((c.status, c.blocked_by.as_deref()), (Status::Offline, Some("B")));
    h.wait("blocked lines", 2 * SEC, |h| {
        h.text("a").contains("[error] Folder not found")
            && h.text("b").contains("Not started: A could not start before it was ready")
            && h.text("c").contains("Not started: B was not started before it was ready")
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn crashing_dependency_blocks_waiters() {
    let h = harness(
        fast(),
        vec![cmd("a", "sleep 0.2; exit 1", json!({"notify": false})), cmd("b", "sleep 30", json!({"startAfter": "a"}))],
    )
    .await;
    h.engine.start_service(t("b"), false).await.unwrap();
    h.wait_status("a", Status::Crashed, 5 * SEC).await;
    let b = h.wait_status("b", Status::Offline, SEC).await;
    assert_eq!(b.blocked_by.as_deref(), Some("A"));
    h.wait("blocked line", SEC, |h| h.text("b").contains("Not started: A crashed before it was ready")).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn wait_timeout_blocks_down_the_chain() {
    // P9 (second half): a timed-out waiter blocks whatever waits on it
    let mut timings = fast();
    timings.wait_timeout = Duration::from_millis(400);
    let h = harness(
        timings,
        vec![
            cmd("a", "sleep 30", json!({})),
            cmd("b", "sleep 30", json!({"startAfter": "a"})),
            cmd("c", "sleep 30", json!({"startAfter": "b"})),
        ],
    )
    .await;
    h.engine.start_service(t("c"), false).await.unwrap();
    assert_eq!(h.status("b").await.status, Status::Waiting);
    assert_eq!(h.status("c").await.status, Status::Waiting);
    let b = h.wait_status("b", Status::Offline, 3 * SEC).await;
    assert_eq!(b.blocked_by.as_deref(), Some("A"));
    let c = h.wait_status("c", Status::Offline, SEC).await;
    assert_eq!(c.blocked_by.as_deref(), Some("B"));
    h.wait("gave up line", SEC, |h| h.text("b").contains("Gave up waiting for A after")).await;
    h.engine.stop_everything().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn secret_values_are_masked_in_output() {
    // X2
    let h = harness(
        fast(),
        vec![cmd(
            "api",
            "echo token=$API_TOKEN short=$SHORT; sleep 30",
            json!({"env": [{"key": "API_TOKEN", "secret": true, "value": "hunter2-secret"}, {"key": "SHORT", "secret": true, "value": "ab"}]}),
        )],
    )
    .await;
    h.engine.start_service(t("api"), false).await.unwrap();
    h.wait("token line", 5 * SEC, |h| h.output("api").iter().any(|l| l.starts_with("token="))).await;
    assert_eq!(h.output("api")[0], "token=•••••• short=ab\n");
    let rt = h.status("api").await;
    assert_eq!(rt.env_summary.as_ref().map(|e| e.secrets), Some(2));
    assert!(h.text("api").contains("(env: 2 variables, 2 secrets hidden)"));
    let (_, stored) = h.engine.logs(t("api")).await.unwrap();
    assert!(stored.iter().all(|l| !l.text.contains("hunter2-secret")));
    h.engine.stop_service(t("api")).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn log_lines_are_batched() {
    // F2: 3,000 lines arrive in far fewer events, complete and in order
    let h = harness(fast(), vec![cmd("spam", "i=0; while [ $i -lt 3000 ]; do echo line-$i; i=$((i+1)); done; sleep 30", json!({}))])
        .await;
    h.engine.start_service(t("spam"), false).await.unwrap();
    h.wait("3000 lines", 10 * SEC, |h| h.output("spam").len() >= 3000).await;
    let out = h.output("spam");
    assert!(out.iter().enumerate().all(|(i, l)| *l == format!("line-{i}\n")));
    let log_events = h.events.lock().unwrap().iter().filter(|e| matches!(e, Event::Logs { .. })).count();
    assert!(log_events < 300, "{log_events} log events for 3000 lines");
    let (seq, stored) = h.engine.logs(t("spam")).await.unwrap();
    assert!(seq >= 3000 && stored.len() >= 3000);
    h.engine.stop_service(t("spam")).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn runtime_changes_are_coalesced() {
    // F1: starting 6 services sends a handful of runtime events, not one per change
    let cmds = (0..6).map(|i| cmd(&format!("s{i}"), "sleep 30", json!({}))).collect();
    let h = harness(fast(), cmds).await;
    h.engine.start_project("p".into()).await.unwrap();
    for i in 0..6 {
        h.wait_status(&format!("s{i}"), Status::Running, 5 * SEC).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let runtime_events: Vec<usize> = h
        .events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| if let Event::Runtime { services } = e { Some(services.len()) } else { None })
        .collect();
    // 6 services x 2 changes (starting, running) = 12 changes without coalescing
    assert!(runtime_events.len() <= 3, "{runtime_events:?}");
    assert!(runtime_events.iter().sum::<usize>() >= 6);
    h.engine.stop_everything().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn restart_waits_for_the_old_run_to_exit() {
    let h = harness(fast(), vec![cmd("api", "trap 'sleep 0.3; exit 0' TERM; echo up; while :; do sleep 0.05; done", json!({}))]).await;
    h.engine.start_service(t("api"), false).await.unwrap();
    h.wait("up", 5 * SEC, |h| h.output("api").contains(&"up\n".to_string())).await;
    let old = h.status("api").await.pid.unwrap() as i32;
    h.engine.restart_service(t("api")).await.unwrap();
    assert_eq!(h.status("api").await.status, Status::Starting);
    let rt = h.wait_status("api", Status::Running, 5 * SEC).await;
    let new = rt.pid.unwrap() as i32;
    assert_ne!(old, new);
    assert!(!alive(old), "old run gone before the new one started");
    h.wait("second up", 5 * SEC, |h| h.output("api").iter().filter(|l| *l == "up\n").count() == 2).await;
    h.engine.stop_service(t("api")).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn prompt_without_newline_shows_and_input_reaches_service() {
    let h = harness(fast(), vec![cmd("q", "printf 'Continue? (y/n) '; read answer; echo got:$answer; sleep 30", json!({}))]).await;
    h.engine.start_service(t("q"), false).await.unwrap();
    h.wait("prompt", 5 * SEC, |h| h.output("q").iter().any(|l| l == "Continue? (y/n) ")).await;
    h.engine.send_input(t("q"), "y".into()).await.unwrap();
    h.wait("answer", 5 * SEC, |h| h.output("q").iter().any(|l| l.contains("got:y"))).await;
    h.engine.stop_service(t("q")).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_a_running_command_stops_it() {
    let h = harness(fast(), vec![cmd("api", "sleep 30", json!({}))]).await;
    h.engine.start_service(t("api"), false).await.unwrap();
    let pid = h.wait_status("api", Status::Running, 5 * SEC).await.pid.unwrap() as i32;
    h.engine.update_config(|db| db.projects[0].commands.clear()).await.unwrap();
    assert!(gone_within(pid, 3 * SEC).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn shutdown_ends_every_tree_and_returns() {
    // P4 (engine half): quit stops everything and waits, even for a tree that ignores SIGTERM
    let h = harness(
        fast(),
        vec![
            cmd("a", "sleep 300 & sleep 300", json!({})),
            cmd("b", "trap '' TERM; while :; do sleep 0.1; done", json!({})),
            cmd("c", "sleep 300", json!({"onCrash": "restart"})),
        ],
    )
    .await;
    h.engine.start_project("p".into()).await.unwrap();
    let mut pids = Vec::new();
    for id in ["a", "b", "c"] {
        pids.push(h.wait_status(id, Status::Running, 5 * SEC).await.pid.unwrap() as i32);
    }
    let started = Instant::now();
    h.engine.shutdown(Duration::from_secs(5)).await;
    assert!(started.elapsed() < Duration::from_secs(3), "grace is 0.6 s; took {:?}", started.elapsed());
    for pid in pids {
        assert!(!alive(pid), "pid {pid} survived shutdown");
    }
    // Nothing restarted itself during shutdown
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(h.engine.status().await.unwrap().iter().all(|r| r.runtime.pid.is_none()));
    let _ = &h.dir;
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_delay_and_cancel() {
    let h = harness(fast(), vec![cmd("slow", "echo started; sleep 30", json!({"startupDelay": "0.5"}))]).await;
    h.engine.start_service(t("slow"), false).await.unwrap();
    assert_eq!(h.status("slow").await.status, Status::Starting);
    h.engine.stop_service(t("slow")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(h.status("slow").await.status, Status::Offline);
    assert!(h.output("slow").is_empty(), "cancelled start must not spawn");
    h.engine.start_service(t("slow"), false).await.unwrap();
    h.wait("started", 5 * SEC, |h| h.output("slow").contains(&"started\n".to_string())).await;
    h.engine.stop_service(t("slow")).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn ready_line_wins_over_url() {
    // A command with its own ready line is not ready when it merely prints a URL
    let h = harness(
        fast(),
        vec![
            cmd("vite", "echo 'Local: http://localhost:5174/'; sleep 0.4; echo 'Compiled SUCCESSFULLY in 3s'; sleep 30",
                json!({"readyPattern": "compiled successfully"})),
            cmd("e2e", "echo e2e-up; sleep 30", json!({"startAfter": "vite"})),
        ],
    )
    .await;
    h.engine.start_service(t("e2e"), false).await.unwrap();
    h.wait("url", 5 * SEC, |h| h.output("vite").iter().any(|l| l.contains("Local:"))).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let vite = h.status("vite").await;
    assert_eq!(vite.url.as_deref(), Some("http://localhost:5174"));
    assert!(!vite.ready, "URL alone must not count when a ready line is set");
    assert_eq!(h.status("e2e").await.status, Status::Waiting);
    h.wait("e2e up", 5 * SEC, |h| h.output("e2e").contains(&"e2e-up\n".to_string())).await;
    assert!(h.status("vite").await.ready);
    h.engine.stop_project("p".into()).await.unwrap();
}
