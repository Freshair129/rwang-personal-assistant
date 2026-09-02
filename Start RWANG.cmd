@echo off
title RWANG Local Assistant
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start RWANG.ps1"
if errorlevel 1 pause
