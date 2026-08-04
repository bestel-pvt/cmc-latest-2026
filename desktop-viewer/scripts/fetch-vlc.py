"""Fetch VLC 3.x 64-bit portable and drop libvlc.dll + libvlccore.dll +
plugins/ into desktop-viewer/vendor/vlc/ so PyInstaller can bundle them.

Idempotent — skips if the target already contains libvlc.dll.
Run before `pyinstaller build.spec`.
"""
from __future__ import annotations

import io
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

VLC_ZIP = "https://download.videolan.org/pub/videolan/vlc/3.0.20/win64/vlc-3.0.20-win64.zip"

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "vendor" / "vlc"


def main() -> int:
    if (DEST / "libvlc.dll").exists():
        print(f"[fetch-vlc] already present at {DEST} — skip")
        return 0

    print(f"[fetch-vlc] downloading VLC portable from {VLC_ZIP}")
    with urllib.request.urlopen(VLC_ZIP, timeout=300) as r:
        buf = r.read()
    print(f"[fetch-vlc] got {len(buf) / 1024 / 1024:.1f} MB, extracting…")

    DEST.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(buf)) as zf:
        # inside the zip everything sits under vlc-3.0.20/
        prefix = zf.namelist()[0].split("/", 1)[0] + "/"
        wanted = ("libvlc.dll", "libvlccore.dll", "plugins/")
        for member in zf.namelist():
            rel = member[len(prefix):] if member.startswith(prefix) else member
            if not rel or rel.endswith("/"):
                continue
            if not (rel == "libvlc.dll" or rel == "libvlccore.dll" or rel.startswith("plugins/")):
                continue
            out = DEST / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(member) as src, open(out, "wb") as dst:
                shutil.copyfileobj(src, dst)
    print(f"[fetch-vlc] done → {DEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
