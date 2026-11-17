//! StackConsole engine: supervises a project's local dev services. Headless; no UI dependency.
//! The desktop app, a command-line tool and integrations all drive it through [`Engine`].
//! API: `docs/ENGINE-API.md`.

pub mod config;
pub mod engine;
pub mod env;
pub mod git;
pub mod lines;
pub mod logs;
pub mod identity;
pub mod importer;
pub mod model;
pub mod open;
pub mod paths;
pub mod ports;
pub mod process;
pub mod regroup;
pub mod roots;
pub mod secrets;

pub use engine::{Engine, EngineOptions, Event, Notice, NoticeKind, Runtime, RuntimeEvent, Status, Target, Timings};
