//! Starting a command in its own terminal and ending its whole process tree.
//!
//! - macOS / Linux: the command runs in a pty as the leader of a new session (portable-pty calls
//!   `setsid`), so its process group id is its pid and `killpg` reaches everything it started (P15).
//!   If StackConsole itself dies, the pty closes and the session gets SIGHUP.
//! - Windows: ConPTY, and the process is put in a job object with KILL_ON_JOB_CLOSE, so stopping
//!   the job ends the tree, and so does StackConsole exiting for any reason. (Not yet run on Windows.)

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::PathBuf;

pub struct SpawnSpec {
    /// The command line, run by the platform shell. `None` opens an interactive shell.
    pub command: Option<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
}

pub struct Spawned {
    pub pid: u32,
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
    pub group: ProcessGroup,
    /// Kept open for the life of the process; dropping it closes the terminal.
    pub master: Box<dyn MasterPty + Send>,
}

pub fn spawn(spec: SpawnSpec) -> Result<Spawned, String> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows: 50, cols: 200, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("could not open a terminal: {e}"))?;

    let mut cmd = shell_command(spec.command.as_deref());
    cmd.cwd(&spec.cwd);
    cmd.env("FORCE_COLOR", "1");
    cmd.env("PYTHONUNBUFFERED", "1");
    #[cfg(unix)]
    cmd.env("TERM", "xterm-256color");
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Our copy of the terminal's other end must close, or reading never sees the end of output
    drop(pair.slave);
    let pid = child.process_id().ok_or("the process has no id")?;
    let group = ProcessGroup::attach(pid, &*child);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    Ok(Spawned { pid, reader, writer, child, group, master: pair.master })
}

#[cfg(unix)]
fn shell_command(command: Option<&str>) -> CommandBuilder {
    match command {
        Some(line) => {
            let mut c = CommandBuilder::new("/bin/sh");
            c.args(["-c", line]);
            c
        }
        None => {
            let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
            CommandBuilder::new(shell)
        }
    }
}

#[cfg(windows)]
fn shell_command(command: Option<&str>) -> CommandBuilder {
    let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
    let mut c = CommandBuilder::new(&comspec);
    if let Some(line) = command {
        // portable-pty quotes every argument the C runtime way (\"), which cmd.exe does not
        // understand. Passing the line through a variable that cmd expands before parsing makes it
        // behave exactly as if typed. (Unverified on Windows.)
        c.env("STACKCONSOLE_COMMAND", line);
        c.args(["/d", "/s", "/c", "%STACKCONSOLE_COMMAND%"]);
    }
    c
}

/// The process tree of one service.
pub struct ProcessGroup {
    #[cfg(unix)]
    pgid: i32,
    #[cfg(windows)]
    job: Option<windows_job::Job>,
    #[cfg(windows)]
    pid: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kill {
    /// Ask nicely (SIGTERM / Ctrl+C).
    Terminate,
    /// Now (SIGKILL / TerminateJobObject).
    Force,
}

impl ProcessGroup {
    #[cfg(unix)]
    fn attach(pid: u32, _child: &dyn portable_pty::Child) -> Self {
        ProcessGroup { pgid: pid as i32 }
    }

    #[cfg(windows)]
    fn attach(pid: u32, _child: &dyn portable_pty::Child) -> Self {
        ProcessGroup { job: windows_job::Job::for_process(pid), pid }
    }

    /// Signals every process in the group. Never blocks.
    #[cfg(unix)]
    pub fn kill(&self, how: Kill) {
        let sig = match how {
            Kill::Terminate => libc::SIGTERM,
            Kill::Force => libc::SIGKILL,
        };
        if self.pgid > 1 {
            // SAFETY: plain syscall; a group that is already gone returns ESRCH, which is fine.
            unsafe {
                libc::killpg(self.pgid, sig);
            }
        }
    }

    #[cfg(windows)]
    pub fn kill(&self, how: Kill) {
        match (&self.job, how) {
            (Some(job), Kill::Force) => job.terminate(),
            (Some(_), Kill::Terminate) => {} // Ctrl+C is written to the terminal by the caller
            (None, _) => {
                // No job (assignment failed): fall back to taskkill, without waiting for it
                let _ = std::process::Command::new("taskkill")
                    .args(["/pid", &self.pid.to_string(), "/t", "/f"])
                    .spawn();
            }
        }
    }

    /// Is any process of the group still alive?
    #[cfg(unix)]
    pub fn alive(&self) -> bool {
        // SAFETY: signal 0 only checks for existence.
        self.pgid > 1 && unsafe { libc::killpg(self.pgid, 0) } == 0
    }

    #[cfg(windows)]
    pub fn alive(&self) -> bool {
        match &self.job {
            Some(job) => job.active_processes() > 0,
            None => false,
        }
    }
}

#[cfg(windows)]
mod windows_job {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    pub struct Job(HANDLE);
    // SAFETY: a job handle can be used from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        /// A kill-on-close job holding `pid`. The process is already running, so a child it starts
        /// in the first instant could escape; cmd.exe takes far longer than that to start one.
        pub fn for_process(pid: u32) -> Option<Job> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags =
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                let assigned = ok != 0 && !process.is_null() && AssignProcessToJobObject(job, process) != 0;
                if !process.is_null() {
                    CloseHandle(process);
                }
                if !assigned {
                    CloseHandle(job);
                    return None;
                }
                Some(Job(job))
            }
        }

        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }

        pub fn active_processes(&self) -> u32 {
            unsafe {
                let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
                let ok = QueryInformationJobObject(
                    self.0,
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut _,
                    std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                );
                if ok == 0 { 0 } else { info.ActiveProcesses }
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // Closing the last handle kills whatever is left in the job
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
