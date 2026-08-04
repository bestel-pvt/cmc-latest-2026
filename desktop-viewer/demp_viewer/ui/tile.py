"""Single video-wall tile — clean, flush-fit, threaded VLC init."""
from __future__ import annotations

import socket
import sys
import threading
import tkinter as tk
import urllib.parse
from typing import Optional

try:
    import vlc  # type: ignore
except Exception as e:  # noqa: BLE001
    vlc = None  # type: ignore
    _VLC_ERR = str(e)
else:
    _VLC_ERR = ""

from demp_viewer.api import Channel


def _prewarm_rtsp(url: str) -> None:
    """Fire an RTSP OPTIONS at the -lo path so mediamtx starts spawning
    its ffmpeg transcoder BEFORE VLC even opens the connection. Cuts
    the perceived cold-start by ~2-3 s (mediamtx and ffmpeg init in
    parallel with VLC's own DNS+TCP+DESCRIBE). Non-blocking — this
    runs on a daemon thread and any failure is ignored."""
    try:
        u = urllib.parse.urlparse(url)
        host = u.hostname or ""
        port = u.port or 8554
        path = u.path or "/"
        if not host:
            return
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(2.0)
        s.connect((host, port))
        req = (
            f"OPTIONS {url} RTSP/1.0\r\n"
            f"CSeq: 1\r\n"
            f"User-Agent: demp-viewer/warmup\r\n"
            f"\r\n"
        ).encode("ascii", errors="ignore")
        s.sendall(req)
        # Read at most one packet — we only care about triggering
        # mediamtx's runOnDemand, not about the reply.
        try: s.recv(256)
        except Exception: pass
        s.close()
    except Exception:
        pass
    _ = path  # silence unused


_VLC_INSTANCE = None
_VLC_LOCK = threading.Lock()


def _get_vlc_instance():
    global _VLC_INSTANCE
    if vlc is None:
        return None
    with _VLC_LOCK:
        if _VLC_INSTANCE is None:
            args = [
                "--no-audio",
                # Non-Dunya -lo channels are runOnDemand — mediamtx
                # spawns ffmpeg on first read. Even with the new
                # ultrafast/zerolatency preset first-frame lands in
                # ~2-3 s, but real Tailscale RTT + IGMP join can push
                # this to 10 s on a bad day. 30 s cache = enough
                # headroom for every observed cold-start.
                "--network-caching=30000",
                "--rtsp-caching=30000",
                "--live-caching=3000",
                "--file-caching=3000",
                "--udp-caching=2000",
                "--sout-mux-caching=5000",
                "--clock-jitter=500",
                "--clock-synchro=0",
                "--drop-late-frames",
                "--skip-frames",
                "--avcodec-fast",
                "--avcodec-skip-frame=nonref",
                "--avcodec-skip-idct=nonref",
                "--avcodec-threads=1",
                "--no-video-title-show",
                "--no-osd",
                "--no-stats",
                "--quiet",
                # --no-xlib is safe on BOTH platforms IF the process has
                # already called XInitThreads() itself (which we do in
                # demp_viewer.py before Tk imports). Without that init
                # step, --no-xlib strands VLC's video output; with it,
                # libvlc uses xcb cleanly and we save a duplicate
                # xlib-init inside libvlc.
                "--no-xlib",
                "--rtsp-tcp",
            ]
            _VLC_INSTANCE = vlc.Instance(args)
    return _VLC_INSTANCE


