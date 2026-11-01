"""PTY bridge for openclaw-workbench (POSIX only).

The Node provider spawns this helper with shell:false and a target argv
after a '--' separator. The helper allocates a pty with pty.fork(), runs
the target as the pty child, copies master output to stdout and stdin to
the master, and exits with the child's exit code. It never prints the
target argv, environment, or any secret material; on stdin EOF it sends
SIGHUP to the child instead of waiting forever.
"""
import os
import pty
import select
import signal
import sys


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
