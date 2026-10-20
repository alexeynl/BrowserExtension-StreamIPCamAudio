@echo off
rem Usage: install-windows.bat <extension-id>
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" %*
pause
