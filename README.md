# Agent Profiles

Manage separate Codex CLI accounts on **Windows, Linux, and WSL** with one `CODEX_HOME` per profile. It has no external dependencies and requires **Node.js 22+** and npm. These profiles represent separate accounts and home directories; they are different from `codex --profile` configuration profiles.

Agent Profiles currently supports **Codex only**. Support for **OpenCode** and **Claude** is planned for future releases.

## Installation

Install Node.js, npm, and the Codex CLI in the environment where you will run the commands. Install directly from GitHub:

```sh
npm install -g --allow-git=all git+https://github.com/alexishida/codex-profiles-cli.git
```

The package and command are named `agent-profiles`. The installation URL uses the repository's existing name.

For a local checkout, run this from the project directory instead:

```sh
npm install -g .
```

Verify the installation:

```sh
node --version
codex --version
agent-profiles help
```

On Windows, the CLI supports `codex.exe` and the official `@openai/codex` npm installation through `codex.cmd`. The npm launcher runs directly through Node.js, which preserves arguments without passing them through `cmd.exe`. Custom `.cmd` launchers are not supported.

On Linux and WSL, install native Linux Node.js, npm, and Codex. In WSL, Codex installations in `/mnt/c`, `/mnt/d`, and other Windows drives are ignored to avoid mixing Windows executables and credentials with Linux. Windows and WSL use independent installations and active profiles. Use `command -v node` and `type -a codex` to verify your setup. Make sure global npm binaries are on `PATH`; if npm requires `sudo`, configure a user prefix or a Node.js version manager.

## Usage

Commands use the format `agent-profiles codex COMMAND`. The `codex` subcommand selects the agent being managed; it is currently the only supported agent. These commands work in PowerShell, Bash, and Zsh:

All profile operations now require the `codex` subcommand. Update existing scripts and shell integration entries accordingly. Existing profiles and storage locations are preserved.

```sh
agent-profiles codex create personal          # creates a profile and starts codex login
agent-profiles codex create work
agent-profiles codex list
agent-profiles codex use work
agent-profiles codex exec                     # starts Codex with the active account
agent-profiles codex run personal -- --version
agent-profiles codex current
agent-profiles codex login personal
agent-profiles codex run work -- login status
agent-profiles codex run work -- login --device-auth
agent-profiles codex create test --no-login
agent-profiles codex remove test --force      # removes this profile's data
agent-profiles codex help
```

`run` does not change the active profile. `use` affects only new sessions. Each name can contain up to 64 ASCII letters, numbers, `_`, or `-`, and must begin with a letter or number. Windows reserved names such as `CON`, `NUL`, and `COM1`, as well as duplicates that differ only by letter case, are rejected on every platform. Use the exact spelling shown by `list`.

To remove all Codex profiles managed by Agent Profiles:

```sh
agent-profiles codex remove-all --force
```

This deletes every registered Codex profile and its stored data, then clears the active profile. The `--force` confirmation is required. Unregistered directories and the default Codex home are not deleted. Running it again when no profiles remain succeeds without further deletion. All targets are validated before removal, and directories are restored if moving a target or saving the state fails.

## Shell integration

To run `codex` with the active account, add the integration to your shell startup file.

**Bash** (`~/.bashrc`):

```sh
eval "$(agent-profiles codex shell-init bash)"
```

**Zsh** (`~/.zshrc`):

```sh
eval "$(agent-profiles codex shell-init zsh)"
```

**PowerShell** (`$PROFILE`, including Windows PowerShell 5.1 and PowerShell 7):

```powershell
agent-profiles codex shell-init powershell | Out-String | Invoke-Expression
```

Create `$PROFILE` if it does not exist, then reopen the terminal. Replace any previous `codex-profile shell-init` entry with the new command. The integration replaces an existing `codex` function. If you already have a `codex` alias, remove it with `Remove-Item Alias:codex`. Sessions retain the terminal's current working directory and environment variables.

The PowerShell integration serializes arguments before calling the npm launcher, preserving empty strings, quotes, Unicode, and trailing backslashes on Windows PowerShell 5.1 and PowerShell 7. On PowerShell 5.1, use the integrated `codex` function for arguments requiring this preservation; direct native command calls follow PowerShell's legacy argument handling.

Command Prompt (`cmd.exe`) can run `agent-profiles` commands, but it does not support `shell-init`; use `agent-profiles codex exec` instead.

## Storage

| Environment | State | Profile directories |
| --- | --- | --- |
| Windows | `%APPDATA%\agent-profiles\state.json` | `%LOCALAPPDATA%\agent-profiles\profiles\NAME` |
| Linux / WSL | `~/.config/agent-profiles/state.json` | `~/.local/share/agent-profiles/profiles/NAME` |

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` override these roots on all platforms and must be absolute paths. Keep them consistent between sessions; changing only one root can invalidate saved paths. If no state exists under `agent-profiles`, existing `codex-profiles` storage is reused, including the older Windows locations at `~/.config` and `~/.local/share`. Existing home paths and credentials are preserved. New installations use the paths in the table.

On Linux and WSL, managed directories use `0700` and the state file uses `0600`. On Windows, protection comes from the inherited ACLs on the user directory; POSIX modes do not configure Windows ACLs. Profile directories and managed roots that are symbolic links or junctions are rejected.

State is validated before use and replaced by renaming a temporary file. Concurrent modifications use `state.lock`: a competing operation can fail and ask you to retry without overwriting the other change. If an interrupted process leaves a lock, confirm that no `agent-profiles` process is making changes before removing the file named in the error. Help and shell integration remain available when state is corrupted.

Removal first moves the profile to a temporary `.removed-*` directory. If saving the updated state fails, the profile directory is restored. If deleting the staged data fails after the state is saved, the error reports its remaining location. An interrupted removal can also leave a `.removed-*` directory; inspect it and the state before recovering or deleting those files.

Codex stores configuration, history, and credentials in files or the operating system credential store, depending on its configuration. `cli_auth_credentials_store = "file"` stores `auth.json` in the profile's `CODEX_HOME`. With `keyring` or `auto`, removing a profile directory might not remove credentials held by the operating system credential store; run `agent-profiles codex run NAME -- logout` before removal. Inherited authentication variables and organization policies can also affect the account used. See the [official authentication documentation](https://learn.chatgpt.com/docs/auth).

Do not share profile directories: they can contain tokens. A failed login leaves the profile available for another attempt with `agent-profiles codex login NAME`.

## Validation

```sh
npm run check
npm test
```

Tests use temporary directories and a simulated Codex executable. They validate profile isolation, arguments, exit codes, invalid state, concurrent writes, symbolic links, POSIX permissions, legacy storage compatibility, removal failures, and installation from a `.tgz` package into a temporary prefix. Windows shell integration is tested through the installed npm launcher in PowerShell 5.1 and PowerShell 7 when available. Bash/Zsh integration is tested on Linux when available. No test signs in to a real account.

The minimum supported version is Node.js 22. Check the [official release list](https://nodejs.org/en/about/previous-releases) for maintained releases. Your installed Codex version can have its own runtime requirements.

Run the validation commands in each target environment before releasing. Platform-specific tests are skipped when their required platform is unavailable.
