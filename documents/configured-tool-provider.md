# Configured tool providers (manifest format)

> **Status — implemented.** This document describes the manifest schema that
> configured tool providers use at runtime (image build, authentication
> injection, launch). For the end-user authoring guide — quick start, trust
> prompts, security — see
> [`configuration-based-providers.md`](configuration-based-providers.md).

## Where manifests live

Two discovery scopes:

- **User-global**: every `*.yaml` and `*.yml` file directly under
  `~/.config/patchlab/tools/` (XDG-compliant) or `~/.patchlab/tools/`
  (legacy fallback). Applies to every patchlab on the user's machine.
- **Per-source**: every `*.yaml` and `*.yml` file directly under
  `<repository_root>/.patchlab/tools/`. Applies to patchlabs created from
  this repository (including multi-source patchlabs that mount subpaths of
  the same repository).

Files in subdirectories under either scope are NOT discovered. The extension
match is exact-lowercase: `.YAML`, `.YML`, `.yaml.bak`, `.yaml~`, `.swp`,
`.swo` are all skipped.

Within a single scope, two manifests declaring the same `name` is an error
that names both manifest paths. A name appearing in both scopes is fine at
the discovery layer; cross-scope precedence is the registry's job (specified
elsewhere).

## Schema

```yaml
name: <string, kebab-case>                       # required
display_name: <string>                           # required
image_user: <string>                             # required, single path component
image_home: <absolute-path>                      # optional; default per image_user
configuration_directory_name: <string>           # optional, default ".<name>"
base_image: <string>                             # required, container image tag
base_family: debian | alpine | prebuilt          # optional, default "debian"
package_manager: apt | apk                       # optional, default from base_family

dockerfile:                                      # optional
  install: [<string>, ...]                       # shell commands run during image build
  environment: { <string>: <string>, ... }       # ENV directives (NOT expanded by patchlab)

authentication:                                  # required
  method: none | environment_variables | file_copy
  variable_names: [<string>, ...]                # required when method=environment_variables
  copies:                                        # required when method=file_copy
    - host: <path>
      container: <path>

launch_command: [<string>, ...]                  # required, argv to launch the tool

validation:                                      # optional
  command: [<string>, ...]                       # argv that exits 0 when the image is valid

extractable_artifacts:                           # optional, default empty
  - name: <string>
    container_path: <path>
    type: file | directory
    archive_subpath: <string>
    required_for_resume: <boolean>

overrides_builtin: <boolean>                     # optional, default false
```

Unknown top-level fields are rejected at parse time.

## Field constraints (the short version)

