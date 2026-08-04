"""Modal channel picker — search + list of channels.

Offline channels (mediamtx path not ready + no failover score) render
dimmed and are not selectable — the operator sees at a glance which
feeds are live and can't accidentally pick a dead one.
"""
from __future__ import annotations

import tkinter as tk
from tkinter import ttk

from demp_viewer.api import Channel


class ChannelPicker:
    def __init__(self, parent: tk.Widget, channels: list[Channel]):
        self.selected: Channel | None = None
        self._all = channels

        top = self.top = tk.Toplevel(parent)
        top.title("Pick a channel")
        top.configure(bg="#0A1124")
        top.geometry("460x560")
        top.transient(parent)
        top.grab_set()

        tk.Label(top, text="Channel", bg="#0A1124", fg="#E2E8F0",
                 font=("Segoe UI", 10, "bold")).pack(anchor="w", padx=14, pady=(12, 4))

        self.filter_var = tk.StringVar()
        entry = ttk.Entry(top, textvariable=self.filter_var)
        entry.pack(fill="x", padx=14)
        entry.focus_set()

        list_frame = tk.Frame(top, bg="#0A1124")
        list_frame.pack(fill="both", expand=True, padx=14, pady=10)
        sb = ttk.Scrollbar(list_frame)
        sb.pack(side="right", fill="y")
        self.listbox = tk.Listbox(
            list_frame,
            bg="#0F1830", fg="#E2E8F0",
            selectbackground="#FF6E1F", selectforeground="white",
            font=("Segoe UI", 10), activestyle="none", yscrollcommand=sb.set,
        )
        self.listbox.pack(side="left", fill="both", expand=True)
        sb.configure(command=self.listbox.yview)

        legend = tk.Frame(top, bg="#0A1124")
        legend.pack(fill="x", padx=14, pady=(0, 4))
        tk.Label(legend, text="●", bg="#0A1124", fg="#22C55E",
                 font=("Segoe UI", 9)).pack(side="left")
        tk.Label(legend, text=" online   ", bg="#0A1124", fg="#94A3B8",
                 font=("Segoe UI", 9)).pack(side="left")
        tk.Label(legend, text="●", bg="#0A1124", fg="#475569",
                 font=("Segoe UI", 9)).pack(side="left")
        tk.Label(legend, text=" offline (dimmed, not selectable)",
                 bg="#0A1124", fg="#94A3B8", font=("Segoe UI", 9)).pack(side="left")

        btns = tk.Frame(top, bg="#0A1124")
        btns.pack(fill="x", padx=14, pady=(4, 12))
        tk.Button(btns, text="Cancel", command=top.destroy,
                  bg="#1F2937", fg="#E2E8F0", relief="flat", padx=14, pady=5).pack(side="right", padx=(6, 0))
        tk.Button(btns, text="Choose", command=self._choose,
                  bg="#FF6E1F", fg="white", relief="flat", padx=14, pady=5,
                  font=("Segoe UI", 9, "bold")).pack(side="right")

        self.filter_var.trace_add("write", lambda *_: self._refill())
        self.listbox.bind("<Double-Button-1>", lambda _e: self._choose())
        self.listbox.bind("<<ListboxSelect>>", self._guard_offline_selection)
        top.bind("<Return>", lambda _e: self._choose())
        top.bind("<Escape>", lambda _e: top.destroy())

        self._filtered: list[Channel] = []
        self._refill()

    def _refill(self) -> None:
        needle = (self.filter_var.get() or "").lower().strip()
        self.listbox.delete(0, "end")
        self._filtered = []
        # Online channels first, then offline dimmed at the bottom.
        online   = [c for c in self._all if c.active and c.online]
        offline  = [c for c in self._all if c.active and not c.online]
        for c in (*online, *offline):
            if needle and needle not in c.name.lower() and needle not in c.slug.lower():
                continue
            dot = "●" if c.online else "○"
            self._filtered.append(c)
            self.listbox.insert("end", f"  {dot}  {c.name}   ({c.slug})")
            if not c.online:
                # tk Listbox itemconfig lets us paint per-row colours —
                # muted grey for offline. Still visible so the operator
                # can scan the full lineup, just clearly unavailable.
                self.listbox.itemconfig("end", foreground="#475569")
        # Auto-select the first online row if any.
        for i, c in enumerate(self._filtered):
            if c.online:
                self.listbox.selection_set(i)
                break

    def _guard_offline_selection(self, _event=None) -> None:
        # Snap the selection back to the nearest online row if the
        # operator clicked an offline entry — Tkinter has no per-item
        # 'disabled' flag on Listbox, so we enforce it in the handler.
        sel = self.listbox.curselection()
        if not sel:
            return
        idx = sel[0]
        if idx >= len(self._filtered):
            return
        if self._filtered[idx].online:
            return
        self.listbox.selection_clear(0, "end")
        # Find nearest online row and select it silently.
        for i, c in enumerate(self._filtered):
            if c.online:
                self.listbox.selection_set(i)
                self.listbox.see(i)
                break

    def _choose(self) -> None:
        sel = self.listbox.curselection()
        if not sel:
            return
        c = self._filtered[sel[0]]
        if not c.online:
            return
        self.selected = c
        self.top.destroy()


def pick_channel(parent: tk.Widget, channels: list[Channel]) -> Channel | None:
    p = ChannelPicker(parent, channels)
    parent.wait_window(p.top)
    return p.selected
