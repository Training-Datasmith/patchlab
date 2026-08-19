# Testing strategy

Patchlab's test suite is partitioned into five [Vitest](https://vitest.dev) projects, each with a different cost profile. Choosing the right project for a new test matters because the project's cost is paid by every test it contains — a unit test that has been miscategorized as integration silently taxes every CI run with podman serialization for no podman-coverage upside.

| Project | Location | Parallelism | Setup cost per file | Typical contents |
| ------- | -------- | ----------- | ------------------- | ---------------- |
| `unit` | `test/unit/**/*.test.ts` | Full file-level parallelism | Negligible | Host-side filesystem, validators, manifest field shapes, returned-string contracts, pure functions |
| `integration` | `test/integration/**/*.test.ts` (excluding `podman/` and `nerdctl/`) | **Sequential** (`fileParallelism: false`) | One shared container runtime per worker via [`test/integration/set-up-podman.ts`](../test/integration/set-up-podman.ts) | Container lifecycle, image-label round-trips, built-in OpenCode (`opencode/`), CLI subprocess tests |
| `integration-podman` | `test/integration/podman/**/*.test.ts` | Sequential | Same setup as `integration` | Host-native podman socket mount, in-sandbox podman exec |
| `integration-nerdctl` | `test/integration/nerdctl/**/*.test.ts` | Sequential | Same setup as `integration` | Lima/nerdctl commit rebuild, workspace ownership after nerdctl cp |
| `posix` | `test/posix/**/*.test.ts` | File-level parallelism; runs inside a Linux container on Windows and macOS hosts | Linux container startup | Fifo/socket types, case-sensitive `.YAML` vs `.yaml`, unprivileged symlinks, executable mode bits surviving `tar` round-trip |
| `windows` | `test/windows/**/*.test.ts` | File-level parallelism; native on Windows only (`npm test` omits this project on macOS) | Native on Windows | NTFS junctions, drive-letter handling, separator-mixing on Windows-shaped paths |
| `macos` | `test/macos/**/*.test.ts` | File-level parallelism; native on macOS only (`npm test` omits this project on Windows) | Native on macOS | APFS case-insensitivity with production-default path comparison |

[`scripts/run-tests.mjs`](../scripts/run-tests.mjs) selects projects by host OS and probes container runtimes via [`scripts/container-runtime-probe.mjs`](../scripts/container-runtime-probe.mjs). Linux runs unit, posix, and platform-gated projects natively; macOS runs unit + macos; Windows runs unit + windows; posix runs in a Linux container on macOS/Windows. Integration runs only when a runtime responds to `--version`: runtime-agnostic tests use nerdctl when available on macOS, otherwise podman; `integration-podman` runs when podman is available; `integration-nerdctl` runs when nerdctl is available on macOS. CI also runs a dedicated `test-macos-nerdctl` job on `macos-latest` (Lima + nerdctl) so the `macos` project and nerdctl integration suite execute on a real APFS host. Platform projects still self-gate when invoked directly (e.g. Linux CI runs both with `--project windows --project macos` and they no-op via `describe.runIf`).

### Podman vs nerdctl integration coverage

| Area | `test/integration/podman/` | `test/integration/nerdctl/` | Runtime-agnostic `test/integration/` |
| ---- | -------------------------- | ----------------------------- | -------------------------------------- |
| In-sandbox nested podman via host socket | `sandbox-podman.test.ts` | *(no equivalent — Lima/containerd differs)* | — |
| Detect → auto socket mount pipeline | `detect-socket-provisioning.test.ts` (podman socket path) | — | — |
| `commit_container` label round-trip | via podman `-c LABEL` in `image-lifecycle.test.ts` | `runtime-commit-labels.test.ts` (rebuild path) | `image-lifecycle.test.ts` |
| Host→container workspace copy + git | — | `runtime-workspace-git.test.ts` (ownership repair) | `sandbox.test.ts`, `copy_paths.test.ts` |
| Built-in OpenCode image + sandbox | — | — | `opencode/opencode.test.ts` |

Add nerdctl-only tests under `test/integration/nerdctl/` when the assertion depends on Lima-visible paths, nerdctl cp staging, or the commit rebuild path. Add podman-only tests under `test/integration/podman/` for host-socket and in-container podman behavior.

The integration suite's sequential-files constraint exists because `create_sandbox`, `destroy_sandbox`, and `commit_session_to_branch` all talk to the same podman daemon — concurrent file execution would race on container names and image layers. The constraint is correct for files that genuinely depend on podman state. It is wasteful for files that don't.

## Choosing a project for a new test

Decide by what your test's PRODUCER→ASSERTION chain actually touches, not by what feels familiar from a neighbor test.

