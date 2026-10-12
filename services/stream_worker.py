import sys
import os
import json
import subprocess
import threading

# Read configuration arguments safely from Electron
if len(sys.argv) < 3:
    print(json.dumps({"type": "error", "message": "Missing command or directory arguments."}))
    sys.exit(1)

command_to_run = sys.argv[1]
working_directory = sys.argv[2]


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
    """Reads execution buffers character-by-character to capture live path prompts without trailing newlines."""
    buffer = []
    while True:
        # Read 1 character at a time instead of readline
        char = pipe.read(1)
        if not char:
            break
            
        buffer.append(char)
        
        # Check if we should flush the buffer (on newline or when a Windows prompt pattern appears)
        # Windows prompts typically end with '>' (e.g., C:\Users\Name>)
        is_newline = char == '\n' or char == '\r'
        is_prompt = char == '>' and len(buffer) >= 3 and buffer[-2] != ' ' 

        if is_newline or is_prompt:
            clean_text = "".join(buffer)
            
            # Normalize trailing line breaks safely
            if clean_text.endswith('\r\n'):
                clean_text = clean_text[:-2] + '\n'
            elif clean_text.endswith('\r') or clean_text.endswith('\n'):
                clean_text = clean_text[:-1] + '\n'

            payload = {
                "type": "log",
                "pipe": pipe_type,
                "text": clean_text
            }
            print(json.dumps(payload))
            sys.stdout.flush()
            buffer.clear()

    # Flush anything remaining if the stream closes
    if buffer:
        print(json.dumps({"type": "log", "pipe": pipe_type, "text": "".join(buffer)}))
        sys.stdout.flush()
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
        encoding='utf-8'
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
    print(json.dumps({"type": "started", "pid": process.pid}))
    sys.stdout.flush()

    # Use standard Python threading threads to capture stdout and stderr concurrently without freezing
    stdout_thread = threading.Thread(target=stream_pipe, args=(process.stdout, "stdout"))
    stderr_thread = threading.Thread(target=stream_pipe, args=(process.stderr, "stderr"))
    
    stdout_thread.start()
    stderr_thread.start()

    process.wait()
    stdout_thread.join()
    stderr_thread.join()

    print(json.dumps({"type": "exit", "code": process.returncode}))
    sys.stdout.flush()

except Exception as e:
    print(json.dumps({"type": "exception", "message": str(e)}))
    sys.stdout.flush()