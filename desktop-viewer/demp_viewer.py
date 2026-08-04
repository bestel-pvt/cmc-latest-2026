"""DEMP Desktop Viewer — entry point.

Boots the login window; on success, opens the main wall.

If anything blows up before the UI can render (typical .exe pain: bad VLC
DLL, missing DEP, silently killed by A/V), we write a crash log to
%APPDATA%/DEMP-Viewer/crash.log AND pop up a native message box so the
operator sees something instead of "task manager shows it but no window".
"""
from __future__ import annotations

import ctypes
import os
import sys

# CRITICAL: on Linux, Xlib must be told the process is going to touch
# X from multiple threads BEFORE any window is opened. libvlc runs its
# decoder + video-out in its own thread; if XInitThreads() hasn't been
# called first, set_xwindow() attaches to an X connection that isn't
# thread-safe and libvlc silently produces zero frames — exactly the
# "channel name shows but no video" bug on the R740xd.
#
# Windows / macOS have no equivalent — silently no-op.
if sys.platform.startswith("linux"):
    try:
        _x11 = ctypes.CDLL("libX11.so.6")
        _x11.XInitThreads()
    except Exception:
        pass
    # Force X11 backend even if the user is on a Wayland session
    # (Tkinter uses XWayland so we're on Xorg anyway; this just makes
    # sure any subprocess VLC spawns doesn't try to pick Wayland).
    os.environ.setdefault("GDK_BACKEND", "x11")

import tkinter as tk
import traceback
from pathlib import Path

# ---------------------------------------------------------------------------
# Boot log — the very first thing we do. Writes to
# %APPDATA%/DEMP-Viewer/boot.log so we can diagnose 'nothing happens on
# double-click' cases where even the crash reporter never runs.
# ---------------------------------------------------------------------------
try:
    _BOOT_DIR = Path(os.environ.get("APPDATA", str(Path.home()))) / "DEMP-Viewer"
    _BOOT_DIR.mkdir(parents=True, exist_ok=True)
    _BOOT_LOG = open(_BOOT_DIR / "boot.log", "a", encoding="utf-8", buffering=1)
    from datetime import datetime
    _BOOT_LOG.write(f"\n=== {datetime.now().isoformat()}  boot v{sys.version.split()[0]} ===\n")
    _BOOT_LOG.write(f"  argv={sys.argv}\n  executable={sys.executable}\n  frozen={getattr(sys, 'frozen', False)}\n")
    _BOOT_LOG.write(f"  meipass={getattr(sys, '_MEIPASS', None)}\n")
    def _blog(m: str) -> None:
        try: _BOOT_LOG.write(f"  {m}\n")
        except Exception: pass
except Exception:
    def _blog(m: str) -> None: pass


def _crash_report(msg: str) -> None:
    """Persist + surface a fatal-startup error so the user isn't left staring
    at Task Manager. Called before Tk's mainloop is running."""
    from datetime import datetime
    log_dir = Path(os.environ.get("APPDATA", str(Path.home()))) / "DEMP-Viewer"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        with open(log_dir / "crash.log", "a", encoding="utf-8") as f:
            f.write(f"\n=== {datetime.now().isoformat()} ===\n{msg}\n")
    except Exception:
        pass
    # MB_OK|MB_ICONERROR — works even if Tk itself is dead.
    try:
        if sys.platform == "win32":
            ctypes.windll.user32.MessageBoxW(0, msg[-1200:], "DEMP Viewer — Startup Failure", 0x00000010)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Locate a working libvlc.dll BEFORE importing anything that touches vlc.
# ---------------------------------------------------------------------------

