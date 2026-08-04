"""Main wall window — light theme + DEMP branding + fluid grid."""
from __future__ import annotations

import os
import sys
import tkinter as tk
from tkinter import ttk, messagebox
from pathlib import Path
from typing import Optional

from demp_viewer.api import Channel, DempClient, AuthError
from demp_viewer.config import Config, save_config
from demp_viewer.ui.tile import ChannelTile
from demp_viewer.ui.channel_picker import pick_channel


GRID_OPTIONS: list[tuple[int, int, str]] = [
    (1, 1, "1 × 1"),
    (2, 2, "2 × 2"),
    (3, 3, "3 × 3"),
    (4, 4, "4 × 4"),
    (5, 5, "5 × 5"),
    (6, 6, "6 × 6"),
    (8, 4, "8 × 4 (32)"),
    # CMC has only 32 channels total and every -lo transcode is kept
    # ALWAYS WARM on the server via runOnInit, so a big wall doesn't
    # trigger cold-start pileup. -lo is 480 p at ~700 kbps, so a full
    # 32-tile view over LAN is ~22 Mbps in — trivially decodable on
    # any modern desktop, and same-network operators can run this
    # without a client-side bottleneck.
]


def _assets_dir() -> Path:
    base = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for cand in (Path(base) / "assets", Path(base) / "demp_viewer" / "assets"):
        if cand.exists():
            return cand
    return Path(base)


