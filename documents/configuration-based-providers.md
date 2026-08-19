# Configuration-based tool providers

Patchlab's `--tool` flag dispatches to a registered provider. Register a provider by dropping a YAML manifest into one of two locations: **user-global** (your home directory, applied to every patchlab invocation) or **per-source** (inside a project's `.patchlab/tools/`, applied when patchlab runs against that source).

Per-source manifests come from cloned repositories you may not have authored. The runtime applies two security defenses to per-source content — a hard-policy [host-path containment check](#per-source-host-path-containment) at load time, and a [first-encounter trust prompt](#first-encounter-trust-prompt) before any launch command runs. User-global manifests skip both because you authored them yourself.

## Where manifests live

**User-global** locations are scanned at every CLI invocation:

- `~/.config/patchlab/tools/*.yaml` (XDG-compliant)
- `~/.patchlab/tools/*.yaml` (legacy fallback)

**Per-source** locations are scanned per-operation by single-target commands (`create`, `resume`, `inspect`) when the source path resolves to a git repository whose root contains one:

- `<repository_root>/.patchlab/tools/*.yaml`

The "per-source" scope name is retained for backwards-compatibility with code paths and documentation, but the semantic is **per-repository** under the single-repository invariant established by `sandbox-lifecycle`'s `Create sandbox from source directory` requirement. A single repository's `.patchlab/tools/` directory covers every patchlab created from it, including multi-source patchlabs that mount several subpaths of the same repository.

Files in subdirectories are NOT discovered. Only `.yaml` and `.yml` are matched — `.YAML`, `.yaml.bak`, `.swp` are skipped. Per-source manifests of the same name as a user-global manifest replace the user-global entry for the duration of the operation (per-source is the more specific configuration).

## Quick start

```yaml
# ~/.patchlab/tools/aider.yaml
name: aider
display_name: Aider
image_user: patchlab
base_image: docker.io/library/python:3.12-slim
dockerfile:
  install:
    - pip install --no-cache-dir aider-chat
authentication:
  method: environment_variables
  variable_names:
    - OPENAI_API_KEY
launch_command:
  - aider
  - --yes
  - --no-pretty
```

After saving, run `patchlab list-tools` to confirm it registered, then `patchlab create --tool aider <source>` to dispatch to it.

### Prompt launch (`-p`)

To support `patchlab create|resume -p`, declare `prompt_launch_command` with a `{{prompt}}` placeholder. Use `--` before `{{prompt}}` when prompts may start with `-`:

```yaml
# ~/.patchlab/tools/aider-prompt.yaml
name: aider
display_name: Aider
image_user: patchlab
base_image: docker.io/library/python:3.12-slim
authentication:
  method: environment_variables
  variable_names:
    - OPENAI_API_KEY
launch_command:
  - aider
  - --yes
prompt_launch_command:
  - aider
  - --yes
  - --message
  - '{{prompt}}'
```

`--passthrough` is supported by the built-in OpenCode provider only. YAML authors embed static flags in `launch_command` / `prompt_launch_command` instead.

### Plain shell (no AI tool)

If you just want an isolated sandbox with the source tree mounted and no AI tool installed, a five-field manifest gets you there:

```yaml
# ~/.patchlab/tools/shell.yaml
name: shell
display_name: Shell
image_user: patchlab
base_image: docker.io/library/debian:bookworm-slim
authentication:
  method: none
launch_command:
  - bash
```

`patchlab create --tool shell <source>` builds a Debian sandbox with the source mounted at `${image_home}/workspace` and drops you into `bash`. Session artifacts (`~/.bash_history`, `git log`) are still captured into `sessions/{n}/history/` on exit via the standard sandbox-extraction path. No conversation state to round-trip, so `extractable_artifacts` can be omitted.

## Schema reference

The full schema is documented in [`configured-tool-provider.md`](configured-tool-provider.md). The fields most relevant to authoring a new provider:

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Identifier passed to `--tool`. Lowercase letters, digits, hyphens only. |
| `display_name` | yes | Human-readable label shown in `list-tools` and errors. |
| `image_user` | yes | In-image user the tool runs as. Path-component-shaped (no `/`, no `..`). |
| `image_home` | no | Defaults to `/root` for `image_user: root`, otherwise `/home/${image_user}`. |
| `configuration_directory_name` | no | Defaults to `.<name>`. Created under `image_home` at build time. |
| `base_image` | yes | Container image tag (e.g., `docker.io/library/python:3.12-slim`). |
| `base_family` | no | `debian` (default), `alpine`, or `prebuilt`. Drives the base bootstrap block. |
| `package_manager` | no | `apt` or `apk`. Defaults from `base_family`. Drives `--capability` install. |
| `dockerfile.install` | no | Shell commands run as `RUN` lines during image build. |
| `dockerfile.environment` | no | `ENV` directives baked into the image. |
| `authentication` | yes | `none`, `environment_variables`, or `file_copy`. See below. |
| `launch_command` | yes | argv array invoked inside the container. Exec-form (no shell). |
| `prompt_launch_command` | no | argv for `patchlab create|resume -p`; at least one token must contain `{{prompt}}`. |
| `prompt_resume_launch_command` | no | argv override for `patchlab resume -p`; requires `prompt_launch_command`. |
| `validation` | no | Optional command run as a sanity check inside the built image. |
| `extractable_artifacts` | no | Files/directories to extract into the session archive on exit. |
| `overrides_builtin` | no | `true` to shadow a built-in provider with the same `name`. Default `false`. |

## Authentication strategies

### `method: none`

Tool runs without any host-side credential injection. Use this for tools that authenticate via interactive prompts or that don't need credentials.

```yaml
authentication:
  method: none
```

### `method: environment_variables`

Patchlab reads the named host environment variables and passes them to `podman create --env`. Missing variables produce a warning at sandbox-create time but don't fail the sandbox.

```yaml
authentication:
  method: environment_variables
  variable_names:
    - OPENAI_API_KEY
    - ANTHROPIC_API_KEY
```

### `method: file_copy`

Patchlab copies the named host files into the container at the declared container paths. Path expansion rules:

- Host paths: `~`, `$HOME`, and `$VARIABLE_NAME` all expand. Relative paths anchor against the manifest's directory.
- Container paths: only `~` and `$HOME` expand (to `image_home`). Plain relative paths are rejected.

```yaml
authentication:
  method: file_copy
  copies:
    - host: ~/.aider.conf.yml
      container: $HOME/.aider.conf.yml
```

Per-copy failures log a warning and continue — partial auth is more useful than no auth.

## Shadowing a registered built-in

Patchlab ships **OpenCode** as a built-in tool provider (`name: opencode`). It is the default for `patchlab create` when `--tool` is omitted. See [opencode.md](opencode.md). The registry also supports code-defined providers registered at module load (for example in downstream forks). If a built-in with the same `name` is registered, a manifest is rejected by default. To intentionally replace it with a configured provider, set `overrides_builtin: true`:

```yaml
name: my-built-in-tool
display_name: My tool (customized)
overrides_builtin: true
# ...
```

The replacement is **total**. Every `Tool_Provider` method dispatches to the synthesized implementation, including methods the manifest schema cannot fully express (e.g., `get_cached_version()` returns `null`, no version-mismatch detection against the host binary cache). You own these consequences when shadowing.

## Cache invalidation

The built image is cached at `patchlab/<base>-<name>-<hash8>:latest` (no-auth form) or `patchlab/<base>-<name>-<hash8>-auth:latest` (auth form). The `<hash8>` is an 8-character SHA-256 over the manifest fields that affect what gets baked into the image:

- `base_family`, `base_image`, `configuration_directory_name`
- `dockerfile` (entire field — both `install` and `environment`)
- `image_home`, `image_user`
- `package_manager`

Edit any of these fields and the next `patchlab create` produces a different cached-image tag, triggering a rebuild. Editing fields that don't affect the image (`name`, `display_name`, `authentication`, `launch_command`, `validation`, `extractable_artifacts`, `overrides_builtin`) does NOT invalidate the cache.

Prior-hash images stay on disk after edits — Podman doesn't garbage-collect them automatically. Use `podman image prune` to reclaim disk if you iterate frequently.

## Per-source host-path containment

Per-source manifests cannot copy files from outside the repository tree. Concretely, every `authentication.copies[*].host` path is validated against the repository root with a two-leg check at load time:

1. **Lexical containment** — after `~`/`$HOME`/`$VAR` expansion, the resolved path must lie under `<repository_root>`. Paths that escape via `..` or that resolve to an absolute location outside the repository tree are rejected. A per-source manifest CAN reference any file inside the repository, including files outside the specific subpath(s) the patchlab mounts (the trust prompt covers the repository's contents as a whole).
2. **Realpath containment** — `fs.realpathSync` is applied to both endpoints (longest existing prefix when the host path itself is missing). Symlinks inside the repository tree pointing outward, and NTFS junctions whose targets escape, are rejected by this leg.

Both legs must succeed. Case-insensitive comparison runs on Windows; case-sensitive on POSIX. Separator differences (`/` vs `\`) are normalized before comparison. **This restriction is hard policy — there is no override flag.** If a per-source manifest needs to copy from outside the repository (an SSH key, a global config), publish it as a [user-global manifest](#where-manifests-live) instead.

**Cross-machine reproducibility caveat:** if a per-source manifest uses `~` or `$HOME` in a `host` path, the resolved value depends on the current user's home directory. A teammate cloning the same repo on a different machine may see different results — `~/foo` may resolve inside the repository on one machine and outside on another. The [trust prompt](#first-encounter-trust-prompt) calls this out at confirmation time. For cross-machine reproducibility, use manifest-directory-relative paths (`./config/foo`) instead.

## First-encounter trust prompt

The first time patchlab encounters per-source manifests at `<repository_root>/.patchlab/tools/`, it prints the **trust warning** to stderr and (in interactive mode) asks for explicit confirmation before dispatching any configured tool's launch command. The marker is keyed on `realpath(repository_root)`, so one trust confirmation covers every patchlab created from the same repository — including multi-source patchlabs that mount several subpaths, and any number of separate patchlabs each mounting different subpaths of the same repo. The warning lists, per manifest:

- `launch_command` — what code runs in the container
- `base_image` — what container image is pulled
- `authentication.method` (plus post-expansion `copies[*].host` paths for `file_copy`) — what host files get read
- `dockerfile.install` package list — the RUN-as-root surface during image build

For any manifest that failed to parse or failed registration (containment violation, name collision), the warning renders the structured rejection reason so the user sees the on-disk content they're being asked to trust regardless of parse status.

On confirmation, patchlab writes a marker file under **the user's home directory**:

```
~/.patchlab/trusted-sources/<sha256(realpath(repository_root))>.json
```

The marker's `trusted_hash` field fingerprints the on-disk byte contents of every `*.yaml`/`*.yml` file directly under `<repository_root>/.patchlab/tools/`. Subsequent invocations check the marker against the current bytes and short-circuit when they match. Adding, removing, or editing any manifest changes the hash and triggers a re-prompt.

**The marker file lives outside the repository tree by design.** If it lived inside `<repository_root>/.patchlab/`, a malicious repo could commit a pre-confirmed marker with `trusted_hash` matching its own manifest and bypass the prompt entirely. Putting the marker under `~/.patchlab/` makes the trust state per-user-per-machine by construction — cloning a repo on a new machine always re-prompts.

To reset trust for a source, delete `~/.patchlab/trusted-sources/<hash>.json` (use `is_per_source_unconfirmed` semantics: missing marker means the next operation will prompt).

### Non-interactive behavior — strict by default

When stdin is not a TTY (CI, scripted shells, npm postinstall hooks, GitHub Actions, GitLab pipelines), patchlab's per-source trust check is **strict by default**: warn and abort. The abort closes a real attack vector — a malicious script that `git clone`s an arbitrary repo and runs `patchlab create` from a non-TTY context would otherwise execute the cloned repo's per-source `launch_command` silently. The strict default trades a one-time CI-config step for closing that vector.

Two flags (with matching env vars) override the default:

| Flag | Env var | Effect |
|---|---|---|
| `--strict-trust` | `PATCHLAB_STRICT_TRUST=1` | Explicit reaffirmation of the default. Semantically a no-op when set alone; declares trust posture for scripts/configs. |
| `--allow-untrusted-manifests` | `PATCHLAB_ALLOW_UNTRUSTED_MANIFESTS=1` | The explicit CI opt-in. Proceeds without prompting in non-TTY contexts. Marker is NOT written, so subsequent interactive runs still prompt. |

Both flags set at once → patchlab aborts immediately with a `Conflicting_Flags_Error` before any discovery or registration runs.

The flags have NO effect in TTY mode — interactive prompting is always the right behavior when a human can answer. The non-interactive warning ALWAYS prints, regardless of which branch resolves, so operators see exactly what would run before deciding to opt in.

### Commands that DON'T trigger the trust prompt

- `patchlab list-tools <source>` — diagnostic command. Registers per-source manifests so it can list them, but does NOT prompt. The source argument is resolved to its repository root and the scan runs against `<repository_root>/.patchlab/tools/`. Per-source entries carry an `[unconfirmed]` annotation when the marker is missing or stale, so you can examine the manifests BEFORE deciding whether to confirm.
- `patchlab inspect <patchlab>` — reports state from the patchlab manifest, doesn't run user code.
- `patchlab destroy <patchlab>` — doesn't register per-source manifests at all (it works from recorded `container_name` / `source_path` only).
- `patchlab apply <patchlab>` — pure git operation (cherry-pick / merge / squash). No `get_provider` or `get_launch_command`.

The trust gate fires only when patchlab is about to *run* user code — `create` and `resume`.

### Per-repository `default_tool` preferences (separate from manifest trust)

Repositories may set `default_tool` in `<repository_root>/.patchlab/configuration.yaml`. When that value conflicts with your user-global / built-in fallback, patchlab shows a three-way picker (repository default, your default, abort). Preferences are stored under `~/.patchlab/default-tool-preferences/`, not in the repository and not in `trusted-sources/`.

Non-interactive opt-in uses `--allow-untrusted-default-tool` / `PATCHLAB_ALLOW_UNTRUSTED_DEFAULT_TOOL=1` — separate from `--allow-untrusted-manifests`. See [configuration.md](configuration.md).

## Multi-repository patchlabs

When a patchlab spans multiple repositories (`patchlab create /repo-a/src --mount a --source /repo-b/src --mount b`), each repository is treated as a separate trust domain. The trust model extends naturally:

### Per-repository manifest discovery

Each repository's `<repository_root>/.patchlab/tools/` directory is scanned independently. The union of manifests across all repositories forms the per-source registration set.

### Per-repository trust prompts

The first-encounter trust prompt fires **once per repository that contributes at least one per-source manifest**. Prompts run sequentially in `manifest_repositories(manifest)` order (primary source's repository first, additional repositories in source-flag order). Each prompt shows ONLY the manifests from its own repository, with the same minimum-disclosure surface (launch_command, base_image, authentication, dockerfile.install).

A repository that contributes NO per-source manifests does NOT prompt — there's nothing to confirm.

Decline of ANY repository's prompt aborts the entire `patchlab create`; no branches are created in any repository. If the user confirms repository A's prompt and then declines repository B's, A's trust marker IS persisted (the confirmation was real; the next create involving A will skip A's prompt), but the patchlab itself is not created.

### Cross-repository tool-name collision rejection

If two repositories' per-source manifests declare the same `name`, registration fails with a clear error naming both repositories, the conflicting `name`, and both manifest file paths. The error suggests user-global manifests as the resolution path (user-global is not subject to per-source containment or cross-repository collision rules). Example:

```
Two repositories' per-source manifests declare the same name 'aider'.
Conflicting repositories:
  - /repo-a
  - /repo-b
Conflicting manifests:
  - /repo-a/.patchlab/tools/aider.yaml
  - /repo-b/.patchlab/tools/aider.yaml
Resolution: rename one of the conflicting manifests, OR move the shared
tool to a user-global manifest at ~/.patchlab/tools/aider.yaml (user-global
manifests are not subject to per-source containment or cross-repository
collision rules).
```

This is a security control — silently picking one repository's manifest over the other would let a hostile repository shadow a legitimate tool. The same fail-hard rule also applies INTRA-repository: two manifests in the same repository's `.patchlab/tools/` declaring the same `name` is rejected with an analogous error.

### Per-repository `file_copy.host` containment

Each manifest's `authentication.copies[*].host` paths are constrained to the manifest's OWN repository, not the patchlab's union of repositories. A manifest at `/repo-a/.patchlab/tools/foo.yaml` cannot reference `/repo-b/...` even when the patchlab also mounts `/repo-b`. The realpath leg of the containment check defends against symlinks and NTFS junctions that escape the repository tree.

For legitimate cross-repository file access, use a user-global manifest at `~/.patchlab/tools/foo.yaml` — user-global manifests are NOT subject to per-source containment.

### Per-source configuration composition lattice

When N repositories each have their own `<repository_root>/.patchlab/configuration.yaml`, the effective per-source configuration layer is the **most-restrictive** value per field across the N repositories. The lattice rules:

- A concrete numeric value (e.g., `"8g"`, `2`, `1024`) is a regular lattice element.
- The literal sentinel `"unlimited"` is the TOP of the lattice (least restrictive). Any concrete value wins over `"unlimited"`.
- `null` (field not set in this repository's config) excludes that repository from the per-field fold. Not bottom — exclusion.

Field-by-field: collect the values supplied by participating repositories; if the set is empty, the per-source layer carries no value (falls through to user-global per the existing precedence); otherwise take the lattice min.

Example: `/repo-a/.patchlab/configuration.yaml` declares `memory_limit: 8g, cpu_limit: 2`; `/repo-b/.patchlab/configuration.yaml` declares `memory_limit: 6g, cpu_limit: 4`. The composite per-source layer is `memory_limit: 6g, cpu_limit: 2` (each field's most-restrictive value, independently).

The user-global / default upper bound (from `sandbox-resource-limits`) still clamps the composite — a patchlab whose composed per-source value exceeds the upper bound is capped at the bound.

### Non-interactive trust flags apply uniformly

`--strict-trust` and `--allow-untrusted-manifests` apply to ALL repositories in a multi-repository invocation. There is no per-repository opt-out. A `--allow-untrusted-manifests` non-interactive run proceeds for every repository without prompting (and without writing any marker); a subsequent interactive run still prompts for every still-unconfirmed repository.

## Troubleshooting

### "Unknown tool '...'"

Run `patchlab list-tools`. The error message also groups available tools by source so you can see what's registered. If the configured provider you expected to register is missing:

- Verify the manifest is in `~/.config/patchlab/tools/` or `~/.patchlab/tools/` (NOT a subdirectory)
- Verify the file extension is `.yaml` or `.yml` (lowercase)
- Run `patchlab list-tools` — if the manifest is malformed it will appear as an inline warning naming the field and reason

### "Manifest name conflict"

Two manifests under the same scope declare the same `name`. The error lists both paths. Rename one or delete the duplicate.

### "Cannot install --capability [...] against provider"

The configured provider's `package_manager` is unset (typically on `base_family: prebuilt` manifests where the author didn't declare what's in the prebuilt image). Either:
- Add `package_manager: apt` (or `apk`) to the manifest
- Remove the `--capability` flag from the `patchlab create` invocation
- Swap to a different base image with a known package manager via `--base`
