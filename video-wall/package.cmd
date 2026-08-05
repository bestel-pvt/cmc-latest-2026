@echo off
REM ─────────────────────────────────────────────────────────────────
REM  Package CMC-VideoWall into a portable folder for wall-PC drop-in.
REM  Output: dist\CMC-VideoWall\  and  dist\CMC-VideoWall.zip
REM
REM  The folder contains:
REM    * CMC-VideoWall.exe                — main program
REM    * CMC-VideoWall.cmd                — launcher (sets PATH)
REM    * bin\*.dll                        — GStreamer runtime DLLs
REM    * lib\gstreamer-1.0\*.dll          — GStreamer plugins
REM    * bin\opengl32.dll + libgallium…   — Mesa OpenGL fallback
REM  User just extracts the zip and double-clicks the .cmd — no
REM  install, no admin, no dependencies.
REM ─────────────────────────────────────────────────────────────────
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "STAGE=dist\CMC-VideoWall"
set "GST=C:\Program Files\gstreamer\1.0\msvc_x86_64"
set "MESA=%~dp0..\..\..\..\Users\ibrahim laptops\AppData\Local\Temp\claude\C--BesTel-Projects-DEMP\104d1b6b-fa93-4af9-b8d6-faa351876e46\scratchpad\mesa\x64"

echo === Building release exe ===
call "%~dp0build.cmd" || goto :fail

echo === Cleaning stage ===
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%"
mkdir "%STAGE%\gst-plugins"

echo === Copying exe + launcher ===
copy /y target\release\CMC-VideoWall.exe "%STAGE%\CMC-VideoWall.exe" || goto :fail
copy /y CMC-VideoWall-launcher.cmd "%STAGE%\CMC-VideoWall.cmd"

echo === Copying GStreamer runtime DLLs ===
REM All the core DLLs we actually load. Copying the whole bin/ dir
REM is ~350MB with unused GTK/audio/etc — this list is the minimum
REM to run our specific pipeline (udpsrc, tsdemux, decodebin3,
REM avdec_h264/265, videoconvert, videoscale, glimagesink, d3d11).
for %%D in (
    gstreamer-1.0-0.dll
    gstbase-1.0-0.dll
    gstvideo-1.0-0.dll
    gstaudio-1.0-0.dll
    gstapp-1.0-0.dll
    gstpbutils-1.0-0.dll
    gstriff-1.0-0.dll
    gsttag-1.0-0.dll
    gstnet-1.0-0.dll
    gstcontroller-1.0-0.dll
    gstrtp-1.0-0.dll
    gstrtsp-1.0-0.dll
    gstsdp-1.0-0.dll
    gstcodecparsers-1.0-0.dll
    gstmpegts-1.0-0.dll
    gstgl-1.0-0.dll
    gstglproto-1.0-0.dll
    glib-2.0-0.dll
    gobject-2.0-0.dll
    gio-2.0-0.dll
    gmodule-2.0-0.dll
    gthread-2.0-0.dll
    intl-8.dll
    ffi-7.dll
    ffi-8.dll
    z-1.dll
    orc-0.4-0.dll
    avcodec-61.dll
    avcodec-62.dll
    avformat-61.dll
    avformat-62.dll
    avutil-59.dll
    avutil-60.dll
    avfilter-10.dll
    swresample-5.dll
    swresample-6.dll
    swscale-8.dll
    swscale-9.dll
    graphene-1.0-0.dll
    pcre2-8-0.dll
    bz2.dll
    iconv-2.dll
    libcrypto-3-x64.dll
    libssl-3-x64.dll
) do (
    if exist "%GST%\bin\%%D" (
        copy /y "%GST%\bin\%%D" "%STAGE%\" >nul
    )
)

