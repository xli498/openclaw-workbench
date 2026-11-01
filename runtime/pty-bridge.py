"""PTY bridge for openclaw-workbench (POSIX only).

The Node provider spawns this helper with shell:false and a target argv
after a '--' separator. The helper allocates a pty with pty.fork(), runs
the target as the pty child, copies master output to stdout and stdin to
the master, and exits with the child's exit code. It never prints the
target argv, environment, or any secret material; on stdin EOF it sends
SIGHUP to the child instead of waiting forever.

Resize channel (fd3): the provider opens one extra pipe as the helper's
fd3. A daemon thread reads fd3 in "<cols> <rows>" lines and applies each
valid line to the pty with TIOCSWINSZ, then sends SIGWINCH to the child.
Valid ranges are cols 1-500 and rows 1-200; anything else (malformed
lines, out-of-range values, overlong lines) is silently ignored and
never crashes the helper. If fd3 is absent (helper run standalone) the
thread exits immediately and the helper runs without resize support.
Fd3 is only treated as a control channel when it is a FIFO or a Unix
socket (Node stdio pipes are sockets on POSIX): standalone runs hand
the pty master fd the number 3, and reading that would steal pty output
from the main loop.
"""
import fcntl
import os
import pty
import select
import signal
import stat
import struct
import sys
import termios
import threading

MAX_COLS = 500
MAX_ROWS = 200
MAX_RESIZE_LINE = 64


def _apply_resize(master_fd, child_pid, cols, rows):
    try:
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ,
                    struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        return
    try:
        os.kill(child_pid, signal.SIGWINCH)
    except OSError:
        pass


def _resize_loop(master_fd, child_pid):
    # Never assume fd 3 is the control pipe: when the helper runs
    # standalone (no fd3), pty.fork() hands the master fd the number 3,
    # and reading it here would steal pty output from the main loop.
    # The provider's control channel is a Node stdio pipe, which on
    # POSIX is a Unix socket (not a FIFO); the master is a character
    # device. Accept FIFO or socket, reject anything else.
    try:
        mode = os.fstat(3).st_mode
    except OSError:
        return
    if not (stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)):
        return
    try:
        stream = os.fdopen(3, "rb", buffering=0)
    except OSError:
        return
    buffer = b""
    try:
        while True:
            try:
                chunk = stream.read(4096)
            except OSError:
                return
            if not chunk:
                return
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if len(line) > MAX_RESIZE_LINE:
                    continue
                parts = line.split()
                if len(parts) != 2:
                    continue
                try:
                    cols = int(parts[0])
                    rows = int(parts[1])
                except ValueError:
                    continue
                if str(cols).encode() != parts[0] or str(rows).encode() != parts[1]:
                    continue
                if not 1 <= cols <= MAX_COLS or not 1 <= rows <= MAX_ROWS:
                    continue
                _apply_resize(master_fd, child_pid, cols, rows)
            if len(buffer) > MAX_RESIZE_LINE:
                buffer = b""
    except (OSError, ValueError):
        return
    finally:
        try:
            stream.close()
        except OSError:
            pass


def main():
    argv = sys.argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    if not argv:
        return 2
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        except OSError:
            os._exit(127)
    resize_thread = threading.Thread(target=_resize_loop, args=(fd, pid),
                                     daemon=True)
    resize_thread.start()
    status = None
    try:
        while True:
            readable, _, _ = select.select([fd, sys.stdin.buffer], [], [])
            if fd in readable:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            if sys.stdin.buffer in readable:
                data = sys.stdin.buffer.read1(65536)
                if not data:
                    try:
                        os.kill(pid, signal.SIGHUP)
                    except OSError:
                        pass
                    break
                os.write(fd, data)
    finally:
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass
    if status is not None and os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    return 1


if __name__ == "__main__":
    sys.exit(main())
