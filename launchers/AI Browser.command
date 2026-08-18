#!/usr/bin/env bash
# ============================================================
#  AI Browser - macOS double-click launcher
#
#  Finder runs a .command file in Terminal but will not run a .sh, so this
#  exists purely to make the launcher clickable. The menu itself lives in
#  ai-browser.sh and is not duplicated here.
#
#  If macOS refuses to open it ("cannot be opened because it is from an
#  unidentified developer"), clear the quarantine flag once:
#    xattr -d com.apple.quarantine "AI Browser.command"
# ============================================================
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
exec ./ai-browser.sh
