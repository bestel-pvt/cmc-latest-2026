# CMC Video Wall — Rust + GStreamer

Native GStreamer pipeline + hardware d3d11 decode on Windows. Targets
≤200 ms latency at 32 concurrent HD tiles on the wall PC.

Consumes UDP multicast DIRECTLY from the satellite feeds — there is no
MediaMTX rebroadcast tier in the loop.

Ships as `CMC-VideoWall.exe`.

## Build (Windows)

```powershell
# 1. GStreamer 1.28+ MSVC devel bundle installed to C:\gstreamer\1.0\msvc_x86_64
$env:PKG_CONFIG_PATH = "C:\gstreamer\1.0\msvc_x86_64\lib\pkgconfig"
$env:PATH = "C:\gstreamer\1.0\msvc_x86_64\bin;$env:PATH"

# 2. Compile
cargo build --release

# 3. Run PoC (single tile, plays one UDP stream)
target\release\CMC-VideoWall.exe "udp://@239.1.1.5:1111"
```

## Phases

| # | Milestone |
|---|-----------|
| 0 | Rust + GStreamer install |
| 1 | Single-tile UDP PoC |
| 2 | N-tile grid layouts (single/dual/mosaic-20/grid-32) |
| 3 | CMC API client + login flow |
| 4 | UI chrome (layout picker, channel list, fullscreen) |
| 5 | Per-channel fill modes + auto-fill |
| 6 | Deinterlace + quality polish |
| 7 | Package + deploy |
