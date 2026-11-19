"""meridian-intel CLI.

  meridian-intel run [--demo] [--no-open] [--port N]   start the local workstation (opens a window)
  meridian-intel open                                   open a window to the running instance
  meridian-intel launch                                 start if needed, then open (desktop entry)
  meridian-intel keys list | set NAME | delete NAME     API keys in GNOME Keyring
  meridian-intel audit verify | export [CASE]           OSINT audit log
"""
from __future__ import annotations

import argparse
import getpass
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import __version__, secrets
from .config import settings


def _token_file() -> Path:
    rt = os.environ.get("XDG_RUNTIME_DIR") or str(settings.data_dir)
    return Path(rt) / "meridian-intel.url"


def open_window(url: str) -> None:
    """Open an app-style window: Brave/Chrome Flatpak --app (no tabs, own window), else the default browser."""
    for app_id in ("com.brave.Browser", "com.google.Chrome", "org.chromium.Chromium"):
        if shutil.which("flatpak") and subprocess.run(["flatpak", "info", app_id], capture_output=True).returncode == 0:
            subprocess.Popen(["flatpak", "run", app_id, f"--app={url}", "--class=MeridianIntel"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            return
    subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def cmd_run(a) -> int:
    import uvicorn  # noqa: PLC0415

    from . import server  # noqa: PLC0415
    if a.demo:
        settings.demo = True
    if a.port:
        settings.port = a.port
    settings.ensure()
    token = server.new_token()
    url = f"http://127.0.0.1:{settings.port}/?t={token}"
    tf = _token_file()
    tf.write_text(url)
    tf.chmod(0o600)
    print(f"Meridian Intel {__version__}{' (DEMO DATA)' if settings.demo else ''}: {url}", flush=True)
    if not a.no_open:
        threading.Timer(1.2, open_window, args=(url,)).start()
    try:
        uvicorn.run(server.app, host="127.0.0.1", port=settings.port, log_level="warning", access_log=False)
    finally:
        tf.unlink(missing_ok=True)
    return 0


def cmd_open(_a) -> int:
    tf = _token_file()
    if not tf.exists():
        print("Meridian Intel is not running (systemctl --user start meridian-intel).", file=sys.stderr)
        return 1
    open_window(tf.read_text().strip())
    return 0


def _alive(url: str) -> bool:
    import urllib.request  # noqa: PLC0415
    base = url.split("/?")[0]
    try:
        urllib.request.urlopen(base + "/api/status", timeout=1.5)  # noqa: S310 (localhost)
    except urllib.error.HTTPError as e:
        return e.code == 401          # server is up, just wants the token
    except OSError:
        return False
    return True


def cmd_launch(_a) -> int:
    """Desktop entry: open a window to the running daemon, starting it first if needed."""
    tf = _token_file()
    if tf.exists() and _alive(tf.read_text().strip()):
        open_window(tf.read_text().strip())
        return 0
    if shutil.which("systemctl") and subprocess.run(["systemctl", "--user", "cat", "meridian-intel.service"],
                                                     capture_output=True).returncode == 0:
        subprocess.run(["systemctl", "--user", "start", "meridian-intel.service"], check=False)
    else:
        subprocess.Popen([sys.executable, "-m", "meridian_intel", "run", "--no-open"], start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        time.sleep(0.25)
        if tf.exists() and _alive(tf.read_text().strip()):
            open_window(tf.read_text().strip())
            return 0
    print("Meridian Intel did not start; see: journalctl --user -u meridian-intel", file=sys.stderr)
    return 1


def cmd_keys(a) -> int:
    if a.action == "list":
        for k, ok in secrets.status().items():
            print(f"  {'set ' if ok else '----'}  {k:14} {secrets.KNOWN[k]}")
        return 0
    if not a.name:
        print("name required", file=sys.stderr)
        return 2
    if a.action == "set":
        val = getpass.getpass(f"{a.name} (input hidden): ").strip()
        if not val:
            return 1
        secrets.set_(a.name, val)
        print("stored in GNOME Keyring")
    elif a.action == "delete":
        secrets.delete(a.name)
        print("deleted")
    return 0


def cmd_audit(a) -> int:
    from .db import DB  # noqa: PLC0415
    from .osint import audit  # noqa: PLC0415
    settings.ensure()
    db = DB(settings.db_path)
    if a.action == "verify":
        r = audit.verify(db)
        print(("OK " if r["ok"] else "BROKEN ") + str(r))
        return 0 if r["ok"] else 1
    sys.stdout.write(audit.export_csv(db, a.case))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="meridian-intel", description="Meridian Intel workstation")
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--demo", action="store_true", help="synthetic data, no network feeds")
    r.add_argument("--no-open", action="store_true")
    r.add_argument("--port", type=int)
    r.set_defaults(fn=cmd_run)
    sub.add_parser("open").set_defaults(fn=cmd_open)
    sub.add_parser("launch").set_defaults(fn=cmd_launch)
    k = sub.add_parser("keys")
    k.add_argument("action", choices=["list", "set", "delete"])
    k.add_argument("name", nargs="?", choices=list(secrets.KNOWN))
    k.set_defaults(fn=cmd_keys)
    au = sub.add_parser("audit")
    au.add_argument("action", choices=["verify", "export"])
    au.add_argument("case", nargs="?")
    au.set_defaults(fn=cmd_audit)
    a = p.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
