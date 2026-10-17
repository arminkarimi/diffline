# Install git

Diffline fetches the commits of the pull requests you review with git.

**macOS**, with [Homebrew](https://brew.sh):

```
brew install git
```

Or install Apple's Command Line Tools, which include git: `xcode-select --install`.

**Windows**, in PowerShell:

```
winget install --id Git.Git -e --source winget
```

Or download the installer from [git-scm.com](https://git-scm.com/install/windows).

**Linux**: your distribution's package, such as `sudo apt-get install git` on Debian and Ubuntu or `sudo dnf install git` on Fedora. [git-scm.com](https://git-scm.com/install/linux) lists the others.

Then press **Check again**. If git still isn't found, restart the editor so it sees the new program.
