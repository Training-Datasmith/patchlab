# patchlab

**Isolated patch laboratory for coding agents**

> Patchlab copies your source into a container, runs a coding tool with full permissions, and extracts a patch. Your working tree does not change until you apply it.

Coding agents work fastest in YOLO mode — install packages, run shell commands, rewrite files. Bind-mounting the live tree means mistakes land on disk immediately. Restricting the agent often means it cannot finish the job. Patchlab takes a third path: **copy the work into a disposable lab, let the tool cook, take a patch out.**

The lab is tool-agnostic and container-agnostic. What is wired up today is listed under [Prerequisites](#prerequisites) and [Supported Tools](#supported-tools).

1. **Host tree untouched** — sources are copied in, not bind-mounted. `.env`, keys, and PEM files are excluded by default (`--include-secrets` to opt in).
2. **Loopback models reachable** — tools that talk to Ollama, LM Studio, and similar on `127.0.0.1` can use `host.patchlab.internal` (the built-in OpenCode path is documented in [OpenCode in patchlab](documents/opencode.md)).
3. **Reviewable output** — exit produces a unified diff and stacked commits on `patchlab/{id}` branches. Review with `patchlab apply . <patch> --dry-run` before merge.

## Quick start

```bash
git clone https://github.com/Training-Datasmith/patchlab.git
cd patchlab
npm install && npm run build && npm link

patchlab create .                    # sandbox; host tree unchanged
# … work in the sandbox …
patchlab apply . /tmp/patchlab-*.patch --dry-run
patchlab apply . /tmp/patchlab-*.patch
```

One-shot prompt (no TUI): `patchlab create . -p "Add tests for utilities.ts"`. Additional tools: [configuration-based providers](documents/configuration-based-providers.md).

## Why patchlab

| Approach | Working tree | When it changes |
|----------|--------------|-----------------|
| **patchlab** | A copy of your sources | After you apply a patch |
| Bind-mount sandbox | Your real files | As the tool writes |
| OS-native agent sandbox | Project directory writable | As the tool writes |
| Tool on the host | Your real files | As the tool writes |


## Prerequisites

- A container runtime:
  - **Windows:** [Podman](https://podman.io/docs/installation/windows) with a Podman machine — see [Windows setup](#windows-setup-with-podman)
  - **macOS:** [Lima](https://lima-vm.io/) with nerdctl — see [macOS setup](#macos-setup-with-lima--nerdctl)
  - **Linux / CI:** [Podman](https://podman.io/docs/installation) installed and running
- Node.js 20+
- Git (recommended on all platforms)

### macOS setup with Lima + nerdctl

Patchlab auto-detects `nerdctl.lima` on macOS. Run the setup script:

```bash
./scripts/set-up-mac-containers.sh
```

Or install manually:

```bash
brew install lima
limactl start
nerdctl.lima run --rm hello-world
```

Add to your shell profile (`~/.zshrc`):

```bash
alias nerdctl='nerdctl.lima'
export PATCHLAB_CONTAINER_RUNTIME=nerdctl   # optional; auto-detected on macOS
```

Set `PATCHLAB_CONTAINER_RUNTIME=podman` to force Podman instead. Linux and Windows default to Podman.

### Windows setup with Podman

Patchlab runs the CLI natively on Windows and executes sandboxes inside a **Podman machine** VM (same model as Podman on macOS). WSL is not required.

Run the setup script in PowerShell:

```powershell
.\scripts\set-up-windows-containers.ps1
```

Or install manually:

1. Install [Podman Desktop](https://podman.io/docs/installation/windows) or the Podman CLI and ensure `podman` is on your `PATH`.
2. Initialize and start a machine (first run downloads a VM image):

```powershell
podman machine init    # skip if a machine already exists
podman machine start
podman run --rm hello-world
```

3. Build and link patchlab from a clone (Git Bash or PowerShell):

```powershell
npm install
npm run build
npm link
```

Patchlab auto-starts the Podman machine when you run `patchlab create` if the VM is stopped. If the machine is stuck, `podman machine stop` then `podman machine start`; patchlab can also prompt to reset the VM.

**What works on Windows today:** unit tests, Windows-specific path tests (`test/windows/`), integration tests when Podman responds, local-model proxy, drive-letter paths, OpenCode host-config copy.

**Gaps:** nerdctl/Lima is macOS-only. POSIX-only filesystem tests run inside a Linux container via `npm run test:posix`, not on the native Windows kernel. Resource-limit cgroup warnings are Linux-specific; the Podman machine VM handles limits inside the guest.

## Install

### From source

```bash
git clone https://github.com/Training-Datasmith/patchlab.git
cd patchlab
npm install
npm run build
npm link
```

This makes the `patchlab` command available globally via symlink.

### From npm (when published)

```bash
npm install -g patchlab
```

## Examples

```bash
# List available providers (includes built-in OpenCode)
patchlab list-tools

# Default: OpenCode is built in — no registration needed
patchlab create .

# Custom tool: register a provider once, then pass --tool
# See documents/configuration-based-providers.md
# Example: ~/.config/patchlab/tools/my-tool.yaml or ~/.patchlab/tools/my-tool.yaml
patchlab create . --tool my-tool

# When the tool exits, patchlab automatically extracts a patch:
#   Patch extracted: /tmp/patchlab-7bc5111c.patch
#   Apply with: patchlab apply /path/to/project /tmp/patchlab-7bc5111c.patch

# Review the patch
cat /tmp/patchlab-7bc5111c.patch

# Dry-run to verify it applies cleanly
patchlab apply . /tmp/patchlab-7bc5111c.patch --dry-run

# Apply it
patchlab apply . /tmp/patchlab-7bc5111c.patch
```

## Commands

### `patchlab create <source>`

Create a sandbox from a source directory. Copies files into a Podman container, initializes a git baseline, installs dependencies, and launches an interactive AI coding tool session.

On exit, the patch is automatically extracted to a temp file.

| Option | Description |
|--------|-------------|
| `--source <path>` | Additional source directory (repeatable). Sources MAY span multiple git repositories. Each mounts at `${HOME}/workspace/<mount_name>/`. See [Multiple sources](#multiple-sources) and [Working across repositories](#working-across-repositories). |
| `--mount <name>` | Container-side mount name for the corresponding positional source. Repeatable: the Nth `--mount` applies to the Nth source (0 = primary, 1 = first `--source`, etc.). REQUIRED for every source in a multi-repository create. |
| `--image <image>` | Container image (default: auto-detected or `node:22-slim`) |
| `--tool <name>` | AI coding tool to use (default: **OpenCode**; override with `--tool`, user-global `default_tool`, or per-repository `default_tool` after first-encounter confirmation). See [Tool Providers](#supported-tools). |
| `--include <globs...>` | Glob patterns to include |
| `--exclude <globs...>` | Glob patterns to exclude |
| `--no-install` | Skip automatic `npm install` |
| `--force-rebuild` | Force fresh image build, ignoring cached images |
| `--context <paths...>` | Extra files/directories to inject at `${HOME}/context/` (sibling to `workspace/`, outside the git-managed tree) |
| `--include-secrets` | Copy files matched by the default secret-exclude patterns (e.g. `.env`, keys) into the sandbox. Off by default. |
| `--allow-socket-mount` | Allow Podman/Docker socket mount without prompting |
| `--deny-socket-mount` | Deny socket mount without prompting |
| `--no-interactive` | Skip interactive AI tool launch (for scripts/CI) |
| `-p, --prompt [text]` | Run a one-shot prompt when the tool supports it; omit text or use `-p -` to read stdin. Incompatible with `--no-interactive`. Tool exit code propagated after extraction. Place `-p` before the source path when piping stdin (`patchlab create . -p`); `patchlab create -p ./src` treats `./src` as the prompt text, not the source. |
| `--passthrough <token>` | Forward argv tokens to the tool launch command (repeatable). Works for interactive TUI and `-p`. Use `--passthrough=--flag` for flag-like tokens. Incompatible with `--no-interactive` unless `-p` is also set (OpenCode rejects passthrough when the tool is not launched). |
| `--prompt-file <path>` | Stage a host file into `$HOME/context/` and pass it to OpenCode `run --file` (repeatable; requires `-p`). |
| `--memory` / `--cpus` / `--pids-limit` / `--blkio-weight` | Per-invocation resource limits (see [Resource limits](#resource-limits)) |
| `--strict-trust` / `--allow-untrusted-manifests` | Trust-prompt behavior for per-source tool manifests in non-interactive mode (see [Supported Tools](#supported-tools)) |
| `--allow-untrusted-default-tool` | Non-interactive opt-in for per-repository `default_tool` when `--tool` is omitted (separate from `--allow-untrusted-manifests`; see [Configuration](documents/configuration.md#default_tool)) |

### Multiple sources

A patchlab can mount more than one subpath of a single git repository. The positional argument is the primary source; each additional source is supplied via a repeatable `--source <path>` flag.

```bash
# Single source (unchanged): mounts at ${HOME}/workspace/<source_prefix>/
patchlab create ./src/ui --tool my-tool

# Two sources from the same repository: each mounts under its own prefix
patchlab create ./src/ui --source ./src/server --tool my-tool
```

Sources MAY span multiple git repositories. When every source resolves to the same `repository_root`, mount names default to each source's `source_prefix` (no `--mount` flag needed). When sources span two or more distinct repositories, every source MUST carry an explicit `--mount <name>` flag (see [Working across repositories](#working-across-repositories)) because `source_prefix` is per-repository — the same `src/` could appear in two repos without disambiguation.

Each mount preserves the host repo's relative path under the container's workspace root: `./src/ui` lands at `${HOME}/workspace/src/ui/`, and `./src/server` lands at `${HOME}/workspace/src/server/`. The container's git baseline commits the entire `${HOME}/workspace/` tree, so the patchlab branch records changes at their repo-relative paths — `patchlab apply` requires no path translation.

Validation rules at create time (all rejected with the offending source paths named):

- **Source-prefix uniqueness within a repository** — two sources within ONE repository whose `source_prefix` matches (case-insensitive ASCII) are rejected. Cross-repository same-prefix is accepted; the explicit `--mount` requirement disambiguates the container path.
- **Mount-name uniqueness (global)** — two sources with the same `mount_name` are rejected regardless of which repository each belongs to. Mount names are global because they share the `${HOME}/workspace/` namespace.
- **Multi-repository mount-name explicitness** — when sources span two or more repositories, every source MUST be supplied with `--mount <name>`. Missing `--mount` is rejected before any sandbox or branch work begins.
- **Empty-prefix exclusivity within a repository** — a source at a repository root may only appear when it is the only source from THAT repository.
- **No nested-prefix overlap within a repository** — path-component-aware: `./src` plus `./src/ui` within ONE repository is rejected (nested); `./src` plus `./src2` is accepted (siblings); cross-repository nested-prefix is accepted because each repository has an independent prefix namespace.

### Working across repositories

A patchlab can span two or more distinct host git repositories. The CLI flag layout: pass every source positionally or via `--source`, paired with an explicit `--mount <name>` for each. Mount names appear top-level in the container's `${HOME}/workspace/`; the host-side commit per repository lands on each repository's own `patchlab/{id}` branch.

```bash
# Cross-repository patchlab spanning /repo-a/src and /repo-b/lib.
# Both --mount flags are REQUIRED.
patchlab create /repo-a/src --mount frontend \
    --source /repo-b/lib --mount backend --tool my-tool
```

The container sees:

```
${HOME}/workspace/
├── frontend/    # contents of /repo-a/src
└── backend/     # contents of /repo-b/lib
```

When the session exits, patchlab fans out the staged diff per repository: each repository's `patchlab/{id}` branch gets one commit covering the changes under that repository's mount(s). Per-repository outcomes (commit SHA or fallback patch path) are recorded in the session metadata under `commit_shas` and `fallback_patches`.

After a successful session, apply to one repository at a time. The `--repository <path>` flag is REQUIRED for multi-repository patchlabs:

```bash
# Apply /repo-a's session commits to the current branch in /repo-a.
cd /repo-a
patchlab apply <patchlab-id> --repository /repo-a

# Then apply /repo-b's session commits in /repo-b.
cd /repo-b
patchlab apply <patchlab-id> --repository /repo-b
```

Each repository's apply is independent — applying to `/repo-a` does not affect `/repo-b`. Sessions where the chosen repository's `commit_shas` entry is `null` (the session didn't touch that repository's mounts) are silently skipped.

`patchlab inspect <id>` enumerates every repository the patchlab spans, including each repository's branch state and per-session per-repository commit/fallback display. `patchlab patch <id>` without `--repository` on a multi-repository patchlab emits each repository's cumulative diff in turn, separated by `# === Patch for <repository_root> ===` comment headers that `git apply` ignores.

`patchlab destroy <id>` deletes the `patchlab/{id}` branch in EVERY repository the patchlab spans. The destroy may partially succeed: if any repository's branch has unapplied session commits and you decline the per-repository confirmation, that repository's branch is left intact and the archive directory is retained for recovery (re-run with `--force` or manually delete the branches).

**Per-repository trust prompts**: when one or more of the spanned repositories has a `<repository_root>/.patchlab/tools/*.yaml` configured-tool manifest that has never been confirmed (or whose contents have changed since last confirmation), `patchlab create` prompts for trust **once per repository** before any branch is created. Prompts run sequentially in source-flag order:

```text
$ patchlab create /repo-a/src --mount a --source /repo-b/src --mount b --tool aider
patchlab: per-source tool manifests detected in /repo-a:
  - /repo-a/.patchlab/tools/aider.yaml
    launch_command: ['aider']
    base_image: docker.io/library/python:3.12-slim
    authentication.method: file_copy (1 host file: /repo-a/.aider/config.yaml)
    dockerfile.install: (none)
Confirm trust for /repo-a's per-source manifests? [y/N] y

patchlab: per-source tool manifests detected in /repo-b:
  - /repo-b/.patchlab/tools/copilot.yaml
    launch_command: ['gh', 'copilot', 'cli']
    base_image: docker.io/library/node:22-slim
    authentication.method: environment_variables (GH_TOKEN)
    dockerfile.install: (none)
Confirm trust for /repo-b's per-source manifests? [y/N] y

Sandbox created: <patchlab-id>
```

Decline any repository's prompt and the entire create aborts (no branches created in any repository). Repositories already confirmed at the same content hash short-circuit without prompting. For full details — cross-repository tool-name collision rules, per-repository `file_copy.host` containment, and the per-source configuration composition lattice — see [Multi-repository patchlabs](documents/configuration-based-providers.md#multi-repository-patchlabs) in the configuration-based-providers documentation.

### `patchlab resume <patchlab>`

Resume a patchlab in a fresh sandbox from the branch tip plus a host overlay. Each resume opens a new session on the same patchlab id, restores the prior session's conversation state via the tool provider, and re-injects the merged context bundle.

| Option | Description |
|--------|-------------|
| `--context <paths...>` | Additional context files to merge with the previous session's context |
| `--no-install` | Skip automatic dependency install |
| `--no-interactive` | Skip interactive AI tool launch (for scripts/CI) |
| `-p, --prompt [text]` | Run a one-shot prompt when the tool supports it; omit text or use `-p -` to read stdin. Incompatible with `--no-interactive`. Tool exit code propagated after extraction. Place `-p` before the source path when piping stdin (`patchlab create . -p`); `patchlab create -p ./src` treats `./src` as the prompt text, not the source. |
| `--passthrough <token>` | Forward argv tokens to the tool launch command (repeatable). Works for interactive TUI and `-p`. Use `--passthrough=--flag` for flag-like tokens. Incompatible with `--no-interactive` unless `-p` is also set (OpenCode rejects passthrough when the tool is not launched). |
| `--prompt-file <path>` | Stage a host file into `$HOME/context/` and pass it to OpenCode `run --file` (repeatable; requires `-p`). |
| `--memory` / `--cpus` / `--pids-limit` / `--blkio-weight` | Resource-limit overrides for this resume (otherwise inherited from the prior session) |

### `patchlab list`

List all active sandboxes with their status.

### `patchlab inspect <sandbox>`

Show detailed JSON metadata for a sandbox.

### `patchlab diff <sandbox>`

Show changed files in a sandbox (`+` added, `~` modified, `-` deleted).

### `patchlab patch <sandbox>`

Generate a unified diff patch from sandbox changes. Prints to stdout by default.

| Option | Description |
|--------|-------------|
| `-o, --output <file>` | Write patch to a file instead of stdout |

### `patchlab apply <target> <patch-file>`

Apply a patch file to a target directory.

| Option | Description |
|--------|-------------|
| `--dry-run` | Validate the patch without modifying files |

### `patchlab exec <sandbox> <command...>`

Execute a command inside a running sandbox container.

### `patchlab build-image`

Build a patchlab-compatible container image with tools pre-installed. Auto-detects your project's language (from `composer.json`, `package.json`, etc.) and required system packages (including PHP extensions from `ext-*` entries in `require`, `require-dev`, and `suggest`).

| Option | Description |
|--------|-------------|
| `--base <image>` | Base image (default: auto-detected) |
| `--tools <tools...>` | Tools to install (**required**). Run `patchlab list-tools` to see available names. |
| `--tag <tag>` | Image tag |
| `--exclude-suggested` | Skip PHP extensions listed in `composer.json` `suggest` (default: include them) |

### `patchlab images`

List locally available patchlab-compatible images.

### `patchlab list-tools [source]`

List registered tool providers from user-global manifests (`~/.config/patchlab/tools/` and `~/.patchlab/tools/`). Pass a source path to also include per-source manifests under `<repository_root>/.patchlab/tools/`; unconfirmed per-source manifests are annotated without firing the trust prompt. Providers that support `patchlab create|resume -p` are marked with `[-p]`.

### `patchlab destroy <sandbox>`

Destroy a sandbox and its container.

### `patchlab gc`

Remove stale sandboxes (and, for multi-repository patchlabs, scan each repository's orphan `patchlab/{id}` branches).

| Option | Description |
|--------|-------------|
| `--older-than <days>` | Remove sandboxes older than N days (default: 7) |
| `--no-missing` | Skip sandboxes with missing containers |
| `--dry-run` | Show what would be removed without removing |
| `--force` | Skip confirmation prompt |

## Resource limits

Every sandbox is created with podman resource-limit flags applied. Defaults are computed at runtime from the host's capacity (assuming one sandbox at a time):

- `--memory`: 75% of total host RAM, rounded down to the nearest 256 MiB, with a 1 GiB floor.
- `--cpus`: `max(1, host_cpu_count - 1)` as a decimal (reserves one core for the host).
- `--pids-limit`: fixed `1024`.
- `--blkio-weight`: omitted by default; podman's own neutral default (`500`) applies.

Override on `patchlab create` or `patchlab resume` with explicit flags:

```bash
patchlab create ./source --tool my-tool --memory 4g --cpus 2.0 --pids-limit 1024 --blkio-weight 500
```

Values use podman's native formats: memory accepts an integer optionally suffixed with `b`/`k`/`m`/`g`; `cpus` accepts a decimal; `pids-limit` accepts a non-negative integer; `blkio-weight` accepts an integer in `[10, 1000]`.

Pass `0` to `--memory`, `--cpus`, or `--pids-limit` to opt out of enforcement for that field (the flag is omitted from `podman create`). Negative values are rejected at parse time. There is no "unlimited" form for `--blkio-weight` because it's a relative weight, not a cap.

Resolved values persist into the sandbox's per-session metadata. A subsequent bare `patchlab resume <id>` inherits the create-time choice (including an explicit `--memory 0` opt-out); pass new flags on resume to override per-field.

Set persistent defaults without re-typing flags by creating `~/.patchlab/configuration.yaml` (user-global) or `<source>/.patchlab/configuration.yaml` (per-source). The full schema, precedence ladder, and per-source clamping rules are in [documents/configuration.md](documents/configuration.md).

On Linux hosts where rootless Podman cannot enforce limits (cgroup v2 controllers not delegated), patchlab emits a one-time stderr warning at first `patchlab create` and continues. The warning links to [documents/configuration.md#cgroup-delegation](documents/configuration.md#cgroup-delegation).

## Configuration file

Patchlab reads optional YAML configuration files at two locations:

- `~/.patchlab/configuration.yaml` — user-global, applies to every sandbox you create.
- `<repository_root>/.patchlab/configuration.yaml` — per-repository (formerly per-source), applies to sandboxes created from any source under this git repository, including multi-source patchlabs. Per-repository values are **clamped** so they can only tighten the user-global / default upper bound (no trust prompt needed).

In v1 the schema accepts one top-level key, `resource_limits`, with the four fields from the [Resource limits](#resource-limits) section. See [documents/configuration.md](documents/configuration.md) for the full schema, precedence ladder, and failure-mode catalog.

## Configuration

Place a `.patchlab.json` file in your project root to configure sandbox behavior:

```json
{
  "requirements": {
    "system_packages": ["postgres-client", "redis-tools"],
    "volume_mounts": ["/host/path:/container/path"],
    "environment_variables": {
      "DATABASE_URL": "postgres://localhost:5432/test"
    }
  },
  "ignore_detected": ["redis-tools"],
  "allow_socket_mount": true
}
```

| Field | Description |
|-------|-------------|
| `requirements.system_packages` | Additional system packages to install in the container |
| `requirements.volume_mounts` | Host paths to mount into the container |
| `requirements.environment_variables` | Environment variables to set in the container |
| `ignore_detected` | Auto-detected requirements to skip |
| `allow_socket_mount` | Allow Podman/Docker socket mount without prompting |
| `sources` | Declare a stable set of source directories (see below) |

### Declaring sources in `.patchlab.json`

The `sources` array lets you declare a stable set of source directories once so that `patchlab create` (run with no source arguments) builds the sandbox from those sources automatically. This is useful when working from a workspace directory that holds several git repositories as siblings.

```json
{
  "sources": [
    "patchlab",
    "other-library"
  ]
}
```

Run from the directory containing this file:

```bash
patchlab create   # uses sources from .patchlab.json; tool from --tool, config, or built-in OpenCode
```

`--tool` overrides per-repository and user-global `default_tool` in `.patchlab/configuration.yaml`. `.patchlab.json` does not store a default tool.

**String entries** — each string is both a relative path to the source directory (resolved from the `.patchlab.json` file's directory) and the mount name under `workspace/` inside the sandbox. For example, `"patchlab"` mounts the `patchlab/` directory at `~/workspace/patchlab/` in the sandbox. Use a subdirectory path (`"patchlab/src"`) to limit what is included; the git repository root is still auto-discovered from the path, and the mount name is the full string (`patchlab/src`).

**Object entries** — for cases where the path and mount name should differ:

```json
{
  "sources": [
    { "path": "repos/my-project", "mount": "project" },
    { "path": "repos/shared-lib", "mount": "lib" }
  ]
}
```

Object entries behave identically to passing `--source <path> --mount <mount>` on the command line.

**Paths** are resolved relative to the `.patchlab.json` file's directory. Absolute paths are accepted as-is.

**Discovery** — patchlab looks for `.patchlab.json` in the current working directory first, then in the git repository root of the CWD (when the CWD is inside a git repo and its git root is a different directory). The first file found with a non-empty `sources` array wins.

**CLI preempts file** — if any source-related CLI argument is provided (the positional source path, `--source`, or `--mount`), the `sources` field in `.patchlab.json` is ignored entirely for that invocation. CLI arguments always take precedence.

**Multi-repository sources** — string entries always carry an explicit mount name (the string itself), so they satisfy the multi-repository mount-name requirement without needing `--mount` flags. Two strings that would resolve to the same mount name (e.g., `"repo-a/src"` and `"repo-b/src"`) are rejected with a clear collision error.

## Supported Tools

Patchlab is tool-agnostic. The built-in default today is **OpenCode** — `patchlab create .` launches it without `--tool`. See [documents/opencode.md](documents/opencode.md) for host config copy, credentials, and local-model proxying.

Additional providers are registered via YAML manifests under `~/.config/patchlab/tools/` or `~/.patchlab/tools/` (user-global) or `<repository>/.patchlab/tools/` (per-source). Run `patchlab list-tools` to see what is available.

See [documents/configuration-based-providers.md](documents/configuration-based-providers.md) for the manifest format. To replace the built-in OpenCode provider, use `overrides_builtin: true` in a manifest named `opencode`.

```bash
patchlab list-tools
patchlab create .
patchlab create . --tool my-tool
```

## Output channels

Patchlab follows the strict Unix convention for output streams:

- **stdout** carries the command's pipeable answer — list rows from `patchlab list`, the JSON dump from `patchlab inspect`, the patch content from `patchlab patch`, the file-path lines from `patchlab diff`, the image rows from `patchlab images`.
- **stderr** carries everything else — progress messages ("Building patchlab image…", "Using cached image: …"), action confirmations ("Sandbox created: abc123", "Image built: …"), warnings, and errors.

Examples:

```bash
# Pipe only the structured result — no progress chatter clutters the pipe
patchlab list | awk '{print $1}'

# Capture progress and warnings to a file while keeping the terminal clean for results
patchlab create ./source --tool my-tool 2> diag.log
```

Note for users upgrading from a previous release: action confirmations such as `Sandbox created: <id>` previously appeared on stdout. They now appear on stderr alongside other progress output. Scripts that captured the structured answer from `patchlab list`, `patchlab inspect`, `patchlab patch`, or `patchlab diff` are unaffected — those commands continue to emit their canonical answer on stdout. If a future scripting need surfaces a requirement to capture just an ID (or other machine-readable value), individual commands will gain explicit modes (e.g. `--quiet`, `--format json`) that route through stdout.

## Verbose output

Patchlab has an opt-in verbose-diagnostic channel that is off by default. Activate it with either:

- **`PATCHLAB_VERBOSE` environment variable** — persistent across invocations within a shell session. Recognized "off" values: unset, the empty string, `0`, case-insensitive `false`, and case-insensitive `off`. Any other non-empty value activates verbose mode. Examples: `PATCHLAB_VERBOSE=1`, `PATCHLAB_VERBOSE=on`, `PATCHLAB_VERBOSE=yes` all turn it on; `PATCHLAB_VERBOSE=0`, `PATCHLAB_VERBOSE=false`, `PATCHLAB_VERBOSE=off` keep it off.
- **`--verbose` CLI flag** — per-invocation. Activates verbose mode just for the current command. Accepted in any position relative to the subcommand: `patchlab --verbose create ./source --tool my-tool`, `patchlab create --verbose ./source --tool my-tool`, and `patchlab create ./source --tool my-tool --verbose` are all equivalent.

**Precedence: CLI wins.** If `--verbose` is present, verbose mode is on regardless of the env var. If `--verbose` is absent, the env var is consulted. There is no `--no-verbose` flag in this release — users with `PATCHLAB_VERBOSE=1` exported who want one quiet command can use shell syntax: `PATCHLAB_VERBOSE= patchlab create ./source --tool my-tool`.

Verbose output goes to **stderr** (alongside other diagnostic output). Every emitted line is prefixed with the literal `patchlab[verbose]: ` so you can filter:

```bash
# Capture only verbose lines to a file
patchlab create --verbose ./source --tool my-tool 2> verbose.log

# Show only verbose lines on the terminal
patchlab create --verbose ./source --tool my-tool 2>&1 >/dev/null | grep '^patchlab\[verbose\]:'

# Strip verbose lines from a combined log
patchlab create --verbose ./source --tool my-tool 2>&1 | grep -v '^patchlab\[verbose\]:'
```

The `--verbose` flag is reserved at the program level; subcommands SHALL NOT define their own `--verbose` flag with a different meaning.

## How It Works

1. **Create**: Patchlab copies your source files into a container, initializes a git baseline commit, and optionally installs npm dependencies.
2. **Work**: Your chosen AI coding tool runs inside the container with full access to modify files.
3. **Extract**: On exit, patchlab generates a unified diff against the baseline.
4. **Apply**: You review the patch and apply it to your source directory when ready.

Cached images are reused across sandboxes to speed up subsequent creates. Patchlab auto-detects project language, required system packages, and services from your project files.

## Image cache labels

Patchlab tags each built image with a per-tool state label (`biz.ecartz.patchlab.tool.<tool>`) that records what authentication was done at build time:

- **`absent`** — the image has no per-tool label for this tool.
- **`installed`** — the tool binary is in the image; no authentication was injected at build time.
- **`authenticated`** — the tool binary and credentials are baked into the image filesystem (file-copy authentication).
- **`ready`** — the tool binary is in the image, `inject_authentication` ran at build time, but credentials are supplied at container-create time via environment variable.

OpenCode uses authentication method `none`, so its cached images typically carry the `installed` label.

## License

Patchlab is licensed under the [GNU General Public License v3.0 or later](LICENSE) (SPDX: `GPL-3.0-or-later`). See [LICENSE](LICENSE) for the full license text.
