@echo off
REM Portable-folder launcher. Flat layout — all DLLs sit next to
REM CMC-VideoWall.exe so Windows loads them from the app directory
REM (required for opengl32 override). Only GStreamer plugins live
REM in a subfolder, pointed at via GST_PLUGIN_PATH.
setlocal
cd /d "%~dp0" 2>nul
if errorlevel 1 (
    echo Cannot cd to launcher directory. Extract the ZIP to a
    echo regular local drive ^(C:, D:, ...^) and try again.
    pause
    exit /b 1
)

set "GST_PLUGIN_PATH=%~dp0gst-plugins"
set "GST_PLUGIN_SCANNER=%~dp0gst-plugin-scanner.exe"
set "GST_PLUGIN_SYSTEM_PATH="
set "GST_REGISTRY=%~dp0registry.cache"

REM Nuke any stale plugin registry from a previous extraction. If the
REM cache says "d3d11videosink not available" (because a prior scan
REM happened on a host without the plugin loaded, or with a different
REM plugin set) GStreamer never re-scans — element lookups just fail
REM with "no element ...". Deleting the cache forces a fresh scan
REM (~1 s on first launch, then cached again). Safe: only affects
REM the app-local cache we set above.
if exist "%GST_REGISTRY%" del /q "%GST_REGISTRY%" 2>nul

REM Mesa's Gallium loader picks ZINK (Vulkan-backed driver) by default
REM if any indication of Vulkan is present, then fails with
REM "ZINK: failed to load vulkan-1.dll" on hosts that don't ship the
REM Vulkan runtime (which is nearly every headless / no-GPU server).
REM llvmpipe is Mesa's pure-CPU software rasteriser — always available
REM because we bundle it, no external runtime needed.
set "GALLIUM_DRIVER=llvmpipe"
set "LIBGL_ALWAYS_SOFTWARE=1"

if "%GST_DEBUG%"=="" set "GST_DEBUG=*:1,libav:0"
if "%RUST_LOG%"=="" set "RUST_LOG=info"

"%~dp0CMC-VideoWall.exe" %*
