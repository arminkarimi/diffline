#!/bin/sh
# Times opening a pull request by link in an isolated VS Code (throwaway profile, so the first open is cold), then
# again with the diff cached and with everything cached. Prints the extension's "Opened … in N ms (…)" timings.
#   DIFFLINE_SMOKE_PR=owner/name#123 [DIFFLINE_TIMING_SEED=/path/to/clone.git] [DIFFLINE_TIMING_RUNS=2] \
#   [DIFFLINE_TIMING_LABEL=small] ./scripts/open-timing.sh
# DIFFLINE_TIMING_SEED is a bare clone of the repository (Diffline's own, from its storage's clones folder) that is
# copied into the throwaway profile as Diffline's clone, so the first open doesn't clone. Build first (npm run build).
set -e
: "${DIFFLINE_SMOKE_PR:?Set DIFFLINE_SMOKE_PR to a pull request to open, as owner/name#number}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
mkdir -p "$TMP/user/User"
if [ -n "$DIFFLINE_TIMING_SEED" ]; then
  REPO=$(echo "${DIFFLINE_SMOKE_PR%%#*}" | tr '/' '_' | sed 's/_/__/' | tr 'A-Z' 'a-z')
  mkdir -p "$TMP/user/User/globalStorage/arminkarimi.diffline/clones"
  cp -c -R "$DIFFLINE_TIMING_SEED" "$TMP/user/User/globalStorage/arminkarimi.diffline/clones/$REPO" 2>/dev/null ||
    cp -R "$DIFFLINE_TIMING_SEED" "$TMP/user/User/globalStorage/arminkarimi.diffline/clones/$REPO"
fi
# Only this pull request is listed (pinned when it opens), so the sidebar's searches and the diffs it prepares for
# other pull requests don't run alongside the opens being timed, and few GitHub requests are made.
cat > "$TMP/user/User/settings.json" <<JSON
{ "diffline.agents.autoRun": false, "workbench.startupEditor": "none", "security.workspace.trust.enabled": false,
  "diffline.watch.reviewRequested": false, "diffline.watch.teamRequests": false, "diffline.watch.assigned": false,
  "diffline.watch.reviewed": false, "diffline.watch.authored": false, "diffline.watch.codeOwners": false,
  "diffline.watch.othersToReview": false, "diffline.watch.recentlyClosedDays": 0 }
JSON
export DIFFLINE_HOME="$TMP/home" DIFFLINE_SMOKE_OUT="$TMP/result.txt" DIFFLINE_SMOKE_PR DIFFLINE_TIMING_RUNS DIFFLINE_TIMING_LABEL
"/Applications/Visual Studio Code.app/Contents/MacOS/Code" --user-data-dir "$TMP/user" --extensions-dir "$TMP/ext" --disable-extensions --new-window \
  --extensionDevelopmentPath="$ROOT" --extensionTestsPath="$ROOT/test-vscode/open-timing.cjs" > "$TMP/code.log" 2>&1 || true
# VS Code's crash reporter can outlive it holding the output open, so the log is read from a file, and it's stopped.
pkill -f "$TMP" 2>/dev/null || true
grep -E "Error|error" "$TMP/code.log" | grep -v -E "GPU|gpu|Electron|DevTools|DEP0" || true
# The extension's log, with the pull request's name left out: what was fetched and built, and each open's line.
if [ -n "$DIFFLINE_TIMING_LOG" ]; then
  PRNAME="${DIFFLINE_SMOKE_PR%%#*}"
  CLONENAME=$(echo "$PRNAME" | tr '/' '_' | sed 's/_/__/' | tr 'A-Z' 'a-z')
  find "$TMP/user/logs" -name "*Diffline*.log" -exec cat {} + | grep -F -e "$PRNAME" -e "$CLONENAME" | grep -E "Opened|Fetching|Built|error|Couldn't|Updated" |
    sed -e "s#$PRNAME#<repo>#g" -e "s#$CLONENAME#<repo>#g" -e "s#$TMP#<tmp>#g"
fi
cat "$TMP/result.txt" 2>/dev/null || { echo "No result: the timing run failed"; rm -rf "$TMP"; exit 1; }
rm -rf "$TMP"