- A test belongs in `test/unit/` if its assertion is on host-side filesystem state, returned string values, pure validation throws, manifest field shapes, or any function whose subject never crosses the host↔container boundary.
- A test belongs in `test/integration/` if its assertion depends on real podman behavior:
    - In-container filesystem state (a file the sandbox process created).
    - Container lifecycle transitions (`create_sandbox`, `destroy_sandbox`, `resume_sandbox`, `garbage_collect_sandboxes`).
    - Image label round-trips (`build_image` writes a label; `podman image inspect` reads it back).
    - Byte-level traffic over the podman exec pipe (binary diffs ≥ 1 MB, UTF-8 multi-byte, executable mode bits surviving `git archive | tar -x`).
    - CLI subprocess tests that spawn `dist/cli.js` for any subcommand other than `apply` or `--help` — these hit the `preAction → ensure_podman(prompter)` gate at [src/cli.ts:497](../src/cli.ts#L497) and cannot reach the assertion without a working podman runtime.
- A test belongs in `test/posix/` if its assertion depends on POSIX-only filesystem semantics that Windows hosts cannot reproduce.
- A test belongs in `test/windows/` if its assertion depends on Windows-only filesystem semantics. The test must self-gate with `describe.runIf(process.platform === 'win32')` so direct invocations on Linux/macOS are a no-op ( `npm test` on macOS does not include this project).
- A test belongs in `test/macos/` if its assertion depends on macOS-only filesystem semantics (APFS case-insensitivity with production-default path flags). The test must self-gate with `describe.runIf(process.platform === 'darwin')` so direct invocations on Linux/Windows are a no-op (`npm test` on Windows does not include this project).

#### Prompt-driven library functions

Library functions that accept `Prompter | null` (the seam created by [src/prompts.ts](../src/prompts.ts) — `resolve_socket_mount`, `prompt_service_selection`, `ensure_podman`, `confirm_per_source_manifests`, `create_sandbox_with_prompts`) belong in `test/unit/`. Pass a `Fake_Prompter` from [test/helpers/fake_prompter.ts](../test/helpers/fake_prompter.ts) (queue or function mode) — DO NOT mock `node:readline`. The fake's exhaustion throw (`Prompter_Exhausted`) is the signal that a test's expected prompt count drifted; let it propagate. `null` is the explicit non-interactive value and exercises the policy's safe-default branch. The structural lock that keeps this clean is [test/unit/invariants/readline-import.test.ts](../test/unit/invariants/readline-import.test.ts), which asserts only `src/cli_prompter.ts` imports `node:readline`.

### Producer-side rule

A test whose ASSERTION is host-side BUT whose PRODUCER step crosses the host↔container boundary belongs in `test/integration/`, not unit. The host-side shape of the assertion is a downstream artifact of the producer's correctness; moving the assertion-side to unit removes the producer and the test has nothing to inspect.

**Canonical example.** [test/integration/podman/sandbox-podman.test.ts:111-129](../test/integration/podman/sandbox-podman.test.ts#L111) reads the `biz.ecartz.patchlab.capabilities` label off a host image:

```ts
it('image has capabilities label with expected value', () => {
    const caps = get_image_capabilities(TEST_TAG);
    expect(caps).toContain('podman');
});
```

The assertion looks host-side — it's a string equality. But `TEST_TAG` is BUILT by `build_image()` in the file's `beforeAll` at [test/integration/podman/sandbox-podman.test.ts:18-22](../test/integration/podman/sandbox-podman.test.ts#L18):

```ts
beforeAll(async () => {
    if (!image_exists(TEST_TAG)) {
        await build_image({ tag: TEST_TAG, capabilities: ['podman'], labels: [TEST_LABEL] });
    }
}, 600_000);
```

The label round-trip (`build_image → podman inspect`) IS what the test verifies. Moving it to unit would remove `build_image()` from the chain — the test would have no image to inspect. The host-side logic function (`check_stale_image`) without its podman-side producer DOES live in [test/unit/stale.test.ts](../test/unit/stale.test.ts), with an explicit file-level comment carving the split: "Here we test the logic functions that don't need podman." Both placements are correct.

### Subject crosses the boundary at the byte level

Some tests look like "host-side, sandbox is fixture" but actually encode bugs in the podman exec stdio pipe itself. UTF-8 round-trip, 5 MB binary streaming, executable mode bits surviving extraction — these classes of regression live in the podman stdio path, not in any host-side function. A host-side substitute would not catch them. They belong in `test/integration/`.

### Command construction is verified by integration, not by mocked argv shape

`test/unit/` and `test/posix/` mock `exec_container` / `copy_to_container` (see [test/unit/sandbox/workspace-staging.test.ts](../test/unit/sandbox/workspace-staging.test.ts)). A mocked test can assert the **argv your code builds** — but never how `podman exec` actually **runs** it. Anything whose correctness is a podman-runtime behavior (working directory, chdir-before-exec, signal delivery, label encoding on `commit --change`) is invisible to the mocked tiers and MUST be validated by `test/integration/`.

**Cautionary example (a real regression).** `prepare_workspace` was once rewritten to wipe the workspace as two execs — `['rm','-rf',dir]` then `['mkdir','-p',dir]`. The unit and posix assertions (argv shape) and `npm run build` all passed. It failed only under integration: `podman exec` chdir's into the container `WORKDIR` (= that very directory) *before* running each command, so the second exec could not enter the directory the first had just deleted (`crun: chdir ... No such file or directory`), and every dependent integration test failed in `beforeAll`. The fix kept it a SINGLE `sh -c` (one chdir, while the dir still exists) with the path passed as a positional `$1` argument — injection-safe AND correct. The lesson: **a change to how container commands are constructed is not validated until the integration tier runs**, regardless of how green the mocked tiers are.

## Within an integration file: shared sandbox vs per-test

`create_sandbox` costs ~5–15 seconds wall-clock per invocation depending on host. When two tests in the same integration file both inspect a sandbox without mutating its baseline (or mutate disjoint resources whose interaction is independent), they should share one `beforeAll` sandbox rather than each provisioning a fresh one. When they MUST each provision a fresh one, the file should say why.

| Pattern | When | Example |
| ------- | ---- | ------- |
| Shared `beforeAll` sandbox, read-only siblings | All tests in the describe block only READ from the sandbox (`exec_container(name, ['cat', ...])`, `inspect_sandbox(id)`) | Multiple `inspect_sandbox` probes on a default-config sandbox |
| Shared `beforeAll` sandbox + `afterEach` revert | Tests mutate DISJOINT paths and each mutation can be reverted | [test/integration/changes.test.ts](../test/integration/changes.test.ts) tests 1–4 each touch `a.txt`/`b.txt`/`c.txt` — `afterEach` runs `git checkout -- a.txt b.txt && rm -f c.txt` |
| Per-test sandbox, documented | Test asserts a lifecycle transition (`create_sandbox`, `destroy_sandbox`, `resume_sandbox` IS the subject); test mutates baseline in a way no `afterEach` can revert; test commits to HEAD or otherwise pollutes shared state | Single-purpose lifecycle tests; `changes.test.ts` test 6 (commits `.gitignore` into HEAD) |
| Image build, file-level `beforeAll` | The file requires a custom-built test image | [test/integration/podman/sandbox-podman.test.ts:18-22](../test/integration/podman/sandbox-podman.test.ts#L18) builds `patchlab/sandbox-podman-test:latest` once; `afterAll` calls `remove_test_images()` |

When you use a shared `beforeAll` sandbox, add a comment above it documenting (a) which files each downstream test mutates, (b) what the `afterEach` reverts, and (c) why any sibling test that sits in its own describe block needs its own sandbox. The comment lets the next person adding a test see the shared-state contract without re-deriving it.

### Overlapping mutations need their own sandbox

If a candidate shared-`beforeAll` describe block has a test whose mutation OVERLAPS with another test's mutation on the same path (both write to `a.txt`), OR commits new files into git history (changes `HEAD`), OR adds and commits a `.gitignore` whose effect persists across siblings, the test cannot join the shared block. Two options:

1. **Its own describe block with its own dedicated sandbox.** Correct when a sibling test asserts on the un-mutated baseline that the overlapping test would disturb.
2. **Last test in the shared describe, NO `afterEach` cleanup.** Correct when no cleanup is sound (the mutation can't be reverted) AND no downstream test would reference the polluted state.

Canonical example: [test/integration/changes.test.ts](../test/integration/changes.test.ts) test 5 (`detects multiple change types simultaneously`) mutates `a.txt`, deletes `b.txt`, and adds `c.txt` — overlaps with tests 1, 2, 3 on those exact paths. It belongs in its own describe block. Test 6 (`respects .gitignore in change detection`) commits a `.gitignore` into HEAD — that mutates the baseline that tests 1–4 reset against. It also belongs in its own describe block, OR runs last with no cleanup.

### Documenting per-test freshness

The natural tendency is to default to fresh-per-test setup. When fresh state is genuinely required, document why above the `beforeEach` (or above the file-level describe). The justification should name the specific transition or invariant that prevents sharing — e.g. "destroy is the subject; needs a dedicated sandbox to kill" or "each test commits a different per-tool label; sharing would compose the labels." The intent is to make "I need a fresh sandbox per test" a stated decision rather than a default that was never reconsidered.

## Before moving a test, reconcile against existing coverage

When you identify a test as belonging in a different project (typically an integration test that should be a unit test), check whether the destination project already covers the same contract before moving. If it does, DELETE the misplaced test — don't translate it into a duplicate. The existing coverage is the artifact; a duplicate test adds maintenance load with no coverage gain.

The reconcile step is one `grep` away. If you're moving an `apply_patch` test, grep `test/unit/` for `apply_patch`; if you're moving a `resolve_source_inputs` test, grep for that. Read the matching tests carefully — the existing coverage may be more comprehensive than the integration test you'd be moving.

**Examples of the discipline working.** A 2026-06 audit (see [reports/integration-test-audit.md](../reports/integration-test-audit.md)) initially flagged three integration tests as A-move candidates that on closer inspection were already covered at the unit level:

| Integration test | Already covered at | Outcome |
| ---------------- | ------------------ | ------- |
| `multi-source.test.ts` — `rejects multi-repo create without --mount` | [test/unit/sources.test.ts:87](../test/unit/sources.test.ts#L87) with 21 sibling cases (nested-prefix overlap, same-prefix, mount-name collision, case-only overlap, etc.) | Integration test deleted; unit coverage untouched |
| `image-lifecycle.test.ts` — `generates correct install command for detected package manager` | [test/unit/capabilities.test.ts:82](../test/unit/capabilities.test.ts#L82) with 9 sibling cases (apt+cleanup, single-package apk, multi-package apk, dnf throws, unknown manager throws, skip-unknown-capabilities, empty-string forms) | Integration test deleted; unit coverage untouched |
| `patches.test.ts` — 8 tests | [test/unit/patches.test.ts](../test/unit/patches.test.ts) with 16 `it` blocks including a 4-cell matrix at lines 483–597 | Most integration tests deleted as duplicates; net delta after reconciliation is at most 1–2 new unit tests |

In all three cases the unit coverage is more thorough than the integration test it would have replaced. Mechanically moving would have produced duplicate tests that the next reviewer would consolidate anyway.

## Preserving load-bearing assertions across moves

When a test moves from integration to unit, its CURRENT assertion is the contract. The original audit notes or test description may describe an earlier (wrong) framing of the contract that has since been corrected in the working tree. Move the assertion VERBATIM — do not re-derive it from your memory of what the test "should" check.

**Worked example.** [test/integration/integration.test.ts:262-284](../test/integration/integration.test.ts#L262) (`partial failure when source has diverged`) originally framed itself as an atomicity check: `expect(result.applied).toEqual([])`. A correctness audit found that `git apply` does NOT do cross-file atomicity by default — files succeed or fail independently. The assertion was rewritten to the honest-partial-reporting contract:

```ts
expect(result.applied.map((entry) => entry.file_path)).toEqual(['stable.txt']);
expect(result.failed.map((entry) => entry.file_path)).toContain('diverged.txt');
expect(fs.readFileSync(path.join(source_directory, 'stable.txt'), 'utf-8'))
    .toBe('sandbox stable\n');
expect(fs.readFileSync(path.join(source_directory, 'diverged.txt'), 'utf-8'))
    .toBe(diverged_before);
```

A future reorganization moves this test to `test/unit/apply.test.ts` with a hand-crafted diff fixture instead of a sandbox-authored one. **The assertion shape MUST move verbatim.** Re-deriving it from the test name ("partial failure when source has diverged") would silently revert the fix to the original atomicity framing. When in doubt about which shape is current, read the file before moving.

## Why not enforce this with a linter?

The rules above are reviewer-applied, not lint-enforced. A linter that flagged `create_sandbox` calls inside `test/unit/` would catch the most obvious miscategorizations but would also have a high false-positive rate on the legitimate shared-sandbox read-only patterns in Requirement 2. The producer-crosses-boundary distinction (a host-side assertion whose producer is podman-side) requires human judgment about value-production chains, not a syntactic check.

The intended use of this document is: when a PR adds a test that doesn't fit, the reviewer links to the relevant section here and uses the rule as the shared reference. A linter is a possible follow-up if reviewers find the rule slipping in practice, but the rule itself is human-shaped.

## Reference

- [reports/integration-test-audit.md](../reports/integration-test-audit.md) — point-in-time audit of the integration suite (2026-06) along the podman-cost-vs-podman-coverage dimension. Section 1 has a per-file overview table; section 3 has per-file detail with carve-out specifics.
- [test/integration/set-up-podman.ts](../test/integration/set-up-podman.ts) — the shared-runtime setup file that runs once per integration worker.
- [vitest.config.ts](../vitest.config.ts) — the project definitions and parallelism settings.
