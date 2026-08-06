# Language detectors

When you run `patchlab build-image` without `--base`, patchlab inspects the
project for marker files (`package.json`, `go.mod`, `pyproject.toml`, …) and
prints a **suggested** base image. The suggestion is advisory: it informs the
log line and the `--base` hint, but the image actually built comes from the
selected tool provider's `Image_Specification`. Detection never changes what
gets built — it only tells you what patchlab thinks the project is.

Eight languages are detected out of the box (Node.js, Python, Go, Rust, Ruby,
Java). Only Node.js extracts a version (the major from `engines.node`); the rest
suggest a fixed default image. To teach patchlab a new language — or to override
a built-in, or add version extraction for one of the others — drop a YAML
manifest into your home directory.

## Where manifests live

A single user-global directory is scanned at every CLI invocation:

- `~/.patchlab/languages/*.yaml` (and `*.yml`)

Files in subdirectories are not discovered. Manifests load in ascending
alphabetical filename order. There is **no trust prompt and no per-source
scope**: detection is advisory and these are your own files, so a manifest can
at most change a suggested-image string in a log line. (This is intentionally
narrower than [configuration-based tool providers](configuration-based-providers.md),
which drive container execution and therefore carry a trust gate.)

A manifest whose `marker` matches a built-in detector **replaces** that built-in
— no override flag required. Among two manifests sharing a marker, the
alphabetically-last filename wins.

## Manifest schema

```yaml
language: Go              # required: display name for the detected language
marker: go.mod            # required: bare filename whose presence triggers this detector
default_image: golang:1.22 # required: base image suggested when no version is extracted
version:                  # optional: extract a version-pinned image from the marker
  strategy: regex         # 'regex' | 'json-pointer'
  pattern: '^go (\d+)\.(\d+)'   # regex with capture groups, compiled with the multiline flag
  image_template: 'golang:{1}.{2}'  # {0} = whole match, {n} = n-th capture group
```

For `strategy: json-pointer`, add a `pointer` (an [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)
JSON pointer) and the marker is parsed as JSON; `pattern` then applies to the
value the pointer locates:

```yaml
language: Node.js
marker: package.json
default_image: node:22-slim
version:
  strategy: json-pointer
  pointer: /engines/node
  pattern: '(\d+)'
  image_template: 'node:{1}-slim'
```

### Field rules

- **Unknown fields are rejected** (at the top level and inside `version`) so a
  typo like `defaultimage` fails loudly instead of being silently ignored.
- **`marker` must be a bare filename** — a value containing `/` or `\` is rejected.
- **`pointer`** is required for `json-pointer` and forbidden for `regex`.
- **`pattern`** must be a compilable regular expression; an invalid one is
  caught when the manifest loads, not at detection time.
- A manifest that fails any rule is **skipped with a warning** — the remaining
  manifests and the built-in detectors keep working.

### Template rendering

`image_template` substitutes `{n}` with the n-th capture group of the match,
where `{0}` is the whole match. Any other character — including a `{` or `}`
that is not part of a `{<digits>}` placeholder — is copied literally; there is
no escape mechanism (image references don't use braces). If a placeholder
references a group that doesn't exist or didn't participate in the match, the
detector falls back to its `default_image` rather than emitting a malformed tag.

## Examples

Ready-to-copy manifests live in [examples/languages/](examples/languages/):

- [go.yaml](examples/languages/go.yaml) — pins `golang:<minor>` from the `go` directive in `go.mod`.
- [python.yaml](examples/languages/python.yaml) — pins `python:<minor>-slim` from `requires-python` in `pyproject.toml`.
