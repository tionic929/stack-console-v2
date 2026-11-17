import sys
import os
import json
import subprocess
import threading
import time

# Read configuration arguments safely from Electron
if len(sys.argv) < 3:
    print(json.dumps({"type": "error", "message": "Missing command or directory arguments."}))
    sys.exit(1)

command_to_run = sys.argv[1]
working_directory = sys.argv[2]
# 'shell' = the interactive shell: its prompt (C:\Users\Name>) has no newline, so '>' also ends a line there.
# Services never use that rule: '->' and '=>' in their output must not split a line.
SHELL_MODE = len(sys.argv) > 3 and sys.argv[3] == 'shell'
MAX_LINE_CHARS = 8192      # a line longer than this is sent in pieces
IDLE_FLUSH_SECONDS = 0.15  # text with no newline (a question, a prompt) is sent after this pause

write_lock = threading.Lock()

def emit(payload):
    # One JSON object per line; two reader threads share stdout
    with write_lock:
        sys.stdout.write(json.dumps(payload) + "\n")
        sys.stdout.flush()


# Windows: the command and everything it starts run in a job object that kills them all when this worker exits.
# Electron's own job ends this worker whenever StackConsole exits (quit, crash, killed), but children of this worker
# are outside that job, so without this a service (npm -> node...) kept running and held its port.
JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x800          # a program that asks to leave the job (rare) still can
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
CREATE_SUSPENDED = 0x4                         # nothing runs until it's in the job, so no child escapes early

def create_kill_on_close_job():
    if os.name != 'nt':
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in (
                'ReadOperationCount', 'WriteOperationCount', 'OtherOperationCount',
                'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]

        class BASIC_LIMITS(ctypes.Structure):
            _fields_ = [('PerProcessUserTimeLimit', ctypes.c_int64), ('PerJobUserTimeLimit', ctypes.c_int64),
                        ('LimitFlags', wintypes.DWORD), ('MinimumWorkingSetSize', ctypes.c_size_t),
                        ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', wintypes.DWORD),
                        ('Affinity', ctypes.c_size_t), ('PriorityClass', wintypes.DWORD), ('SchedulingClass', wintypes.DWORD)]

        class EXTENDED_LIMITS(ctypes.Structure):
            _fields_ = [('BasicLimitInformation', BASIC_LIMITS), ('IoInfo', IO_COUNTERS),
                        ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                        ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]

        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        ntdll = ctypes.WinDLL('ntdll')
        ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]

        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return None
        limits = EXTENDED_LIMITS()
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK
        if not kernel32.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):  # 9 = extended limits
            kernel32.CloseHandle(job)
            return None
        return {'handle': job, 'assign': kernel32.AssignProcessToJobObject, 'resume': ntdll.NtResumeProcess}
    except Exception:
        return None

# Kept for the life of this worker: the handle closing (exit, crash or kill) is what ends the tree
service_job = create_kill_on_close_job()

def start_in_job(process):
    if not service_job:
        return
    handle = int(process._handle)
    try:
        service_job['assign'](service_job['handle'], handle)  # if this fails the command still runs, just without the job
    finally:
        service_job['resume'](handle)

def stream_pipe(pipe, pipe_type):
    """Sends output line by line. Text without a newline is sent after a short pause, so prompts still show."""
    buffer = []
    lock = threading.Lock()
    last_char_at = [time.monotonic()]
    finished = threading.Event()

    def flush_locked():
        if not buffer:
            return
        text = "".join(buffer)
        buffer.clear()
        if text.endswith('\r\n'):
            text = text[:-2] + '\n'
        elif text.endswith('\r'):
            text = text[:-1] + '\n'
        emit({"type": "log", "pipe": pipe_type, "text": text})

    def idle_flusher():
        while not finished.wait(0.05):
            with lock:
                if buffer and time.monotonic() - last_char_at[0] >= IDLE_FLUSH_SECONDS:
                    flush_locked()

    threading.Thread(target=idle_flusher, daemon=True).start()

    while True:
        char = pipe.read(1)
        if not char:
            break
        with lock:
            buffer.append(char)
            last_char_at[0] = time.monotonic()
            is_newline = char == '\n' or char == '\r'
            is_prompt = SHELL_MODE and char == '>' and len(buffer) >= 3 and buffer[-2] != ' '
            if is_newline or is_prompt or len(buffer) >= MAX_LINE_CHARS:
                flush_locked()

    finished.set()
    with lock:
        flush_locked()

try:

    custom_env = os.environ.copy()
    custom_env["FORCE_COLOR"] = "1"
    custom_env["PYTHONUNBUFFERED"] = "1"

    process = subprocess.Popen(
        command_to_run,
        shell=True,
        cwd=working_directory,
        env=custom_env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP | (CREATE_SUSPENDED if service_job else 0)) if os.name == 'nt' else 0,
        encoding='utf-8',
        errors='replace'   # bytes that aren't UTF-8 (console code pages) show as \ufffd instead of ending the stream
    )
    start_in_job(process)

    def listen_for_electron_input():
        for line in sys.stdin:
            if process.poll() is not None:
                break
            process.stdin.write(line)
            process.stdin.flush()

    input_thread = threading.Thread(target=listen_for_electron_input, daemon=True)
    input_thread.start()

    # Let Electron know the native operating system process started up successfully
    emit({"type": "started", "pid": process.pid})

    # Use standard Python threading threads to capture stdout and stderr concurrently without freezing
    stdout_thread = threading.Thread(target=stream_pipe, args=(process.stdout, "stdout"))
    stderr_thread = threading.Thread(target=stream_pipe, args=(process.stderr, "stderr"))
    
    stdout_thread.start()
    stderr_thread.start()

    process.wait()
    stdout_thread.join()
    stderr_thread.join()

    emit({"type": "exit", "code": process.returncode})

except Exception as e:
    emit({"type": "exception", "message": str(e)})