echo === Copying GStreamer plugins ===
REM Just the plugins our pipeline touches — udpsrc, tsdemux, decodebin,
REM avdec_h264/h265, videoconvert, videoscale, glimagesink, d3d11.
for %%P in (
    gstcoreelements.dll
    gstudp.dll
    gstmpegtsdemux.dll
    gstplayback.dll
    gsttypefindfunctions.dll
    gstlibav.dll
    gstvideoconvertscale.dll
    gstvideorate.dll
    gstvideotestsrc.dll
    gstvideofilter.dll
    gstopengl.dll
    gstd3d11.dll
    gstautodetect.dll
    gstapp.dll
    gstisomp4.dll
    gstvideoparsersbad.dll
    gstcodectimestamper.dll
    gstsubparse.dll
    gsttcp.dll
    gstrtp.dll
    gstrtsp.dll
    gstopus.dll
    gstaudioconvert.dll
    gstaudioresample.dll
    gstaudioparsers.dll
) do (
    if exist "%GST%\lib\gstreamer-1.0\%%P" (
        copy /y "%GST%\lib\gstreamer-1.0\%%P" "%STAGE%\gst-plugins\" >nul
    )
)

echo === Copying gst-plugin-scanner ===
if exist "%GST%\libexec\gstreamer-1.0\gst-plugin-scanner.exe" (
    copy /y "%GST%\libexec\gstreamer-1.0\gst-plugin-scanner.exe" "%STAGE%\" >nul
)

echo === Copying MSVC runtime DLLs ===
REM Both our exe AND every GStreamer DLL link against the MSVC C
REM runtime. Wall PCs without Visual C++ Redistributable installed
REM error with "VCRUNTIME140.dll not found" on launch. Bundling
REM these three (redistributable per Microsoft's licence) makes
REM the folder work on any fresh Windows install.
for %%R in (
    vcruntime140.dll
    vcruntime140_1.dll
    msvcp140.dll
    msvcp140_1.dll
    msvcp140_2.dll
    concrt140.dll
) do (
    if exist "C:\Windows\System32\%%R" (
        copy /y "C:\Windows\System32\%%R" "%STAGE%\" >nul
    )
)

echo === Copying Mesa OpenGL fallback ===
REM opengl32.dll MUST live next to the exe — Windows treats
REM opengl32 as a KnownDLL and would otherwise load the System32
REM copy (which on Basic Display Adapter hosts fails egui_glow's
REM OpenGL 2.0+ check and silently exits the exe). Putting it in
REM a bin/ subdir doesn't work; app-directory is the only override.
if exist "%MESA%\opengl32.dll" (
    copy /y "%MESA%\opengl32.dll" "%STAGE%\opengl32.dll" >nul
    copy /y "%MESA%\libgallium_wgl.dll" "%STAGE%\libgallium_wgl.dll" >nul
)

echo === Writing README ===
> "%STAGE%\README.txt" echo CMC Video Wall - PAK NAVY
>> "%STAGE%\README.txt" echo.
>> "%STAGE%\README.txt" echo To run: double-click CMC-VideoWall.cmd
>> "%STAGE%\README.txt" echo.
>> "%STAGE%\README.txt" echo First launch shows the login screen. Sign in with your
>> "%STAGE%\README.txt" echo CMC account credentials. The tool remembers you on
>> "%STAGE%\README.txt" echo subsequent launches until you use the Logout button.
>> "%STAGE%\README.txt" echo.
>> "%STAGE%\README.txt" echo No install required. Copy this whole folder anywhere.
>> "%STAGE%\README.txt" echo.
>> "%STAGE%\README.txt" echo Powered by Analysys - for PAK NAVY.

echo === Zipping ===
powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%\*' -DestinationPath 'dist\CMC-VideoWall.zip' -Force"

for %%A in ("dist\CMC-VideoWall.zip") do set "ZIPSIZE=%%~zA"
echo.
echo ===============================================================
echo   dist\CMC-VideoWall\        (portable folder)
echo   dist\CMC-VideoWall.zip     (%ZIPSIZE% bytes)
echo ===============================================================
goto :eof

:fail
echo BUILD FAILED
exit /b 1
