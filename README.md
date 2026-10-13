# Codex Profiles CLI

Manage separate Codex CLI accounts on **Windows, Linux, and WSL** with one `CODEX_HOME` per profile. It has no external dependencies and requires **Node.js 22+** and npm. These profiles represent separate accounts and home directories; they are different from `codex --profile` configuration profiles.

## Installation

Install Node.js, npm, and the Codex CLI in the environment where you will run the commands. Install directly from GitHub:

```sh
npm install -g --allow-git=all git+https://github.com/alexishida/codex-profiles-cli.git
```

For a local checkout, run this from the project directory instead:

```sh
npm install -g .
```

Verify the installation:

```sh
node --version
codex --version
codex-profile help
```

On Windows, the CLI supports `codex.exe` and the official `@openai/codex` npm installation through `codex.cmd`. The npm launcher runs directly through Node.js, which preserves arguments without passing them through `cmd.exe`. Custom `.cmd` launchers are not supported.

On Linux and WSL, install native Linux Node.js, npm, and Codex. In WSL, Codex installations in `/mnt/c`, `/mnt/d`, and other Windows drives are ignored to avoid mixing Windows executables and credentials with Linux. Windows and WSL use independent installations and active profiles. Use `command -v node` and `type -a codex` to verify your setup. Make sure global npm binaries are on `PATH`; if npm requires `sudo`, configure a user prefix or a Node.js version manager.

## Usage

These commands work in PowerShell, Bash, and Zsh:

```sh
codex-profile create personal          # creates a profile and starts codex login
codex-profile create work
codex-profile list
codex-profile use work
codex-profile exec                     # starts Codex with the active account
codex-profile run personal -- --version
codex-profile current
codex-profile login personal
codex-profile run work -- login status
codex-profile run work -- login --device-auth
codex-profile create test --no-login
codex-profile remove test --force      # removes this profile's data
```

`run` does not change the active profile. `use` affects only new sessions. Each name can contain up to 64 ASCII letters, numbers, `_`, or `-`, and must begin with a letter or number. Windows reserved names such as `CON`, `NUL`, and `COM1`, as well as duplicates that differ only by letter case, are rejected on every platform. Use the exact spelling shown by `list`.

## Shell integration

To run `codex` with the active account, add the integration to your shell startup file.

**Bash** (`~/.bashrc`):

```sh
eval "$(codex-profile shell-init bash)"
```

**Zsh** (`~/.zshrc`):

```sh
eval "$(codex-profile shell-init zsh)"
```

**PowerShell** (`$PROFILE`, including Windows PowerShell 5.1 and PowerShell 7):

```powershell
codex-profile shell-init powershell | Out-String | Invoke-Expression
```

Create `$PROFILE` if it does not exist, then reopen the terminal. The integration replaces an existing `codex` function. If you already have a `codex` alias, remove it with `Remove-Item Alias:codex`. Sessions retain the terminal's current working directory and environment variables.

Command Prompt (`cmd.exe`) can run `codex-profile` commands, but it does not support `shell-init`; use `codex-profile exec` instead.

## Storage

| Environment | State | Profile directories |
| --- | --- | --- |
| Windows | `%APPDATA%\codex-profiles\state.json` | `%LOCALAPPDATA%\codex-profiles\profiles\NAME` |
| Linux / WSL | `~/.config/codex-profiles/state.json` | `~/.local/share/codex-profiles/profiles/NAME` |

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` override these roots on all platforms and must be absolute paths. Keep them consistent between sessions; changing only one root can invalidate saved paths. On Windows, prior installations at `~/.config` and `~/.local/share` remain in use when their old state file exists and no state file exists in the new location.

On Linux and WSL, managed directories use `0700` and the state file uses `0600`. On Windows, protection comes from the inherited ACLs on the user directory; POSIX modes do not configure Windows ACLs. Profile directories and managed roots that are symbolic links or junctions are rejected.

State is validated before use and replaced by renaming a temporary file. Concurrent modifications use `state.lock`: a competing operation can fail and ask you to retry without overwriting the other change. If an interrupted process leaves a lock, confirm that no `codex-profile` process is making changes before removing the file named in the error. Help and shell integration remain available when state is corrupted.

Codex stores configuration, history, and credentials in files or the operating system credential store, depending on its configuration. `cli_auth_credentials_store = "file"` stores `auth.json` in the profile's `CODEX_HOME`. With `keyring` or `auto`, removing a profile directory might not remove credentials held by the operating system credential store; run `codex-profile run NAME -- logout` before removal. Inherited authentication variables and organization policies can also affect the account used. See the [official authentication documentation](https://learn.chatgpt.com/docs/auth).

Do not share profile directories: they can contain tokens. A failed login leaves the profile available for another attempt with `codex-profile login NAME`.

## Validation

```sh
npm run check
npm test
```

Tests use temporary directories and a simulated Codex executable. They validate profile isolation, arguments, exit codes, invalid state, concurrent writes, symbolic links, POSIX permissions, and installation from a `.tgz` package into a temporary prefix. Shell integration runs in PowerShell on Windows and Bash/Zsh on Linux when available. No test signs in to a real account.

The CI matrix covers Windows and Ubuntu with Node.js 22, 24, 26, and `node` (the latest stable version). The minimum supported version is Node.js 22. Use a maintained release such as Node.js 22/24 LTS or 26 Current, according to the [official release list](https://nodejs.org/en/about/previous-releases). Your installed Codex version can have its own runtime requirements.

Local validation on October 13, 2026 used Node.js 22.23.3, 24.21.0, and 26.11.1 on Windows and Ubuntu/WSL. Each combination passed 16 tests, with one test restricted to the other platform skipped. Real `--version` calls also ran through the npm Codex launcher and `codex.exe` on Windows, and the Linux Codex installation in WSL, with temporary profiles. Native Linux outside WSL is covered by CI but was not run locally, and no real login was performed.