class ChannelTile(tk.Frame):
    """Video surface + right-click menu."""

    LOWRES_THRESHOLD_TILES = 999

    def __init__(self, parent: tk.Widget, on_change_channel, prefer_lo: bool = False):
        super().__init__(parent, bg="black", highlightthickness=0, bd=0)
        self.on_change_channel = on_change_channel
        self.channel: Optional[Channel] = None
        self.prefer_lo = prefer_lo
        self._player = None
        self._media = None

        # VLC renders into `self.video`; `self` catches mouse events
        # that VLC's HWND doesn't. We also disable VLC's own mouse
        # capture below so right-click always lands on our menu.
        self.video = tk.Frame(self, bg="black", highlightthickness=0, bd=0)
        self.video.pack(fill="both", expand=True)

        for w in (self, self.video):
            w.bind("<Button-3>", self._show_menu)
            w.bind("<Double-Button-1>", self._toggle_full)

    def show_placeholder(self, text: str) -> None:
        for c in self.video.winfo_children():
            c.destroy()
        lbl = tk.Label(self.video, text=text, bg="black", fg="#334155",
                       font=("Segoe UI", 10), justify="center")
        lbl.place(relx=0.5, rely=0.5, anchor="center")
        for w in (lbl,):
            w.bind("<Button-3>", self._show_menu)
            w.bind("<Double-Button-1>", self._toggle_full)

    def play(self, channel: Channel) -> None:
        self.channel = channel

        if vlc is None:
            self._show_error(f"python-vlc missing:\n{_VLC_ERR}")
            return

        url = channel.primary_url(prefer_lo=self.prefer_lo)
        if not url:
            self._show_error(f"{channel.name}\n(no source URL)")
            return

        # Kick mediamtx's runOnDemand ahead of VLC's DESCRIBE. By the
        # time VLC has done DNS + TCP + RTSP handshake, ffmpeg is
        # already spawning — first frame arrives sooner. No-op for
        # already-warm paths (Dunya).
        if url.endswith("-lo"):
            threading.Thread(target=_prewarm_rtsp, args=(url,), daemon=True,
                             name=f"prewarm-{channel.slug}").start()

        # DESTROY any placeholder BEFORE embedding VLC. On Linux the
        # Tk Label sits on top of the X window VLC draws into, so if
        # we leave it in place, VLC produces frames but they're hidden
        # behind the Label — again the "channel name only" symptom.
        for c in self.video.winfo_children():
            c.destroy()
        # update() forces both realization AND child destruction; without
        # it winfo_id() can still return 0 on the first play.
        self.video.update()
        try:
            hwnd = int(self.video.winfo_id())
        except Exception:
            hwnd = 0

        self.stop()
        inst = _get_vlc_instance()
        if inst is None:
            return
        self._player = inst.media_player_new()
        self._media = inst.media_new(url)
        if url.startswith(("udp://", "rtp://")):
            self._media.add_option(":demux=ts")
        self._player.set_media(self._media)

        if sys.platform == "win32":
            self._player.set_hwnd(hwnd)
        elif sys.platform == "darwin":
            self._player.set_nsobject(hwnd)
        else:
            self._player.set_xwindow(hwnd)

        try:
            self._player.video_set_mouse_input(False)
            self._player.video_set_key_input(False)
        except Exception:
            pass

        # libvlc's play() spawns its own decoder + vout threads and
        # returns immediately — no need for Python threading, and doing
        # so was interleaving with Tk's own X calls, adding races that
        # made the first frame vanish on Linux.
        try:
            em = self._player.event_manager()
            em.event_attach(vlc.EventType.MediaPlayerEncounteredError,
                            lambda _e, ch=channel: self.after(
                                0, lambda: self._show_error(f"{ch.name}\nplayback error")))
        except Exception:
            pass

        rc = self._player.play()
        if rc == -1:
            self._show_error(f"{channel.name}\nvlc could not open stream")

    def stop(self) -> None:
        try:
            if self._player is not None:
                self._player.stop()
        except Exception:  # noqa: BLE001
            pass
        self._player = None
        self._media = None

    def _show_error(self, msg: str) -> None:
        for c in self.video.winfo_children():
            c.destroy()
        lbl = tk.Label(self.video, text=msg, bg="black", fg="#F87171",
                       font=("Segoe UI", 9), justify="center", wraplength=280)
        lbl.place(relx=0.5, rely=0.5, anchor="center")

    def _show_menu(self, event) -> None:
        m = tk.Menu(self, tearoff=0)
        m.add_command(label="Change channel…", command=lambda: self.on_change_channel(self))
        m.add_command(label="Restart tile", command=lambda: self.channel and self.play(self.channel))
        m.add_separator()
        m.add_command(label="Fullscreen this tile (double-click)", command=self._toggle_full)
        m.add_command(label="Clear tile", command=self._clear)
        try:
            m.tk_popup(event.x_root, event.y_root)
        finally:
            m.grab_release()

    def _clear(self):
        self.stop()
        self.channel = None
        self.show_placeholder("(empty)")
        w = self.master
        while w is not None and not hasattr(w, "_save_layout"):
            w = getattr(w, "master", None)
        if w is not None:
            w._save_layout()

    def _toggle_full(self, _event=None):
        w = self.master
        while w is not None and not hasattr(w, "solo_tile"):
            w = getattr(w, "master", None)
        if w is not None:
            w.solo_tile(self)
