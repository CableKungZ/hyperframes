@echo off
rem Put a "HyperFrames Studio" shortcut on the Desktop.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\launch-studio.ps1" -InstallShortcut
