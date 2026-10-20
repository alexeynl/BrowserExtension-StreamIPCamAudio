@echo off
rem Windows cannot run .py directly as a native messaging host - use this wrapper.
set "SCRIPT=%~dp0camera_audio_host.py"
where python >nul 2>&1
if not errorlevel 1 (
  python "%SCRIPT%" %*
) else (
  py -3 "%SCRIPT%" %*
)
