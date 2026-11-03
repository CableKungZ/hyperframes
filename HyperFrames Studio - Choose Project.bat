@echo off
rem Pick another project folder, then open HyperFrames Studio.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\launch-studio.ps1" -ChooseProject