| Field | Constraint |
|---|---|
| `name` | matches `^[a-z0-9-]+$` |
| `display_name` | non-empty after trimming |
| `image_user` | single path component (no separators, no `..`, no leading `/`, no null bytes) |
| `image_home` | absolute Linux path (starts with `/`); defaults to `/root` for `image_user: root`, otherwise `/home/${image_user}` |
| `configuration_directory_name` | single path component (same rules as `image_user`); defaults to `.<name>` |
| `base_image` | non-empty after trimming |
| `base_family` | exactly `'debian'`, `'alpine'`, or `'prebuilt'`; defaults to `'debian'`. Drives the base-image bootstrap block: `debian` emits `apt-get install git` + `useradd`; `alpine` emits `apk add --no-cache git` + `adduser`; `prebuilt` emits nothing (use when the base image ships git + the declared `image_user` at UID 1000 already, e.g. Google's gemini-cli sandbox). For `image_user: root` on `debian`/`alpine`, the `useradd`/`adduser` directive is skipped (root already exists). |
| `package_manager` | exactly `'apt'` or `'apk'`; defaults to `'apt'` for `base_family: debian`, `'apk'` for `alpine`, unset for `prebuilt`. Drives the `biz.ecartz.patchlab.package_manager` LABEL and the `--capability` install pipeline. When `prebuilt` AND unset AND `--capability` is requested, the build errors loudly. `'dnf'` and `'unknown'` are deferred pending `src/capabilities.ts` support. |
| `dockerfile.install` | list of non-empty strings (empty list OK) |
| `dockerfile.environment` | keys non-empty, no `=`, no null bytes; values can be any string (including empty) |
| `authentication.variable_names` | non-empty list when `method: environment_variables` |
| `authentication.copies` | non-empty list of `{ host, container }` when `method: file_copy` |
| `launch_command` | non-empty list of strings |
| `validation.command` | non-empty list of strings (when `validation` is set) |
| `extractable_artifacts[*].name` | non-empty, no leading/trailing whitespace, no control chars; unique across the array (case-sensitive) |
| `extractable_artifacts[*].type` | exactly `'file'` or `'directory'` |
| `extractable_artifacts[*].required_for_resume` | real YAML boolean (not `"true"` / `1` / `"yes"`) |
| `extractable_artifacts[*].archive_subpath` | host-boundary single-component rules; unique across the array (case-insensitive) |
| `extractable_artifacts[*].container_path` | absolute or `$HOME`-relative (resolves to absolute) |
| `overrides_builtin` | real YAML boolean |

## Path expansion

Two contexts with different rules. Conflating them — e.g., expanding `$HOME`
to the host's home in a path that targets the container — produces broken
`podman cp` arguments and is what these distinct rules avoid.

### Host paths (`authentication.copies[*].host`)

Resolved against the host filesystem:

- `~`, `~/...` → `os.homedir()` (leading position only)
- `$HOME` → `os.homedir()` (leading position only)
- `$VARIABLE_NAME` → `process.env[VARIABLE_NAME]` (anywhere in the path,
  multiple supported, undefined fails, empty-string expands to `""`)
- Absolute paths (POSIX `/...` and Windows `C:\...` / `C:/...`) → passed
  through unchanged
- Plain relative paths → resolved against the manifest file's own directory

`~user` (other-user home expansion) is rejected.

### Container paths (`authentication.copies[*].container`, `extractable_artifacts[*].container_path`)

Resolved against the container's `manifest.image_home`:

- `~`, `~/...`, `$HOME` → `manifest.image_home`
- Absolute paths starting with `/` → passed through
- Other `$VAR` references → REJECTED (the container does not exist at parse
  time; its env vars are not resolvable)
- Plain relative paths → REJECTED (no stable container-side anchor)

### Fields NOT expanded

- `display_name`, `name`, `launch_command` tokens, `validation.command`
  tokens — passed through verbatim.
- `dockerfile.install` shell commands — passed through; Docker's build-time
  shell runs the string with `/bin/sh -c`.
- `dockerfile.environment` values — passed through; Docker's build-time
  `ENV`/`ARG` interpolation handles `$VAR` references against the running
  build context. Patchlab parser-side expansion would conflict.

## Authentication strategies

### `method: none`

No authentication. The tool runs in the container without any
patchlab-injected credentials.

```yaml
authentication:
  method: none
```

### `method: environment_variables`

Reads named variables from the host's environment and passes them into the
container at create time. Multiple variables supported.

```yaml
authentication:
  method: environment_variables
  variable_names: [OPENAI_API_KEY, GITHUB_TOKEN]
```

A variable that is unset on the host produces a warning and is excluded from
the entries; a variable set to the empty string is passed through as `""`.

### `method: file_copy`

Copies static files from the host into the container after creation.

```yaml
authentication:
  method: file_copy
  copies:
    - host: ~/.aider/config.yml
      container: $HOME/.aider/config.yml
```

Per-source manifests are constrained at runtime: `host` paths must lie within
the source tree (defense against a malicious checked-in manifest exfiltrating
files outside the repo). User-global manifests have no such restriction.

## Examples

### Minimal env-var manifest

```yaml
name: aider
display_name: Aider
image_user: patchlab
base_image: ghcr.io/patchlab/aider:latest
authentication:
  method: environment_variables
  variable_names: [OPENAI_API_KEY]
launch_command: [aider]
```

### File-copy with extractable artifacts

```yaml
name: my-tool
display_name: My Tool
image_user: patchlab
base_image: ghcr.io/me/my-tool:latest
authentication:
  method: file_copy
  copies:
    - host: ~/.my-tool/config.yml
      container: $HOME/.my-tool/config.yml
launch_command: [my-tool, --interactive]
extractable_artifacts:
  - name: chat-history
    container_path: $HOME/.my-tool/chats
    type: directory
    archive_subpath: chats
    required_for_resume: true
```

### `method: none` with custom Dockerfile

```yaml
name: custom-shell
display_name: Custom Shell
image_user: developer
base_image: debian:stable-slim
dockerfile:
  install:
    - apt-get update && apt-get install -y vim curl
  environment:
    HISTFILE: /workspace/.bash_history
authentication:
  method: none
launch_command: [bash, -i]
```

## Standardized warning format

Configured-provider operations emit warnings using a uniform template:

```
Warning: <operation> for <provider-name>: <action> <target>: <reason>
```

Examples:
- `Warning: parse_manifest for aider: rejected manifest at /home/user/.patchlab/tools/aider.yaml: missing required field 'launch_command'`
- `Warning: inject_authentication for aider: omitted 'OPENAI_API_KEY': variable not set in host environment`
- `Warning: inject_session_state for aider: skipped 'messages' artifact: escape-symlink found at messages/notes.txt → ../../../etc/passwd`

The format is parseable: split on `:` to recover operation/provider/action,
or pattern-match against the literal `Warning: ` prefix and the two anchoring
colons.
