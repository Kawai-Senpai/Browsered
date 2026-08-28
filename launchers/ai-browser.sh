#!/usr/bin/env bash
# ============================================================
#  AI Browser - menu launcher (macOS / Linux)
#
#  Run this. Nothing to memorise, no flags.
#    chmod +x ai-browser.sh && ./ai-browser.sh
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/dist/cli.js"

if ! command -v node >/dev/null 2>&1; then
  printf '\n  Node.js is not installed, or not on your PATH.\n'
  printf '  Install Node 20 or newer from https://nodejs.org, then run this again.\n\n'
  exit 1
fi

# Offer to build rather than just failing with a path error.
if [ ! -f "$CLI" ]; then
  printf '\n  AI Browser has not been built yet.\n\n'
  read -r -p "  Build it now? This takes a minute. [Y/n] " reply
  case "$reply" in
    [nN]*) exit 0 ;;
  esac
  ( cd "$ROOT" && npm install && npm run build )
  [ -f "$CLI" ] || { printf '\n  Build failed. Scroll up for the error.\n\n'; exit 1; }
fi

pause() { printf '\n'; read -r -p "  Press Enter to continue..." _; }

while true; do
  clear
  cat <<'BANNER'

  ================================================
     AI BROWSER
     record first - query later
  ================================================
BANNER

  # Show what is already running, so the menu reflects reality.
  node "$CLI" list 2>/dev/null

  cat <<'MENU'
  ------------------------------------------------
    1.  Open a browser              (default profile)
    2.  Open a browser at a URL
    3.  Open with a named profile   (work, testing, ...)

    4.  Capture a bug            (bundle the last few minutes)

    5.  Show running browsers
    6.  Stop a browser            (ends its recording)

    7.  Show recorded data usage
    8.  Clean up recorded data

    9.  Register with Claude / Cursor / VS Code
   10.  Check the MCP setup is working

    0.  Exit
  ------------------------------------------------

MENU

  read -r -p "  Choose: " choice
  case "$choice" in
    1)
      clear
      printf '\n  Opening in the background. This menu stays available.\n\n'
      node "$CLI" open --detach --profile default
      pause
      ;;
    2)
      clear
      printf '\n'
      read -r -p "  URL (e.g. localhost:3000): " url
      [ -z "$url" ] && continue
      # Accept "localhost:3000" as well as a full URL.
      case "$url" in
        *://*) ;;
        *) url="http://$url" ;;
      esac
      printf '\n  Opening %s\n\n' "$url"
      node "$CLI" open --detach --profile default --url "$url"
      pause
      ;;
    3)
      clear
      printf '\n  A profile keeps its own cookies, logins and history.\n'
      printf '  Use different profiles to stay logged into different accounts.\n\n'
      read -r -p "  Profile name: " prof
      [ -z "$prof" ] && continue
      printf '\n'
      node "$CLI" open --detach --profile "$prof"
      pause
      ;;
    4)
      clear
      printf '\n  Bundle what just happened into a zip you can attach to a bug.\n'
      printf '  The browser has been recording all along, so pick the window\n'
      printf '  AFTER the bug rather than before it.\n\n'
      printf '    1.  Last 3 minutes\n    2.  Last 5 minutes\n    3.  Last 10 minutes\n    4.  Last hour\n\n'
      read -r -p "  Choose (default 3): " when
      case "${when:-3}" in
        1) win=3m ;;
        2) win=5m ;;
        3) win=10m ;;
        4) win=1h ;;
        *) continue ;;
      esac
      printf '\n'
      read -r -p "  What did you see? (one line, optional): " note
      printf '\n'
      node "$CLI" capture --last "$win" --note "$note"
      pause
      ;;
    5) clear; printf '\n'; node "$CLI" list; pause ;;
    6)
      clear
      printf '\n'
      node "$CLI" list
      printf '\n'
      read -r -p "  Browser id to stop (blank = the only one): " bid
      printf '\n'
      if [ -z "$bid" ]; then node "$CLI" stop; else node "$CLI" stop --browser "$bid"; fi
      pause
      ;;
    7) clear; printf '\n'; node "$ROOT/scripts/clean-data.mjs"; pause ;;
    8)
      clear
      printf '\n  1.  Recordings only   (keeps your logins)\n'
      printf '  2.  Everything        (also signs you out everywhere)\n'
      printf '  0.  Back\n\n'
      read -r -p "  Choose: " c
      [ "$c" = "1" ] && node "$ROOT/scripts/clean-data.mjs" --recordings --vacuum
      [ "$c" = "2" ] && node "$ROOT/scripts/clean-data.mjs" --all
      pause
      ;;
    9)
      clear; printf '\n'
      node "$ROOT/scripts/install-mcp.mjs"
      printf '\n  Restart your AI client so it picks this up.\n'
      pause
      ;;
    10) clear; printf '\n'; node "$ROOT/scripts/verify-mcp.mjs"; pause ;;
    0) exit 0 ;;
  esac
done
