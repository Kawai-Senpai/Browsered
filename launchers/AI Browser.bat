@echo off
REM ============================================================
REM  AI Browser - menu launcher
REM
REM  Double-click this file. Nothing to memorise, no flags.
REM ============================================================
setlocal EnableDelayedExpansion
title AI Browser

set "ROOT=%~dp0.."
set "CLI=%ROOT%\dist\cli.js"

REM ---- Node present? -----------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  cls
  echo.
  echo   Node.js is not installed, or not on your PATH.
  echo.
  echo   Install Node 20 or newer from https://nodejs.org
  echo   then run this file again.
  echo.
  pause
  exit /b 1
)

REM ---- Built? Offer to build rather than just failing. --------
if not exist "%CLI%" (
  cls
  echo.
  echo   AI Browser has not been built yet.
  echo.
  set /p BUILD="   Build it now? This takes a minute. [Y/n] "
  if /i "!BUILD!"=="n" exit /b 0
  echo.
  pushd "%ROOT%"
  call npm install
  call npm run build
  popd
  if not exist "%CLI%" (
    echo.
    echo   Build failed. Scroll up for the error.
    pause
    exit /b 1
  )
)

:MENU
cls
echo.
echo   ================================================
echo      AI BROWSER
echo      record first - query later
echo   ================================================
echo.

REM Show what is already running, so the menu reflects reality.
REM stdin is redirected from NUL: without it this child process inherits the
REM console and can swallow the keystrokes meant for the prompt below.
node "%CLI%" list 2>nul <nul

echo.
echo   ------------------------------------------------
echo     1.  Open a browser              (default profile)
echo     2.  Open a browser at a URL
echo     3.  Open with a named profile   (work, testing, ...)
echo.
echo     4.  Capture a bug            (bundle the last few minutes)
echo.
echo     5.  Show running browsers
echo     6.  Stop a browser            (ends its recording)
echo.
echo     7.  Show recorded data usage
echo     8.  Clean up recorded data
echo.
echo     9.  Register with Claude / Cursor / VS Code
echo    10.  Check the MCP setup is working
echo.
echo     0.  Exit
echo   ------------------------------------------------
echo.

set "CHOICE="
set /p CHOICE="   Choose: "

REM An empty answer (or exhausted stdin) must not fall through into the
REM comparisons below - redraw the menu instead.
if "x%CHOICE%"=="x" goto MENU

if "%CHOICE%"=="1" goto OPEN_DEFAULT
if "%CHOICE%"=="2" goto OPEN_URL
if "%CHOICE%"=="3" goto OPEN_PROFILE
if "%CHOICE%"=="4" goto CAPTURE
if "%CHOICE%"=="5" goto LIST
if "%CHOICE%"=="6" goto STOP
if "%CHOICE%"=="7" goto DATA
if "%CHOICE%"=="8" goto CLEAN
if "%CHOICE%"=="9" goto INSTALL
if "%CHOICE%"=="10" goto VERIFY
if "%CHOICE%"=="0" exit /b 0
goto MENU

:OPEN_DEFAULT
cls
echo.
echo   Opening in the background. This menu stays available.
echo.
node "%CLI%" open --detach --profile default
echo.
pause
goto MENU

:OPEN_URL
cls
echo.
set "URL="
set /p URL="   URL (e.g. localhost:3000): "
if "x%URL%"=="x" goto MENU
REM Accept "localhost:3000" as well as a full URL.
echo %URL% | findstr /i "://" >nul || set "URL=http://%URL%"
echo.
echo   Opening %URL%
echo.
node "%CLI%" open --detach --profile default --url "%URL%"
echo.
pause
goto MENU

:OPEN_PROFILE
cls
echo.
echo   A profile keeps its own cookies, logins and history.
echo   Use different profiles to stay logged into different accounts.
echo.
set "PROF="
set /p PROF="   Profile name: "
if "x%PROF%"=="x" goto MENU
echo.
node "%CLI%" open --detach --profile "%PROF%"
echo.
pause
goto MENU

:CAPTURE
cls
echo.
echo   Bundle what just happened into a zip you can attach to a bug.
echo   The browser has been recording all along, so pick the window
echo   AFTER the bug rather than before it.
echo.
echo     1.  Last 3 minutes
echo     2.  Last 5 minutes
echo     3.  Last 10 minutes
echo     4.  Last hour
echo.
set "WHEN="
set "WINDOW="
set /p WHEN="   Choose (default 3): "
if "x%WHEN%"=="x" set "WHEN=3"
if "%WHEN%"=="1" set "WINDOW=3m"
if "%WHEN%"=="2" set "WINDOW=5m"
if "%WHEN%"=="3" set "WINDOW=10m"
if "%WHEN%"=="4" set "WINDOW=1h"
if "x%WINDOW%"=="x" goto MENU
echo.
set "NOTE="
set /p NOTE="   What did you see? (one line, optional): "
echo.
node "%CLI%" capture --last %WINDOW% --note "%NOTE%"
set "WINDOW="
echo.
pause
goto MENU

:LIST
cls
echo.
node "%CLI%" list
echo.
pause
goto MENU

:STOP
cls
echo.
node "%CLI%" list
echo.
set "BID="
set /p BID="   Browser id to stop (blank = the only one): "
echo.
REM Plain gotos rather than a parenthesised if/else: inside a block the whole
REM construct is parsed before it runs, which is how %BID% ends up empty.
if "x%BID%"=="x" goto STOP_ONLY
node "%CLI%" stop --browser "%BID%"
goto STOP_DONE

:STOP_ONLY
node "%CLI%" stop

:STOP_DONE
echo.
pause
goto MENU

:DATA
cls
echo.
node "%ROOT%\scripts\clean-data.mjs"
echo.
pause
goto MENU

:CLEAN
cls
echo.
echo   1.  Recordings only   (keeps your logins)
echo   2.  Everything        (also signs you out everywhere)
echo   0.  Back
echo.
set "C="
set /p C="   Choose: "
if "x%C%"=="x" goto MENU
if "%C%"=="1" node "%ROOT%\scripts\clean-data.mjs" --recordings --vacuum
if "%C%"=="2" node "%ROOT%\scripts\clean-data.mjs" --all
echo.
pause
goto MENU

:INSTALL
cls
echo.
node "%ROOT%\scripts\install-mcp.mjs"
echo.
echo   Restart your AI client so it picks this up.
echo.
pause
goto MENU

:VERIFY
cls
echo.
node "%ROOT%\scripts\verify-mcp.mjs"
echo.
pause
goto MENU