class WallWindow:
    def __init__(self, root: tk.Tk, client: DempClient, cfg: Config):
        self.root = root
        self.client = client
        self.cfg = cfg
        self.channels: list[Channel] = []
        self.tiles: list[ChannelTile] = []
        self._solo: Optional[ChannelTile] = None
        # Snap a stale saved grid (from an older build that offered 5x5 etc.)
        # into whatever the current GRID_OPTIONS list allows. Prevents the
        # dropdown from showing an unselectable value and stalling.
        allowed = {(c, r) for c, r, _ in GRID_OPTIONS}
        if (cfg.grid_cols, cfg.grid_rows) not in allowed:
            cfg.grid_cols, cfg.grid_rows = GRID_OPTIONS[-1][0], GRID_OPTIONS[-1][1]
            save_config(cfg)
        self._logo_img: tk.PhotoImage | None = None
        self._analysys_img: tk.PhotoImage | None = None

        root.title("CMC Video Wall — Powered by Analysys")
        root.geometry("1600x900")
        root.configure(bg="#FFFFFF")
        root.protocol("WM_DELETE_WINDOW", self._on_close)

        # Windows taskbar icon: bind our app to a distinct AppUserModelID
        # so Explorer stops falling back to the python.exe feather icon.
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

        self._build_toolbar()
        # Grid: flush against the toolbar, faint hair-line divider between
        # tiles supplied by the grid_frame background bleeding through the
        # 1 px gap set by `padx=1 pady=1`. No extra padding at the outer
        # edge — the wall fills the window.
        self.grid_frame = tk.Frame(root, bg="#D9DEE7")   # divider line colour
        self.grid_frame.pack(fill="both", expand=True, padx=0, pady=0)

        root.bind("<F11>", lambda _e: self._toggle_fullscreen())
        root.bind("<Escape>", lambda _e: self._on_escape())

        # Force to front (Windows Explorer focus-stealing prevention)
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
                u32.ShowWindow(hwnd, 3)   # SW_MAXIMIZE
                u32.SetForegroundWindow(hwnd)
                u32.AttachThreadInput(cur_tid, fg_tid, False)
            except Exception:
                pass

        self._refresh_channels_async()

    # ------------------------------------------------------------ toolbar --

    def _build_toolbar(self) -> None:
        bar = tk.Frame(self.root, bg="#FFFFFF", height=56)
        bar.pack(fill="x", side="top")
        bar.pack_propagate(False)
        # Bottom divider
        tk.Frame(self.root, bg="#E5E9F0", height=1).place(x=0, y=56, relwidth=1)

        # DEMP logo (small)
        logo_path = _assets_dir() / "demp-header.png"
        if logo_path.exists():
            try:
                self._logo_img = tk.PhotoImage(file=str(logo_path))
                # PhotoImage doesn't resize gracefully — subsample to ~32 px tall
                factor = max(1, self._logo_img.height() // 34)
                self._logo_img = self._logo_img.subsample(factor, factor)
                tk.Label(bar, image=self._logo_img, bg="#FFFFFF").pack(side="left", padx=(12, 8))
            except Exception:
                pass

        # DEMP wordmark in Pakistan green
        tk.Label(bar, text="PAK NAVY", bg="#FFFFFF", fg="#166534",
                 font=("Segoe UI", 16, "bold")).pack(side="left")
        tk.Label(bar, text="  Video Wall", bg="#FFFFFF", fg="#334155",
                 font=("Segoe UI", 11)).pack(side="left")

        # Right side: unified Powered-by-Analysys lockup image + channel count
        right = tk.Frame(bar, bg="#FFFFFF")
        right.pack(side="right", padx=14)

        self.status_var = tk.StringVar(value="Loading channels…")
        tk.Label(right, textvariable=self.status_var, bg="#FFFFFF", fg="#64748B",
                 font=("Segoe UI", 9)).pack(side="right", padx=(14, 0))

        # Official supplied "Powered by Analysys" lockup — same PNG as
        # the web app so the branding is byte-identical across surfaces.
        pby_path = _assets_dir() / "powered-by-analysys.png"
        if pby_path.exists():
            try:
                img = tk.PhotoImage(file=str(pby_path))
                # Target ~36 px tall; PhotoImage.subsample is integer-only,
                # so pick the factor that gets closest without over-cropping.
                target = 36
                h = img.height()
                factor = max(1, round(h / target))
                self._analysys_img = img.subsample(factor, factor) if factor > 1 else img
                tk.Label(right, image=self._analysys_img, bg="#FFFFFF").pack(side="right")
            except Exception:
                tk.Label(right, text="Powered by Analysys", bg="#FFFFFF", fg="#334155",
                         font=("Segoe UI", 9, "bold")).pack(side="right")

        # Grid selector + controls (middle-left)
        controls = tk.Frame(bar, bg="#FFFFFF")
        controls.pack(side="left", padx=(24, 0))
        tk.Label(controls, text="Grid", bg="#FFFFFF", fg="#64748B",
                 font=("Segoe UI", 9)).pack(side="left")
        self.grid_var = tk.StringVar(value=self._grid_label(self.cfg.grid_cols, self.cfg.grid_rows))
        style = ttk.Style()
        try:
            style.theme_use("clam")
        except Exception:
            pass
        cb = ttk.Combobox(
            controls, textvariable=self.grid_var, state="readonly", width=8,
            values=[lbl for _, _, lbl in GRID_OPTIONS],
        )
        cb.pack(side="left", padx=(6, 12))
        cb.bind("<<ComboboxSelected>>", lambda _e: self._on_grid_change())

        ttk.Button(controls, text="Refresh channels",
                   command=self._refresh_channels_async).pack(side="left", padx=4)
        ttk.Button(controls, text="Fullscreen (F11)",
                   command=self._toggle_fullscreen).pack(side="left", padx=4)

    def _grid_label(self, cols: int, rows: int) -> str:
        for c, r, lbl in GRID_OPTIONS:
            if c == cols and r == rows:
                return lbl
        return f"{cols} × {rows}"

    def _on_grid_change(self) -> None:
        label = self.grid_var.get()
        for c, r, lbl in GRID_OPTIONS:
            if lbl == label:
                self.cfg.grid_cols = c
                self.cfg.grid_rows = r
                save_config(self.cfg)
                self._rebuild_grid()
                return

    def _toggle_fullscreen(self) -> None:
        self.root.attributes("-fullscreen", not bool(self.root.attributes("-fullscreen")))

    def _on_escape(self) -> None:
        if self.root.attributes("-fullscreen"):
            self.root.attributes("-fullscreen", False)
        elif self._solo is not None:
            self._exit_solo()

    def _on_close(self) -> None:
        # Closing a wall of 16 VLC players synchronously can take
        # ~30 s — vlc.MediaPlayer.stop() waits for its decoder threads
        # to unwind, and each does DNS/TCP cleanup. Kick the cleanup
        # into a background thread and force-exit the process so the
        # window vanishes immediately.
        import threading
        def _drain():
            for t in self.tiles:
                try: t.stop()
                except Exception: pass
        threading.Thread(target=_drain, daemon=True).start()
        try:
            self.root.quit()
            self.root.destroy()
        except Exception:
            pass
        # Bypass Python's normal shutdown so hung native threads don't
        # keep the process alive.
        import os
        os._exit(0)

    # -------------------------------------------------------------- data --

    def _refresh_channels_async(self) -> None:
        """Fetches the channel list in a WORKER thread and applies the
        result back on the Tk main thread. list_channels() does a
        blocking HTTP round-trip; running it on the main thread was
        what made the window title flash 'Not Responding' every time
        the operator clicked Refresh channels (and on start-up).
        """
        self.status_var.set("Loading channels…")

        def _work() -> None:
            try:
                channels = [c for c in self.client.list_channels() if c.active]
                self.root.after(0, lambda: self._apply_channels(channels))
            except AuthError:
                self.root.after(0, self._on_channels_auth_expired)
            except Exception as e:  # noqa: BLE001
                self.root.after(0, lambda err=e: self._on_channels_load_failed(err))

        import threading
        threading.Thread(target=_work, daemon=True, name="channels-refresh").start()

    def _apply_channels(self, channels: list[Channel]) -> None:
        self.channels = channels
        self.status_var.set(f"{len(self.channels)} channels")
        self._rebuild_grid()

    def _on_channels_auth_expired(self) -> None:
        self.status_var.set("Session expired — please sign in again")
        self._reauthenticate()

    def _on_channels_load_failed(self, err: BaseException) -> None:
        self.status_var.set("Load failed")
        messagebox.showerror("PAK NAVY", f"Failed to load channels:\n{err}")

    def _reauthenticate(self) -> None:
        from demp_viewer.ui.login import do_login
        from demp_viewer.config import save_config
        # Blank the token so the login window shows.
        self.cfg.access_token = None
        self.client.set_token(None)
        result = do_login(self.client, self.cfg.email or "", self.cfg.api_base or "")
        if not self.client.access_token or result is None:
            messagebox.showwarning("PAK NAVY", "Sign-in cancelled — you can retry from the toolbar.")
            return
        email, api_base = result
        self.cfg.email = email or self.cfg.email
        if api_base:
            self.cfg.api_base = api_base
        self.cfg.access_token = self.client.access_token
        save_config(self.cfg)
        # Now retry the refresh with the fresh token.
        self._refresh_channels_async()

    # -------------------------------------------------------------- grid --

    def _rebuild_grid(self) -> None:
        for t in self.tiles:
            t.stop(); t.destroy()
        self.tiles = []
        for w in self.grid_frame.winfo_children():
            w.destroy()
        self._solo = None

        cols, rows = self.cfg.grid_cols, self.cfg.grid_rows

        # Configure grid weights so tiles FILL the container evenly.
        # uniform= ensures equal-sized cells even when tiles have different
        # requested sizes.
        for i in range(cols):
            self.grid_frame.columnconfigure(i, weight=1, uniform="tile-c", minsize=1)
        for j in range(rows):
            self.grid_frame.rowconfigure(j, weight=1, uniform="tile-r", minsize=1)
        # Clear any columns beyond our current grid so old weights don't
        # leave phantom columns pushing tiles left.
        for i in range(cols, cols + 20):
            self.grid_frame.columnconfigure(i, weight=0, uniform="", minsize=0)
        for j in range(rows, rows + 20):
            self.grid_frame.rowconfigure(j, weight=0, uniform="", minsize=0)

        # ONLY the operator's remembered channels are auto-loaded. If a
        # slot has no saved channel (e.g. fresh install, or user cleared
        # it), tile stays empty — user picks via right-click. Was
        # auto-filling every empty slot with the next channel, which
        # spammed 9 streams before the user could even choose.
        preferred = self.cfg.wall_channel_ids or []
        chosen: list[Channel | None] = []
        by_id = {c.id: c for c in self.channels}
        for cid in preferred[: cols * rows]:
            chosen.append(by_id.get(cid))    # None if the saved id no longer exists
        while len(chosen) < cols * rows:
            chosen.append(None)

        total_tiles = cols * rows
        prefer_lo = total_tiles >= ChannelTile.LOWRES_THRESHOLD_TILES

        # Stagger tile play() calls so the main loop isn't wedged with 9
        # simultaneous DNS/VLC-attach calls (which is what made the
        # window title flash 'Not Responding' for a few seconds on
        # start-up). Each tile's play() is threaded internally too, but
        # spreading them 60 ms apart keeps the OS scheduler happy.
        for idx, ch in enumerate(chosen):
            r, c = divmod(idx, cols)
            tile = ChannelTile(self.grid_frame, on_change_channel=self._on_change_channel, prefer_lo=prefer_lo)
            tile.grid(row=r, column=c, sticky="nsew", padx=1, pady=1)  # 1 px = hairline divider
            self.tiles.append(tile)
            if ch is not None:
                self.root.after(60 * idx, lambda t=tile, c=ch: t.play(c))
            else:
                tile.show_placeholder("(empty)")

        self._save_layout()

    def _save_layout(self) -> None:
        ids: list[str] = []
        for t in self.tiles:
            ids.append(t.channel.id if t.channel else "")
        self.cfg.wall_channel_ids = ids
        save_config(self.cfg)

    # ---------------------------------------------------------- tile ops --

    def _on_change_channel(self, tile: ChannelTile) -> None:
        picked = pick_channel(self.root, self.channels)
        if picked is None:
            return
        tile.play(picked)
        self._save_layout()

    def solo_tile(self, tile: ChannelTile) -> None:
        if self._solo is tile:
            self._exit_solo(); return
        if self._solo is not None:
            self._exit_solo()
        for t in self.tiles:
            if t is not tile:
                t.grid_forget()
        tile.grid(row=0, column=0, sticky="nsew",
                  rowspan=max(1, self.cfg.grid_rows), columnspan=max(1, self.cfg.grid_cols))
        self._solo = tile

    def _exit_solo(self) -> None:
        if self._solo is None:
            return
        self._solo.grid_forget()
        cols = self.cfg.grid_cols
        for idx, tile in enumerate(self.tiles):
            r, c = divmod(idx, cols)
            tile.grid(row=r, column=c, sticky="nsew", padx=3, pady=3)
        self._solo = None
