@echo off
cd /d "%~dp0"

REM Try vcvars64.bat first — cleanest path. If missing or broken, we
REM fall back to setting INCLUDE/LIB/PATH explicitly below.
if exist "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" (
  call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
)

REM Belt-and-braces: even if vcvars ran, prepend MSVC bin explicitly
REM so Git Bash's `link.exe` never wins on PATH.
set "MSVC_ROOT=C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\14.50.35717"
set "SDK_ROOT=C:\Program Files (x86)\Windows Kits\10"
set "SDK_VER=10.0.26100.0"

if not defined INCLUDE (
  set "INCLUDE=%MSVC_ROOT%\include;%SDK_ROOT%\Include\%SDK_VER%\ucrt;%SDK_ROOT%\Include\%SDK_VER%\shared;%SDK_ROOT%\Include\%SDK_VER%\um;%SDK_ROOT%\Include\%SDK_VER%\winrt"
)
if not defined LIB (
  set "LIB=%MSVC_ROOT%\lib\x64;%SDK_ROOT%\Lib\%SDK_VER%\ucrt\x64;%SDK_ROOT%\Lib\%SDK_VER%\um\x64"
)

set "PATH=%MSVC_ROOT%\bin\Hostx64\x64;%SDK_ROOT%\bin\%SDK_VER%\x64;C:\Program Files\gstreamer\1.0\msvc_x86_64\bin;%PATH%"
set "PKG_CONFIG_PATH=C:\Program Files\gstreamer\1.0\msvc_x86_64\lib\pkgconfig"
set "GSTREAMER_1_0_ROOT_MSVC_X86_64=C:\Program Files\gstreamer\1.0\msvc_x86_64\"

"C:\Users\ibrahim laptops\.cargo\bin\cargo.exe" build --release %*
