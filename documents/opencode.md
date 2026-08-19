# OpenCode in Patchlab

Patchlab ships [OpenCode](https://opencode.ai/) as the built-in default tool. `patchlab create .` launches OpenCode in the sandbox without passing `--tool`.

## Configuration sources

OpenCode settings come from two places:

1. **Your host OpenCode files** (default on)
   - `~/.config/opencode/` — config, agents, plugins (`opencode.json`, `tui.json`, …)
   - `~/.local/share/opencode/auth.json` — provider credentials from `opencode auth login`

   XDG paths are honored when `XDG_CONFIG_HOME` / `XDG_DATA_HOME` are set.

2. **`~/.patchlab/configuration.yaml`** (user-global overrides)

```yaml
default_tool: opencode

tool_configuration:
  opencode:
    copy_host_configuration: true
    copy_host_auth: true
    proxy_local_models: true
    environment:
      SOME_FLAG: "1"
```

Patchlab copies host config into the sandbox before launch and rewrites loopback model URLs (see below). Host API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENCODE_*`, …) are injected when set on the host.

When `copy_host_auth` is enabled (default), Patchlab also stages a copy of `auth.json` under the patchlab archive at `~/.patchlab/<id>/opencode-staging/` with restrictive permissions (`0700` directories, `0600` files). That copy persists for the lifetime of the sandbox so `patchlab resume` can re-inject current credentials into the container. **`patchlab destroy <id>`** removes the archive (and staged auth) when branch cleanup succeeds.

## Interactive launch and passthrough

Forward OpenCode CLI flags on any create/resume that launches the tool:

```bash
# TUI with a default model
patchlab create . --passthrough=--model --passthrough anthropic/claude-sonnet

# JSON output from a one-shot prompt
patchlab create . -p "Summarize README.md" \
  --passthrough=--format --passthrough json \
  --prompt-file ./README.md
```

Use `--passthrough=--flag` when the token starts with `-` (Commander otherwise treats it as another patchlab flag). `--passthrough` with `--no-interactive` (and no `-p`) is rejected — omit `--no-interactive` or use `-p`.

`--prompt-file` stages files into `$HOME/context/` (same machinery as `--context`) and passes container paths to `opencode run --file`. It requires `-p`.

## One-shot prompts

Run a single prompt without launching the TUI:

```bash
patchlab create . -p "Add unit tests for utils.ts"
patchlab create . -p          # read prompt from stdin (place -p last, or before other flags)
patchlab resume <id> -p "Fix the failing test"
patchlab resume <id> -p -     # explicit stdin sentinel
```

For prompts that start with `-`, use equals form: `--prompt=-fix this`.

Patchlab invokes `opencode run --auto` inside the sandbox (with `--continue` on resume). OpenCode `--auto` approves permissions that are not explicitly denied in your OpenCode config. The response is printed to stdout; patchlab status messages go to stderr. After the session is extracted, patchlab propagates OpenCode's exit code.

When the first pass produces no assistant text (for example, the model spends the turn on tools only), patchlab automatically runs a synthesis `--continue` prompt so you still get a written answer without manual follow-up.

`--prompt` cannot be combined with `--no-interactive`. Custom YAML providers opt in by declaring `prompt_launch_command` in the manifest (see [configured-tool-provider.md](configured-tool-provider.md)). A YAML provider that replaces the built-in with `name: opencode` and `overrides_builtin: true` does not inherit the built-in's prompt argv or `--passthrough` unless it declares `prompt_launch_command` itself.

## Local models (Ollama, LM Studio, …)

Models bound to `127.0.0.1` on the host are not reachable from inside the container as `localhost`. When `opencode.proxy_local_models` is true (default), Patchlab:

1. Starts a detached host-side TCP proxy for each loopback port found in your OpenCode config
2. Adds `host.patchlab.internal` to the container (`--add-host`)
3. Rewrites `http://localhost:PORT` (and `127.0.0.1` / `[::1]`) in copied config to `http://host.patchlab.internal:<listen-port>`

Patchlab sets container `HOME` and `USER` to the provider image home (e.g. `/home/patchlab`) at sandbox create/resume so OpenCode reads copied config under `~/.config/opencode/` rather than the base image's default home (e.g. `/home/node` on `node:22-slim`).

The proxy keeps running after `patchlab create` exits (the sandbox container stays up). **`patchlab destroy <id>`** stops the proxy.

To disable the proxy (model must listen beyond loopback, e.g. `OLLAMA_HOST=0.0.0.0:11434`):

```yaml
tool_configuration:
  opencode:
    proxy_local_models: false
```

## Session resume

OpenCode project data under `~/.local/share/opencode/project/` inside the container is extracted on exit and restored on `patchlab resume`.

## Overriding the built-in

Register a YAML provider with `name: opencode` and `overrides_builtin: true` to replace the built-in (see [configuration-based-providers.md](configuration-based-providers.md)).
