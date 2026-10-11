#!/bin/sh
# Builds the extension package and installs it into your VS Code, replacing the installed version.
#   npm run install-local                   from the repository root or apps/vscode
#   CODE=cursor npm run install-local       another VS Code build's CLI (code-insiders, cursor, ...)
# Reload the VS Code window afterwards (Developer: Reload Window) to run the new version.
set -eu
cd "$(dirname "$0")/.."

code_cli="${CODE:-}"
if [ -z "$code_cli" ]; then
  if command -v code >/dev/null 2>&1; then
    code_cli=code
  elif [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
    code_cli="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  else
    echo "Can't find VS Code's 'code' command. Install it (Command Palette: Shell Command: Install 'code' command in PATH) or set CODE." >&2
    exit 1
  fi
fi

version=$(node -p "require('./package.json').version")
vsix="diffline-$version.vsix"
npm run package
"$code_cli" --install-extension "$vsix" --force
echo "Installed $vsix. Reload the VS Code window (Developer: Reload Window) to use it."
