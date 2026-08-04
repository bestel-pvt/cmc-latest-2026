# DEMP Video Wall — Desktop Viewer

Native Tk + VLC video-wall for DEMP. Plays satellite UDP multicasts (or any
DEMP channel source) **directly** — no HLS, no transcoding, full quality.
Auto-imports the channel list from the DEMP API.

## Requirements

- Python 3.10+
- **VLC 3.x installed on the machine** (`https://www.videolan.org/vlc/`) — the
  library is the actual media engine. On Windows install the 64-bit build.
- `pip install -r requirements.txt`

## Run

```
python demp_viewer.py
```

First launch asks for the DEMP admin email/password; the token is cached
under `%APPDATA%/DEMP-Viewer/config.json`.

## Keyboard

- `F11` — toggle fullscreen for the whole wall
- `Esc` — exit fullscreen / exit a solo tile
- Double-click a tile — solo that tile (fills the grid); Esc restores
- Right-click a tile — Change channel · Restart tile · Fullscreen

## Configuration

`config.json` stores:
- `api_base` — DEMP API URL (default `http://100.105.45.112:4001`)
- `email`, `access_token` — sign-in state
- `grid_cols`, `grid_rows` — last chosen grid size
- `wall_channel_ids` — remembered channel-per-tile layout

## Packaging as a Windows .exe

```
pip install pyinstaller
pyinstaller --noconfirm --windowed --onefile --name "DEMP-Viewer" ^
  --icon demp_viewer/assets/demp.ico ^
  --add-data "demp_viewer/assets;demp_viewer/assets" ^
  demp_viewer.py
```

The resulting `dist/DEMP-Viewer.exe` bundles Python + all deps EXCEPT
the VLC engine — VLC must be installed on the target machine.
