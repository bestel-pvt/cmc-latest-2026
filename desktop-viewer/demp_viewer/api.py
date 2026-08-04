"""DEMP API client — auth + channel listing.

Uses urllib (stdlib only) so no requests dependency for the packaged .exe.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


class AuthError(RuntimeError):
    pass


@dataclass
class Source:
    id: str
    kind: str          # UDP / SRT / RTSP
    url: str           # e.g. udp://224.2.2.2:3108
    is_primary: bool


@dataclass
class Channel:
    id: str
    name: str
    slug: str
    logo_url: str | None
    active: bool
    online: bool
    sources: list[Source]
    demp_rtsp_url: str | None = None       # raw HD DEMP re-broadcast
    demp_rtsp_lo_url: str | None = None    # 480p on-demand transcode
    demp_udp_url: str | None = None        # multicast (same-LAN only)

    def primary_url(self, prefer_lo: bool = True) -> str | None:
        # DEFAULT to the 480p -lo transcode. Reasoning:
        #   * 9-tile 3x3 grid of raw HD = 270 Mbps aggregate over
        #     Tailscale, which chokes and stutters — user tested this.
        #   * -lo = 600 kbps × 9 = ~5.4 Mbps, well within Tailscale.
        #   * mediamtx keeps the -lo transcoder alive for 30 s after
        #     the last viewer leaves, so navigating tiles is snappy.
        # Callers can override with prefer_lo=False if they want raw HD.
        if prefer_lo and self.demp_rtsp_lo_url:
            return self.demp_rtsp_lo_url
        if self.demp_rtsp_url:
            return self.demp_rtsp_url
        if self.demp_udp_url:
            return self.demp_udp_url
        for s in self.sources:
            if s.is_primary:
                return _vlc_url(s.url, s.kind)
        if self.sources:
            return _vlc_url(self.sources[0].url, self.sources[0].kind)
        return None


def _vlc_url(url: str, kind: str) -> str:
    """VLC wants a leading @ on multicast UDP/RTP to indicate listening mode."""
    u = url.strip()
    if kind.upper() in ("UDP", "RTP"):
        if "://" in u:
            proto, rest = u.split("://", 1)
            if not rest.startswith("@"):
                u = f"{proto.lower()}://@{rest}"
    return u


class DempClient:
    def __init__(self, base_url: str, timeout: float = 15.0):
        self.base = base_url.rstrip("/")
        self.timeout = timeout
        self.access_token: str | None = None

    def set_token(self, token: str | None) -> None:
        self.access_token = token

    def _req(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        url = f"{self.base}{path}"
        data = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self.access_token:
            headers["Authorization"] = f"Bearer {self.access_token}"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise AuthError("Not authorized (session expired)")
            body_txt = ""
            try:
                body_txt = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            raise RuntimeError(f"HTTP {e.code}: {body_txt or e.reason}") from None
        except urllib.error.URLError as e:
            raise RuntimeError(f"Network error: {e.reason}") from None

    def login(self, email: str, password: str) -> str:
        r = self._req("POST", "/api/auth/login", {"email": email, "password": password})
        token = r.get("accessToken") if isinstance(r, dict) else None
        if not token:
            raise AuthError("Login failed — bad email or password")
        self.access_token = token
        return token

    def list_channels(self) -> list[Channel]:
        r = self._req("GET", "/api/channels")
        out: list[Channel] = []
        for c in r or []:
            srcs = [
                Source(
                    id=s.get("id", ""),
                    kind=s.get("kind", "UDP"),
                    url=s.get("url", ""),
                    is_primary=bool(s.get("isPrimary")),
                )
                for s in c.get("sources") or []
            ]
            out.append(Channel(
                id=c["id"],
                name=c.get("name", c.get("slug", "?")),
                slug=c.get("slug", ""),
                logo_url=c.get("logoUrl"),
                active=bool(c.get("active", True)),
                online=bool(c.get("online", True)),
                sources=srcs,
                demp_rtsp_url=c.get("dempOutputUrlRtsp"),
                demp_rtsp_lo_url=c.get("dempOutputUrlRtspLo"),
                demp_udp_url=c.get("dempOutputUrlUdp"),
            ))
        return out
