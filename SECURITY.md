# Security

Diffline runs AI agents on pull request content, reads repositories through your local clones and the GitHub CLI, and posts reviews to GitHub. If you find a way to make it run commands, read or leak files or tokens, post without being asked, or anything else that crosses those lines, please report it privately.

## Reporting a vulnerability

Email **armin@diffline.dev** with what you found, how to reproduce it, and the version (shown in the Extensions view). Please don't open a public issue or pull request for it.

You'll get a reply within a few days. Once a fix is released, the changelog credits you, unless you'd rather not be named.

## Supported versions

Diffline is in preview: fixes go into the latest release only.

[docs/architecture.md](docs/architecture.md#security-model) describes the security model: what the agents can and can't do, and what's checked before anything is posted.
