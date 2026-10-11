#!/bin/sh
# Launches an isolated VS Code (throwaway profile and extensions folder) with Diffline and runs test-vscode/smoke.cjs.
#   DIFFLINE_SMOKE_PR=owner/name#123 [DIFFLINE_SMOKE_CLONE=/path/to/clone] ./scripts/vscode-smoke.sh
# The pull request is one your gh account can read; it's only read. A local clone of its repository makes it faster.
set -e
: "${DIFFLINE_SMOKE_PR:?Set DIFFLINE_SMOKE_PR to a pull request to open, as owner/name#number}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
mkdir -p "$TMP/user/User"
CLONES="{}"
if [ -n "$DIFFLINE_SMOKE_CLONE" ]; then CLONES="{ \"${DIFFLINE_SMOKE_PR%%#*}\": \"$DIFFLINE_SMOKE_CLONE\" }"; fi
cat > "$TMP/user/User/settings.json" <<JSON
{ "diffline.agents.autoRun": false, "diffline.clones": $CLONES, "workbench.startupEditor": "none", "security.workspace.trust.enabled": false }
JSON
export DIFFLINE_HOME="$TMP/home" DIFFLINE_SMOKE_OUT="$TMP/result.txt" DIFFLINE_SMOKE_PR
"/Applications/Visual Studio Code.app/Contents/MacOS/Code" --user-data-dir "$TMP/user" --extensions-dir "$TMP/ext" --disable-extensions --new-window \
  --extensionDevelopmentPath="$ROOT" --extensionTestsPath="$ROOT/test-vscode/smoke.cjs" 2>&1 | grep -E "\[smoke\]|Error|error" | grep -v -E "GPU|gpu|Electron|DevTools" || true
cat "$TMP/result.txt" 2>/dev/null || { echo "No result: the smoke test failed"; exit 1; }
