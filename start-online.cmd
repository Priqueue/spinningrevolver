@echo off
rem Launcher: delegates to the PowerShell script (ASCII-only, no codepage issues).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-online.ps1"
