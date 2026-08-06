import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * End-to-end `--verbose` flag acceptance tests. Spawns the built CLI
 * (`dist/cli.js`) as a subprocess and asserts that the flag is parsed
 * cleanly in every position the user might write it. Replaces the manual
 * exercises specified in tasks 2.3 and 5.3 of the verbose-logging change.
 *
 * The flag is "accepted" if:
 *   - Commander does not error on the unknown-option path.
 *   - The CLI exits cleanly (exit 0 on `list` / `--help`).
 *   - No `error: unknown option` text appears on stderr.
 *
 * No production code path emits `logger().verbose(...)` yet — adoption is
 * deferred to consumer changes. These tests therefore do NOT assert any
 * `patchlab[verbose]: ...` output from production paths; they verify the
 * flag is registered, that the argv pre-scan tolerates every position, and
 * that neither the flag nor the env var produces a parse/runtime error.
 *
 * Verbose-state probing: the CLI's `preAction` hook contains a single
 * `logger().verbose('verbose-probe')` call gated by the internal
 * `PATCHLAB_VERBOSE_PROBE=1` env var (invisible to ordinary CLI users).
 * The tests near the bottom of this file use that probe to assert the
 * positive end-to-end witness that `--verbose` (and `PATCHLAB_VERBOSE`)
 * actually flip the logger state — without those, a regression where the
 * flag parses cleanly but fails to enable verbose output would slip
 * through every other test in the file.
 *
 * Build dependency: assumes `npm run build` has produced `dist/cli.js`.
 *
 * HOME isolation: each test redirects HOME (POSIX) and USERPROFILE
 * (Windows) to a tempdir so the developer's real `~/.patchlab/` archive
 * is never read or modified.
 */

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPOSITORY_ROOT, 'dist', 'cli.js');

interface Spawn_Result {
    stdout: string;
    stderr: string;
    exit_code: number | null;
}

function run_cli(
    home_directory: string,
    command_arguments: string[],
    extra_environment: Record<string, string> = {},
): Spawn_Result {
    const result = spawnSync(process.execPath, [CLI_PATH, ...command_arguments], {
        env: {
            ...process.env,
            HOME: home_directory,
            USERPROFILE: home_directory,
            PATCHLAB_ALLOW_UNTRUSTED_MANIFESTS: '0',
            ...extra_environment,
        },
        encoding: 'utf-8',
        timeout: 60_000,
    });

    return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exit_code: result.status,
    };
}

