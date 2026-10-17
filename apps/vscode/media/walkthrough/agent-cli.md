# Install an agent CLI

Diffline's review agents run on an agent CLI on your computer, with your own account. Install one or more of these, then run it once in a terminal to sign in.

## Claude Code

macOS and Linux:

```
curl -fsSL https://claude.ai/install.sh | bash
```

Windows, in PowerShell:

```
irm https://claude.ai/install.ps1 | iex
```

Or `brew install --cask claude-code` with Homebrew, or `winget install Anthropic.ClaudeCode` on Windows. To sign in, run `claude` and follow the browser prompts. [Claude Code setup](https://code.claude.com/docs/en/setup)

## Codex

macOS and Linux:

```
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

Windows, in PowerShell:

```
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

Or `npm install -g @openai/codex`, or `brew install --cask codex` with Homebrew. To sign in, run `codex` and choose **Sign in with ChatGPT**. [Codex CLI](https://github.com/openai/codex)

## Pi

macOS and Linux:

```
curl -fsSL https://pi.dev/install.sh | sh
```

Windows, in PowerShell:

```
powershell -c "irm https://pi.dev/install.ps1 | iex"
```

Or `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`. Pi works with many model providers: run `pi`, then type `/login` and pick yours, or set your provider's API key. [pi.dev](https://pi.dev)

Then press **Check again**. If the CLI still isn't found, restart the editor so it sees the new program, or set `diffline.claude.path`, `diffline.codex.path` or `diffline.pi.path` to where it is.
