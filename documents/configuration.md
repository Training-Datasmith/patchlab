# Configuration

Patchlab reads optional YAML configuration files at two locations:

| Path | Scope | Trust |
| ---- | ----- | ----- |
| `~/.patchlab/configuration.yaml` | User-global — applies to every patchlab sandbox the current user creates | Read freely (you wrote it) |
| `<source>/.patchlab/configuration.yaml` | Per-source — applies to sandboxes created from this source directory | Read without a trust prompt; per-source values can only **tighten** limits, never raise them (see [Per-source clamping](#per-source-clamping)) |

Both files are optional. If neither exists, patchlab uses [runtime-computed defaults](#defaults). If `PATCHLAB_HOME` is set in your environment, patchlab reads the user-global file from `${PATCHLAB_HOME}/.patchlab/configuration.yaml` instead — primarily a testing convenience.

The v1 schema accepts these top-level keys: `resource_limits`, `default_tool`, and `tool_configuration`. Any other top-level key is rejected.

## Precedence

When resolving the effective values for a given sandbox-create or sandbox-resume invocation, patchlab merges five sources **per field**, lowest to highest:

1. **Runtime defaults** — computed from host capacity at resolve time (see [Defaults](#defaults)).
2. **User-global** — `~/.patchlab/configuration.yaml`.
3. **Per-source (clamped)** — `<source>/.patchlab/configuration.yaml`, with per-field clamping against the value resolved through layers 1 and 2.
4. **Persisted manifest** — values stored under `sessions/<n>/metadata.json` on the previous session, used by `patchlab resume` to carry create-time choices forward. **Not clamped** — a value the user explicitly chose at create time is preserved across resumes regardless of what user-global says now.
5. **CLI flags** — `--memory`, `--cpus`, `--pids-limit`, `--blkio-weight` on `patchlab create` or `patchlab resume`.

Per-field merge means setting a value at a higher precedence overrides only that one field; other fields fall through to the lower-precedence sources independently.

## `resource_limits` schema

```yaml
resource_limits:
  memory: 4g          # podman --memory format; 0 = unlimited
  cpus: 2.0           # podman --cpus format; 0 = unlimited
  pids: 1024          # non-negative integer; 0 = unlimited
  blkio_weight: 500   # integer [10, 1000]; no "unlimited" form; omit to leave the flag off
```

| Field | Accepted values | Meaning |
| ----- | --------------- | ------- |
| `memory` | Integer optionally suffixed `b` / `k` / `m` / `g` (e.g. `"4g"`, `"512m"`, `1073741824`). Bare integer `0` means **unlimited**. | Sandbox memory cap. Translates to `podman create --memory`. |
| `cpus` | Non-negative decimal (e.g. `2.0`, `1.5`). Bare integer `0` means **unlimited**. | Maximum CPU share. Translates to `podman create --cpus`. |
| `pids` | Non-negative integer up to `2^31 − 1`. Bare integer `0` means **unlimited**. Negative values (including `-1`) are rejected — the only "unlimited" sentinel is `0`. | Maximum process count. Translates to `podman create --pids-limit`. |
| `blkio_weight` | Integer in `[10, 1000]` inclusive. No `0`-as-unlimited carve-out — `blkio_weight` is a relative weight, not a cap. Omit the field to leave the flag off. | Block-I/O weight relative to other containers. Translates to `podman create --blkio-weight`. |

All four fields are optional and independently overridable. An omitted field (or one set to YAML `null`) means "fall through to the next-lower-precedence source." A `0` value (where supported) means "explicitly unlimited" and does **not** fall through.

## `default_tool`

Sets the default tool for `patchlab create` when `--tool` is omitted.

**User-global** (`~/.patchlab/configuration.yaml`):

```yaml
default_tool: opencode
```

**Per-repository** (`<repository_root>/.patchlab/configuration.yaml`):

```yaml
default_tool: team-tool
```

Resolution order: CLI `--tool` → per-repository `default_tool` (when accepted) → user-global `default_tool` → built-in `opencode`.

When a repository's `default_tool` differs from your user-global / built-in fallback, patchlab prompts interactively:

1. Use the repository's `default_tool`
2. Use your default (user-global or `opencode`)
3. Abort

Your choice is stored under `~/.patchlab/default-tool-preferences/` (outside the repository). Single-repository creates remember the choice until the repository changes `default_tool`. Multi-repository creates always prompt on conflict (stored per-repo preferences are not auto-applied).

Non-interactive: pass explicit `--tool` or `--allow-untrusted-default-tool` (`PATCHLAB_ALLOW_UNTRUSTED_DEFAULT_TOOL=1`). The opt-in applies the repository value for one invocation without writing a preference.

When multiple repositories set different `default_tool` values, `patchlab create` fails before prompting — align configs or pass `--tool`.

## `tool_configuration` schema

User-global only. Per-tool settings keyed by tool name. Per-source `tool_configuration` is parsed but **ignored** (verbose log).

### OpenCode (`tool_configuration.opencode`)

See [opencode.md](opencode.md) for behavior details.

```yaml
tool_configuration:
  opencode:
    copy_host_configuration: true    # copy ~/.config/opencode into the sandbox (default true)
    copy_host_auth: true      # copy auth.json (default true)
    proxy_local_models: true  # host-side TCP proxy for loopback model URLs (default true)
    environment:              # extra container env; host env wins on conflict
      SOME_FLAG: "1"
```

All OpenCode fields are optional. Omitted booleans default to `true`; `environment` defaults to empty.

## Defaults

When no source sets a field, patchlab computes a default from host capacity at resolve time (so a configuration file you write today still does the right thing tomorrow on a different host):

- **memory**: `max(1 GiB, floor_to_256_MiB(0.75 × total_RAM))`. Examples: 16 GiB host → 12 GiB cap, 8 GiB host → 6 GiB cap, 1 GiB host → 1 GiB cap (floor).
- **cpus**: `max(1, cpu_count − 1)` as a decimal string. Reserves one core for the host.
- **pids**: fixed `1024`.
- **blkio_weight**: no default — when no source sets a value at any precedence, patchlab omits the flag from `podman create` entirely.

## Per-source clamping

Per-source `<source>/.patchlab/configuration.yaml` is read freely (no trust prompt) but **clamped** at merge time so a per-source value can only tighten limits relative to the upper bound established by the user-global / runtime-default layers. The clamp is per field:

- `memory`, `cpus`, `pids`: effective value is `min(per_source_value, upper_bound)`. A per-source `0` (unlimited) is treated as "no per-source preference" and does **not** widen the upper bound — it falls through to whatever the upper bound resolves to.
- `blkio_weight`: per-source values are **ignored** entirely. The field is a relative weight, not a cap; "tightening" isn't a meaningful operation. Set `blkio_weight` in the user-global file or via the CLI flag instead.

A per-source value that would tighten an unlimited user-global ceiling to a finite value is **allowed** — that's exactly the intended use of per-source against an unbounded layer.

**Why no trust prompt:** the clamp gives us the invariant a trust prompt would protect (a per-source file cannot raise limits above what you've already authorized in the user-global file). Adding a prompt would be friction for no extra safety. The configured-provider tool-manifest trust prompt at `<source>/.patchlab/tools/*.yaml` remains right for *its* domain because tool manifests describe arbitrary container images and binaries — those genuinely need user authorization. Resource limits don't.

Clamp events (clamped values, discarded per-source `0`, ignored per-source `blkio_weight`) are recorded via `logger().verbose(...)`. Set `PATCHLAB_VERBOSE=1` or pass `--verbose` on the command to see them on stderr; without verbose mode the clamp still applies, silently.

## Resume preserves create-time choices

When you `patchlab resume <id>`, the resolver reads the previous session's resolved values from `~/.patchlab/<id>/sessions/<n>/metadata.json` and applies them at the **persisted-manifest** layer (above user-global and per-source, below CLI flags). This means:

- A sandbox created today with `--memory 14g` will still use `14g` on resume tomorrow, even if you've since added `~/.patchlab/configuration.yaml` with `memory: 4g`.
- The persisted manifest is **not clamped** against the current user-global — a value the user explicitly chose at create time is preserved across resumes.
- To change a persisted choice on resume, pass an explicit CLI flag: `patchlab resume <id> --memory 4g`.

## Failure modes

The loader fails loudly with an error naming the file path and the offending field when any of the following occur:

- The file exists but cannot be parsed as YAML (syntax error, non-string keys, any error reported by the YAML parser, including YAML alias syntax — aliases are disabled to avoid billion-laughs-style DoS).
- The file exceeds 64 KiB. The v1 schema fits in well under 1 KiB; this cap exists to defeat `/dev/zero`-style symlinks and oversized blobs.
- The top-level value of `resource_limits` is not a map.
- An unknown key appears at the top level (only `resource_limits`, `default_tool`, and `tool_configuration` are accepted).
- An unknown key appears under `resource_limits` (only the four documented fields are accepted; typos like `memmory` are caught).
- Any numeric value is negative — including `pids: -1`.
- `blkio_weight` is outside the inclusive range `[10, 1000]`.
- `pids` is greater than `2^31 − 1`.

Parse-time errors **abort loading without partial application** — none of the file's values take effect when any value is invalid. A file that exists and parses cleanly but contains no `resource_limits` key is **not** an error; it is treated as "no settings here, fall through to defaults."

A symbolic link whose target is a regular file is followed. A symlink to a directory, a broken symlink, or any other non-regular-file target is treated the same as the file being absent (no error, no values loaded).

## cgroup delegation

Rootless Podman applies per-container resource limits (`--memory`, `--cpus`, `--pids-limit`, `--blkio-weight`) by writing into the user-owned cgroup v2 hierarchy. On Linux hosts where systemd's default user-unit configuration does **not** delegate the `memory` and `cpu` controllers to user sessions, patchlab cannot enforce the limits even though the container was created with the flags.

Patchlab probes for this configuration on the first `patchlab create` (or `patchlab resume`) in each process. When the probe reports the host as unsupported, patchlab emits a one-time stderr warning and continues; sandbox creation never fails over the probe alone.

### Symptom

```
warning: this host's rootless Podman cannot enforce memory or CPU limits
  on patchlab sandboxes. A runaway tool inside a sandbox can still consume
  all host resources. To enable enforcement, see:
    https://github.com/Training-Datasmith/patchlab/blob/main/documents/configuration.md#cgroup-delegation
  (Sandbox creation will continue with limits set but unenforced.)
```

### Fix on Linux (systemd, common case)

Most modern Linux distributions ship without `memory` and `cpu` delegated to user sessions out of the box. The fix is a drop-in systemd configuration file that tells the user manager to delegate those controllers:

```bash
sudo mkdir -p /etc/systemd/system/user@.service.d/
sudo tee /etc/systemd/system/user@.service.d/delegate.conf <<'EOF'
[Service]
Delegate=memory pids cpu io
EOF
sudo systemctl daemon-reload
```

Then log out and log back in (or reboot) so your user session picks up the new delegation. Run `cat /sys/fs/cgroup/$(awk -F: '$1=="0"{print $3}' /proc/self/cgroup)/cgroup.controllers` — if the output includes `memory` and `cpu`, you're done.

#### Distro-specific notes

- **Fedora / RHEL 9+ / Rocky 9+ / Alma 9+** — ship with cgroup v2 enabled and the systemd `user@.service` unit ready to accept the drop-in above. No additional steps.
- **Debian 12 / Ubuntu 22.04 LTS+** — cgroup v2 is default; the systemd drop-in is the only change needed.
- **Ubuntu 20.04 LTS and earlier** — boot may still default to cgroup v1. Add `systemd.unified_cgroup_hierarchy=1` to the kernel command line (`/etc/default/grub` → `GRUB_CMDLINE_LINUX_DEFAULT`) and run `sudo update-grub`, then reboot. Apply the systemd drop-in after the reboot.
- **Arch / openSUSE Tumbleweed** — cgroup v2 is default; the systemd drop-in suffices.

### macOS and Windows

Patchlab on macOS and Windows runs inside a Podman machine VM that ships with cgroup v2 controllers available. **No special configuration is required.** The cgroup probe short-circuits to "supported" on non-Linux platforms; the warning above never fires on macOS or Windows hosts.

### What if I can't change system configuration?

Resource limits are a host-protection feature, not a correctness requirement. Patchlab continues to create sandboxes on hosts without delegation — they just don't enforce the limits at the kernel level. If you can't change system configuration (locked-down corporate machine, CI runner without root, etc.), patchlab still works; you simply lose the runaway-protection guarantee.
