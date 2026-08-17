@echo off
REM Show every AI Browser currently running and recording.
setlocal
node "%~dp0..\dist\cli.js" list
echo.
pause
endlocal