def _bootstrap_vlc() -> None:
    """Locate libvlc so python-vlc's find_lib succeeds on both Windows and Linux.
    On Linux we also seed VLC_PLUGIN_PATH — without it VLC silently loads
    zero plugins and every media player produces a black frame."""
    base = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(__file__))
    if sys.platform == "win32":
        libname = "libvlc.dll"
        candidates = [
            Path(base),
            Path(base) / "vlc",
            Path(base) / "vendor" / "vlc",
            Path(r"C:\Program Files\VideoLAN\VLC"),
            Path(r"C:\Program Files (x86)\VideoLAN\VLC"),
        ]
    else:
        libname = "libvlc.so.5"
        candidates = [
            Path(base),
            Path(base) / "vlc",
            Path(base) / "vendor" / "vlc",
            Path("/usr/lib/x86_64-linux-gnu"),
            Path("/usr/lib"),
            Path("/usr/local/lib"),
        ]
    for c in candidates:
        if (c / libname).exists():
            if sys.platform == "win32":
                try: os.add_dll_directory(str(c))
                except (OSError, AttributeError): pass
                os.environ["PATH"] = str(c) + os.pathsep + os.environ.get("PATH", "")
            else:
                os.environ["LD_LIBRARY_PATH"] = str(c) + os.pathsep + os.environ.get("LD_LIBRARY_PATH", "")
            # Plugins: try adjacent /plugins, then /vlc/plugins (Debian layout)
            for plugins in (c / "plugins", c / "vlc" / "plugins", Path("/usr/lib/x86_64-linux-gnu/vlc/plugins")):
                if plugins.exists():
                    os.environ["VLC_PLUGIN_PATH"] = str(plugins)
                    break
            return


def _main_inner() -> int:
    _blog("bootstrap_vlc")
    _bootstrap_vlc()

    _blog("importing app modules")
    # Deferred imports so any failure lands inside our top-level try/except.
    from demp_viewer.config import load_config, save_config
    from demp_viewer.api import DempClient, AuthError
    from demp_viewer.ui.login import do_login
    from demp_viewer.ui.wall import WallWindow

    _blog("import vlc")
    try:
        import vlc  # noqa: F401
        _blog(f"  vlc version: {vlc.libvlc_get_version().decode()}")
    except Exception as e:
        _blog(f"  vlc import FAILED: {e}")
        _crash_report(
            f"VLC library failed to load.\n\n{traceback.format_exc()}\n\n"
            f"Please install VLC 3.x 64-bit from https://www.videolan.org/vlc/ "
            f"and try again."
        )
        return 3

    _blog("load config")
    cfg = load_config()

    client = DempClient(cfg.api_base)
    if cfg.access_token:
        client.set_token(cfg.access_token)
        try:
            client.list_channels()
        except AuthError:
            cfg.access_token = None
        except Exception:
            # Network hiccup shouldn't prevent showing the login dialog.
            cfg.access_token = None

    if not cfg.access_token:
        _blog("do_login (its own Tk root)")
        result = do_login(client, cfg.email or "", cfg.api_base or "")
        if not client.access_token or result is None:
            _blog("login cancelled — exit")
            return 1
        email, api_base = result
        cfg.email = email or cfg.email
        if api_base:
            cfg.api_base = api_base
        cfg.access_token = client.access_token
        save_config(cfg)
        _blog("login OK, token saved")

    _blog("Tk() for wall")
    root = tk.Tk()

    # Set the DEMP icon (inherited by every child window).
    base = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(__file__))
    for ico_name in ("demp.ico", os.path.join("assets", "demp.ico"),
                     os.path.join("demp_viewer", "assets", "demp.ico")):
        icop = Path(base) / ico_name
        if icop.exists():
            try:
                root.iconbitmap(default=str(icop))
            except Exception:
                pass
            break

    _blog("building WallWindow")
    WallWindow(root, client, cfg)
    _blog("entering mainloop")
    root.mainloop()
    _blog("mainloop exited")
    return 0


def main() -> int:
    try:
        return _main_inner()
    except SystemExit:
        raise
    except BaseException:
        _crash_report(traceback.format_exc())
        return 2


if __name__ == "__main__":
    sys.exit(main())
