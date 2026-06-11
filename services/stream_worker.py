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
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0,
        encoding='utf-8'
    )

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