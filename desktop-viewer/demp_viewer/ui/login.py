"""Login window — light theme, DEMP branding, Powered by Analysys lockup.

Kept intentionally light (white bg, DEMP-green accent, Segoe UI) — the
operator asked for the old look back. The dark navy variant was moved
to the reject pile.
"""
from __future__ import annotations

import os
import sys
import tkinter as tk
from tkinter import ttk, messagebox
from pathlib import Path

from demp_viewer.api import DempClient, AuthError


# ── Light theme tokens ─────────────────────────────────────────────
BG        = "#FFFFFF"
CARD_BG   = "#F8FAFC"
LINE      = "#E2E8F0"
TXT       = "#0F172A"
MUTED     = "#475569"
MUTED_2   = "#94A3B8"
DEMP_GRN  = "#166534"   # Pakistan green — the official DEMP wordmark colour
DEMP_GRN2 = "#14532D"


def _assets_dir() -> Path:
    base = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for cand in (Path(base) / "assets", Path(base) / "demp_viewer" / "assets"):
        if cand.exists():
            return cand
    return Path(base)


def do_login(client: DempClient, initial_email: str = "",
             initial_api_base: str = "") -> tuple[str, str] | None:
    """Blocks until sign-in succeeds. Returns (email, api_base) or None."""

    root = tk.Tk()
    root.title("CMC Viewer — Sign in")
    root.configure(bg=BG)
    root.resizable(False, False)

    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("pk.gov.pak-navy.cmc.viewer")
        except Exception:
            pass
    ico = _assets_dir() / "demp.ico"
    if ico.exists():
        try:
            root.iconbitmap(default=str(ico))
            root.wm_iconbitmap(str(ico))
        except Exception:
            pass

    W, H = 500, 600
    try:
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        root.geometry(f"{W}x{H}+{max(0,(sw-W)//2)}+{max(0,(sh-H)//3)}")
    except Exception:
        root.geometry(f"{W}x{H}")

    state: dict[str, str | None] = {"email": None, "api_base": initial_api_base}

    # ── Header ─ DEMP crest (larger) + green wordmark ──────────────
    header = tk.Frame(root, bg=BG)
    header.pack(fill="x", pady=(28, 4))

    _logo = None
    logo_path = _assets_dir() / "demp-header-lg.png"
    if not logo_path.exists():
        logo_path = _assets_dir() / "demp-header.png"
    if logo_path.exists():
        try:
            img = tk.PhotoImage(file=str(logo_path))
            target = 120
            h = img.height()
            factor = max(1, round(h / target))
            _logo = img.subsample(factor, factor) if factor > 1 else img
            tk.Label(header, image=_logo, bg=BG).pack()
        except Exception:
            pass

    tk.Label(header, text="PAK NAVY", bg=BG, fg=DEMP_GRN,
             font=("Segoe UI", 26, "bold")).pack(pady=(6, 0))

    tk.Label(root, text="Government of Pakistan · Pakistan Navy",
             bg=BG, fg=MUTED_2, font=("Segoe UI", 8)).pack(pady=(2, 2))
    tk.Label(root, text="Channel Monitoring & Clipping",
             bg=BG, fg=MUTED, font=("Segoe UI", 9)).pack(pady=(0, 20))

    # ── Form ────────────────────────────────────────────────────
    frm = tk.Frame(root, bg=BG)
    frm.pack(fill="x", padx=48)

    def _row(label: str, secret: bool = False, default: str = "") -> tuple[tk.StringVar, ttk.Entry]:
        tk.Label(frm, text=label, bg=BG, fg=TXT,
                 font=("Segoe UI", 9, "bold")).pack(anchor="w", pady=(8, 3))
        v = tk.StringVar(value=default)
        e = ttk.Entry(frm, textvariable=v, show="•" if secret else "", font=("Segoe UI", 10))
        e.pack(fill="x", ipady=4)
        return v, e

    api_var,   api_e   = _row("Server",   default=initial_api_base or "http://172.16.205.21:4001")
    email_var, email_e = _row("Email",    default=initial_email)
    pw_var,    pw_e    = _row("Password", secret=True)

    # ttk theme + DEMP-green sign-in button
    style = ttk.Style()
    try: style.theme_use("clam")
    except Exception: pass
    style.configure("DEMP.TButton",
                    background=DEMP_GRN, foreground="white",
                    font=("Segoe UI", 11, "bold"),
                    padding=(24, 10), borderwidth=0)
    style.map("DEMP.TButton",
              background=[("active", DEMP_GRN2), ("pressed", DEMP_GRN2)])

    btn = ttk.Button(root, text="Sign in", style="DEMP.TButton")
    btn.pack(fill="x", padx=48, pady=(20, 14))

    tk.Label(root,
             text="Access to this system is monitored. All activity is recorded to an immutable audit log.",
             bg=BG, fg=MUTED_2, font=("Segoe UI", 7),
             wraplength=380, justify="center").pack(padx=48)

    # ── Powered by Analysys — official supplied lockup ─────────────
    pby = tk.Frame(root, bg=BG)
    pby.pack(side="bottom", pady=(14, 20))
    _alogo = None
    pby_path = _assets_dir() / "powered-by-analysys.png"
    if pby_path.exists():
        try:
            img = tk.PhotoImage(file=str(pby_path))
            target = 48
            h = img.height()
            factor = max(1, round(h / target))
            _alogo = img.subsample(factor, factor) if factor > 1 else img
            tk.Label(pby, image=_alogo, bg=BG).pack()
        except Exception:
            tk.Label(pby, text="Powered by  ANALYSYS", bg=BG, fg=TXT,
                     font=("Segoe UI", 10, "bold")).pack()
    else:
        tk.Label(pby, text="Powered by  ANALYSYS", bg=BG, fg=TXT,
                 font=("Segoe UI", 10, "bold")).pack()

    # keep image refs alive
    root._demp_logo = _logo          # type: ignore[attr-defined]
    root._analysys_logo = _alogo     # type: ignore[attr-defined]

    def submit(_event=None):
        email = email_var.get().strip()
        pw = pw_var.get()
        api_base = api_var.get().strip().rstrip("/")
        if not email or not pw:
            messagebox.showwarning("PAK NAVY", "Email and password required", parent=root)
            return
        if not api_base:
            messagebox.showwarning("PAK NAVY", "Server URL required", parent=root)
            return
        btn.configure(state="disabled", text="Signing in…")
        root.update_idletasks()
        client.base = api_base
        try:
            client.login(email, pw)
            state["email"] = email
            state["api_base"] = api_base
            root.destroy()
        except AuthError as e:
            messagebox.showerror("Sign-in failed", str(e), parent=root)
            btn.configure(state="normal", text="Sign in")
        except Exception as e:
            messagebox.showerror("Sign-in failed", str(e), parent=root)
            btn.configure(state="normal", text="Sign in")

    btn.configure(command=submit)
    root.bind("<Return>", submit)
    root.bind("<Escape>", lambda _e: root.destroy())
    (pw_e if initial_email else email_e).focus_set()

    # Bring window forward on start
    root.attributes("-topmost", True)
    root.after(400, lambda: root.attributes("-topmost", False))
    root.lift(); root.focus_force()
    if sys.platform == "win32":
        try:
            import ctypes
            u32 = ctypes.windll.user32; k32 = ctypes.windll.kernel32
            hwnd = u32.GetParent(root.winfo_id()) or root.winfo_id()
            fg = u32.GetForegroundWindow()
            fg_pid = ctypes.c_ulong(0)
            fg_tid = u32.GetWindowThreadProcessId(fg, ctypes.byref(fg_pid))
            cur_tid = k32.GetCurrentThreadId()
            u32.AttachThreadInput(cur_tid, fg_tid, True)
            u32.ShowWindow(hwnd, 9)
            u32.SetForegroundWindow(hwnd)
            u32.SetFocus(hwnd)
            u32.AttachThreadInput(cur_tid, fg_tid, False)
            u32.FlashWindow(hwnd, True)
        except Exception:
            pass

    root.mainloop()
    if state["email"] is None:
        return None
    return (state["email"], state["api_base"] or "")
