@echo off
REM ============================================================
REM  AI Browser - a normal Chromium that records everything.
REM
REM  Double-click this. Use the browser however you like. Any MCP
REM  client can discover it and inspect what happened, including
REM  traffic from before the agent ever connected.
REM
REM  Closing this window stops the browser.
REM ============================================================

setlocal
set "ROOT=%~dp0.."

if not exist "%ROOT%\dist\cli.js" (
  echo browserd is not built yet.
  echo.
  echo   cd /d "%ROOT%"
  echo   npm install ^&^& npm run build
  echo.
  pause
  exit /b 1
)

title AI Browser - recording

REM --profile keeps cookies and logins between runs.
REM Pass a URL as the first argument to start somewhere specific.
if "%~1"=="" (
  node "%ROOT%\dist\cli.js" open --profile default
) else (
  node "%ROOT%\dist\cli.js" open --profile default --url "%~1"
)

endlocal
