@echo off
setlocal
if not defined GDECK_CURSOR_COMPAT set GDECK_CURSOR_COMPAT=1
if not defined GODOT_BIN set GODOT_BIN=D:\03_Godot\01_Engine\Godot_v4.7.1-stable_win64.exe
node "%~dp0..\cli\gdeck.mjs" %*
exit /b %ERRORLEVEL%
