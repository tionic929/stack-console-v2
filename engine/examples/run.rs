//! Runs one command through the engine and prints what the interface would receive.
//!
//!   cargo run -p stackconsole-engine --example run -- "<command>" [seconds] [folder]
//!
//! The command runs for `seconds` (default 3), is stopped through the engine, and every event is
//! printed. A throwaway config folder is used, never the app's own.
use stackconsole_engine::model::{Command, Project};
use stackconsole_engine::secrets::PlainSecrets;
use stackconsole_engine::{Engine, EngineOptions, Event, Target, Timings};
use std::sync::Arc;
use std::time::Duration;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let command = args.next().expect("usage: run \"<command>\" [seconds] [folder]");
    let secs: f64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(3.0);
    let folder = args.next().unwrap_or_else(|| std::env::current_dir().unwrap().to_string_lossy().into_owned());
    let data = std::env::temp_dir().join(format!("stackconsole-run-{}", std::process::id()));

    let (engine, _) = Engine::start(EngineOptions {
        data_dir: data.clone(),
        secrets: Arc::new(PlainSecrets),
        timings: Timings::default(),
        home_dir: None,
    })
    .unwrap();
    let mut rx = engine.subscribe();
    tokio::spawn(async move {
        while let Ok(e) = rx.recv().await {
            match e {
                Event::Logs { lines } => {
                    for l in lines {
                        println!("  log  #{:<4} {:<6} {:?}", l.line.seq, format!("{:?}", l.line.stream).to_lowercase(), l.line.text);
                    }
                }
                Event::Runtime { services } => {
                    for s in services {
                        println!("  state {:?} pid={:?} url={:?} exit={:?}", s.runtime.status, s.runtime.pid, s.runtime.url, s.runtime.exit_code);
                    }
                }
                other => println!("  {}", serde_json::to_string(&other).unwrap()),
            }
        }
    });

    engine
        .update_config(move |db| {
            db.projects.push(Project {
                id: "demo".into(),
                name: "Demo".into(),
                base_directory: Some(folder),
                commands: vec![Command { id: "svc".into(), display_name: "Service".into(), command, ..Default::default() }],
                ..Default::default()
            })
        })
        .await
        .unwrap();
    let t = Target::new("demo", "svc");
    println!("> start");
    engine.start_service(t.clone(), false).await.unwrap();
    tokio::time::sleep(Duration::from_secs_f64(secs)).await;
    println!("> stop");
    let at = std::time::Instant::now();
    engine.stop_service(t).await.unwrap();
    println!("  (stop returned after {:?})", at.elapsed());
    engine.shutdown(Duration::from_secs(5)).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    println!("> done");
    let _ = std::fs::remove_dir_all(data);
}