function seed_sandbox_manifest(home_directory: string, sandbox_id: string): void {
    const sandbox_directory = path.join(home_directory, '.patchlab', sandbox_id);
    fs.mkdirSync(sandbox_directory, { recursive: true });
    const manifest = {
        id: sandbox_id,
        source_path: '/dev/null/source',
        format_version: 0,
        repository_root: null,
        source_prefix: '',
        baseline_commit_sha: null,
        branch_creation_point_sha: null,
        created_at: '2026-05-17T00:00:00.000Z',
        container_name: `patchlab-${sandbox_id}`,
        container_image: 'patchlab/test-image:latest',
    };
    fs.writeFileSync(
        path.join(sandbox_directory, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
    );
}

describe('CLI --verbose flag acceptance (tasks 2.3, 5.3)', () => {
    let home_directory: string;

    beforeEach(() => {
        home_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-verbose-flag-'));
    });

    afterEach(() => {
        fs.rmSync(home_directory, { recursive: true, force: true });
    });

    // Two tests originally lived here that don't reach the
    // `preAction → ensure_podman()` gate at src/cli.ts:475:
    //   - `cli.js exists in dist/` (pure fs.existsSync probe)
    //   - `--help lists --verbose as a program-level option` (Commander
    //     short-circuits --help before preAction)
    // They moved to `test/unit/cli-verbose-flag.test.ts`. The remaining
    // tests below either spawn a subcommand that DOES hit ensure_podman()
    // (`list`, etc.) or assert on its side effects, so they stay here.
    // See [documents/testing-strategy.md](../../documents/testing-strategy.md)
    // "Choosing a project for a new test" for the gate rule.

    it('`patchlab --verbose list` parses cleanly (flag BEFORE subcommand)', () => {
        // Task 2.3 / 5.3: covers the pre-scan's "flag appears before the
        // subcommand" case. The override is set before Commander parses,
        // so when the list action runs (during parseAsync) the override
        // is true — though no current code path emits a verbose line, the
        // command must complete without errors.
        const result = run_cli(home_directory, ['--verbose', 'list']);

        expect(result.exit_code).toBe(0);
        expect(result.stderr).not.toMatch(/error: unknown option/i);
        expect(result.stderr).not.toMatch(/error: unknown command/i);
        // Empty-archive path: "No active sandboxes." on stderr is expected.
        expect(result.stderr).toContain('No active sandboxes.');
    });

    it('`patchlab list --verbose` parses cleanly (flag AFTER subcommand)', () => {
        // Task 2.3 / 5.3: the global option attached at program level is
        // inherited by every subcommand, so `--verbose` after the subcommand
        // name must also parse without error.
        const result = run_cli(home_directory, ['list', '--verbose']);

        expect(result.exit_code).toBe(0);
        expect(result.stderr).not.toMatch(/error: unknown option/i);
        expect(result.stderr).toContain('No active sandboxes.');
    });

    it('`patchlab --verbose list` with a seeded sandbox still produces the row on stdout', () => {
        // Task 5.3 extended: confirms the verbose flag does not pollute
        // stdout. The list row from `logger().result(...)` must land on
        // stdout exactly as it would without the flag — verbose emissions
        // (if any existed) go to stderr, never stdout.
        const sandbox_id = 'verbose-flag-001';
        seed_sandbox_manifest(home_directory, sandbox_id);

        const result = run_cli(home_directory, ['--verbose', 'list']);

        expect(result.exit_code).toBe(0);
        expect(result.stdout).toContain(sandbox_id);
        expect(result.stdout).toContain('[missing]');
        // The verbose prefix MUST NOT appear on stdout regardless of flag
        // state — verbose output goes to stderr.
        expect(result.stdout).not.toContain('patchlab[verbose]:');
    });

    it('`PATCHLAB_VERBOSE=1 patchlab list` parses cleanly (env-var activation)', () => {
        // Locks the env-var path end-to-end: with PATCHLAB_VERBOSE set and
        // no `--verbose` flag, the CLI must still parse and run cleanly.
        const result = run_cli(home_directory, ['list'], { PATCHLAB_VERBOSE: '1' });

        expect(result.exit_code).toBe(0);
        expect(result.stderr).not.toMatch(/error:/i);
        expect(result.stderr).toContain('No active sandboxes.');
    });

    it('`PATCHLAB_VERBOSE=0 patchlab list` parses cleanly (env-var off path)', () => {
        // The off-set must also be tolerated. Locks the decoder's "0 means
        // off" case as seen end-to-end.
        const result = run_cli(home_directory, ['list'], { PATCHLAB_VERBOSE: '0' });

        expect(result.exit_code).toBe(0);
        expect(result.stderr).not.toMatch(/error:/i);
    });

    it('--verbose mixes cleanly with other program-level flags (--strict-trust)', () => {
        // Regression check that the new global option does not collide with
        // the existing program-level options registered alongside it.
        const result = run_cli(home_directory, ['--verbose', '--strict-trust', 'list']);

        expect(result.exit_code).toBe(0);
        expect(result.stderr).not.toMatch(/error:/i);
        expect(result.stderr).toContain('No active sandboxes.');
    });

    it('no `patchlab[verbose]:` line is emitted by current code paths (consumer-driven adoption)', () => {
        // Task 5.5: confirms that NO call site emits a verbose line by
        // default — the internal probe in `preAction` is gated by
        // `PATCHLAB_VERBOSE_PROBE=1` and is not set here. If a future
        // change accidentally wires up an unconditional verbose emission
        // anywhere in the CLI path, this test surfaces it.
        const sandbox_id = 'verbose-flag-002';
        seed_sandbox_manifest(home_directory, sandbox_id);

        const result = run_cli(home_directory, ['--verbose', 'list']);

        expect(result.exit_code).toBe(0);
        expect(result.stdout).not.toContain('patchlab[verbose]:');
        expect(result.stderr).not.toContain('patchlab[verbose]:');
    });

    it('--verbose actually flips the logger: PATCHLAB_VERBOSE_PROBE surfaces the internal probe', () => {
        // Positive witness for the `--verbose` flag. The CLI's `preAction`
        // hook calls `logger().verbose('verbose-probe')` when (and only
        // when) `PATCHLAB_VERBOSE_PROBE=1` is set. That call is silent
        // unless verbose mode is active, so this test proves the
        // `--verbose` flag actually flips the logger state to "active" —
        // without this assertion, a regression where `--verbose` parses
        // cleanly but fails to enable verbose output would slip through
        // every other test in this file (they all check parsing only).
        const result = run_cli(
            home_directory,
            ['--verbose', 'list'],
            { PATCHLAB_VERBOSE_PROBE: '1' },
        );

        expect(result.exit_code).toBe(0);
        expect(result.stderr).toContain('verbose-probe');
        // The verbose channel writes to stderr, never stdout.
        expect(result.stdout).not.toContain('verbose-probe');
    });

    it('without --verbose, PATCHLAB_VERBOSE_PROBE does NOT surface (off-path complement)', () => {
        // Companion negative-witness: the probe is internal and gated, so
        // setting PATCHLAB_VERBOSE_PROBE alone (with verbose mode off)
        // produces no output. A regression that always emitted verbose
        // lines regardless of flag state would fail here.
        const result = run_cli(
            home_directory,
            ['list'],
            { PATCHLAB_VERBOSE_PROBE: '1' },
        );

        expect(result.exit_code).toBe(0);
        expect(result.stderr).not.toContain('verbose-probe');
    });

    it('--verbose and PATCHLAB_VERBOSE=1 converge on the same logger state (probe surfaces under both)', () => {
        // Convergence assertion. The two activation paths (CLI flag and
        // env var) MUST produce identical observable behavior. A
        // regression where the env-var decoder regressed to a no-op would
        // pass the existing `PATCHLAB_VERBOSE=1 patchlab list` parse test
        // (empty archive + exit 0 + no `error:`) but fail to surface the
        // probe here.
        const env_result = run_cli(
            home_directory,
            ['list'],
            { PATCHLAB_VERBOSE: '1', PATCHLAB_VERBOSE_PROBE: '1' },
        );
        const flag_result = run_cli(
            home_directory,
            ['--verbose', 'list'],
            { PATCHLAB_VERBOSE_PROBE: '1' },
        );

        expect(env_result.exit_code).toBe(0);
        expect(flag_result.exit_code).toBe(0);
        expect(env_result.stderr).toContain('verbose-probe');
        expect(flag_result.stderr).toContain('verbose-probe');
    });
});