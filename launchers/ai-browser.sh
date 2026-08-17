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

    4.  Show running browsers
    5.  Show recorded data usage
    6.  Clean up recorded data

    7.  Register with Claude / Cursor / VS Code
    8.  Check the MCP setup is working

    0.  Exit
  ------------------------------------------------

MENU

  read -r -p "  Choose: " choice
  case "$choice" in
    1)
      clear
      printf '\n  Opening. Close the browser window, or press Ctrl+C here, to stop.\n\n'
      node "$CLI" open --profile default
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
      node "$CLI" open --profile default --url "$url"
      pause
      ;;
    3)
      clear
      printf '\n  A profile keeps its own cookies, logins and history.\n'
      printf '  Use different profiles to stay logged into different accounts.\n\n'
      read -r -p "  Profile name: " prof
      [ -z "$prof" ] && continue
      printf '\n'
      node "$CLI" open --profile "$prof"
      pause
      ;;
    4) clear; printf '\n'; node "$CLI" list; pause ;;
    5) clear; printf '\n'; node "$ROOT/scripts/clean-data.mjs"; pause ;;
    6)
      clear
      printf '\n  1.  Recordings only   (keeps your logins)\n'
      printf '  2.  Everything        (also signs you out everywhere)\n'
      printf '  0.  Back\n\n'
      read -r -p "  Choose: " c
      [ "$c" = "1" ] && node "$ROOT/scripts/clean-data.mjs" --recordings --vacuum
      [ "$c" = "2" ] && node "$ROOT/scripts/clean-data.mjs" --all
      pause
      ;;
    7)
      clear; printf '\n'
      node "$ROOT/scripts/install-mcp.mjs"
      printf '\n  Restart your AI client so it picks this up.\n'
      pause
      ;;
    8) clear; printf '\n'; node "$ROOT/scripts/verify-mcp.mjs"; pause ;;
    0) exit 0 ;;
  esac
done
