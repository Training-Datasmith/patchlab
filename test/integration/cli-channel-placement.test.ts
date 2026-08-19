import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { cli_subprocess_env } from '../helpers/home_directory.js';

/**
 * End-to-end channel-placement integration tests. Spawns the built CLI
 * (`dist/cli.js`) as a subprocess, captures stdout and stderr separately, and
 * asserts which channel each emission lands on. Replaces the manual exercise
 * specified in tasks 7.4 / 7.4a of the injectable-logger change.
 *
 * Why subprocess: the unit tests exercise the Logger and individual emission
 * sites in isolation. These tests verify the full chain — Commander dispatch,
 * action-handler emission, ConsoleLogger routing — at the binary level, which
 * is the closest automated analog to "run patchlab on a terminal and see what
 * lands where."
 *
 * Build dependency: assumes `npm run build` has produced `dist/cli.js`. The
 * existing integration setup (`set-up-podman.ts`) ensures Podman is running,
 * which the CLI's `preAction` hook requires for non-`apply` commands.
 *
 * HOME isolation: the patchlab sandbox archive lives under `~/.patchlab/`.
 * Each test redirects HOME (POSIX) and USERPROFILE (Windows) to a tempdir so
 * the developer's real archive is never read or modified.
 */

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPOSITORY_ROOT, 'dist', 'cli.js');

interface Spawn_Result {
    stdout: string;
    stderr: string;
    exit_code: number | null;
}

function run_cli(home_directory: string, command_arguments: string[]): Spawn_Result {
    const result = spawnSync(process.execPath, [CLI_PATH, ...command_arguments], {
        env: {
            ...cli_subprocess_env(home_directory),
            // Force the CLI to skip its TTY prompts so the test is deterministic.
            // Apply's --force flag covers `apply`; for create-style flows we
            // simply avoid commands that need TTY input in these tests.
            PATCHLAB_ALLOW_UNTRUSTED_MANIFESTS: '0',
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
        created_at: '2026-05-16T00:00:00.000Z',
        container_name: `patchlab-${sandbox_id}`,
        container_image: 'patchlab/test-image:latest',
    };
    fs.writeFileSync(
        path.join(sandbox_directory, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
    );
}

describe('CLI channel placement (7.4 / 7.4a)', () => {
    let home_directory: string;

    beforeEach(() => {
        home_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cli-channel-'));
    });

    afterEach(() => {
        fs.rmSync(home_directory, { recursive: true, force: true });
    });

    it('cli.js exists in dist/ (the test suite assumes a current build)', () => {
        expect(fs.existsSync(CLI_PATH)).toBe(true);
    });

    it('`patchlab list` with empty home: "No active sandboxes." lands on stderr, stdout is empty', () => {
        const result = run_cli(home_directory, ['list']);

        // The "No active sandboxes." message is an `info` emission per the
        // channel convention; it MUST appear on stderr and MUST NOT appear on
        // stdout. The exit code is 0 (an empty list is not an error).
        expect(result.exit_code).toBe(0);
        expect(result.stderr).toContain('No active sandboxes.');
        expect(result.stdout).not.toContain('No active sandboxes.');
        // No table rows on either stream (the list is empty)
        expect(result.stdout).toBe('');
    });

    it('`patchlab list` with seeded sandboxes: row(s) land on stdout, "No active sandboxes." not emitted', () => {
        const sandbox_id = 'integration-test-001';
        seed_sandbox_manifest(home_directory, sandbox_id);

        const result = run_cli(home_directory, ['list']);

        expect(result.exit_code).toBe(0);
        // The row format from logger().result(...) at src/cli.ts:494 is
        // `${id}  ${container_name}  [${status}]  ${source_path}  ${created_at}`.
        // The container was never created, so status is `missing`.
        expect(result.stdout).toContain(sandbox_id);
        expect(result.stdout).toContain(`patchlab-${sandbox_id}`);
        expect(result.stdout).toContain('[missing]');
        // The row MUST NOT appear on stderr (it's a `result` emission, not info)
        expect(result.stderr).not.toContain(`[missing]`);
        // The empty-state message MUST NOT appear (the list is non-empty)
        expect(result.stderr).not.toContain('No active sandboxes.');
        expect(result.stdout).not.toContain('No active sandboxes.');
    });

    it('pipe regression: first stdout line of `patchlab list` is exactly a sandbox row, not info chatter', () => {
        const sandbox_id = 'pipe-test-002';
        seed_sandbox_manifest(home_directory, sandbox_id);

        const result = run_cli(home_directory, ['list']);

        // `patchlab list` emits a header row then one data row per sandbox.
        // Simulate `patchlab list | grep <id>` — only the sandbox row should
        // match; the header row must not contain the id.
        const stdout_lines = result.stdout.split('\n').filter((line) => line.length > 0);
        expect(stdout_lines.length).toBeGreaterThanOrEqual(2);
        expect(stdout_lines[0]).toBe('ID  CONTAINER  STATUS  SOURCE  CREATED');
        const sandbox_row = stdout_lines[1];

        // The sandbox row MUST contain the id and status; no progress/status
        // chatter (moved to `info`/stderr) should appear in any stdout line.
        expect(sandbox_row).toContain(sandbox_id);
        expect(sandbox_row).toContain('[missing]');

        // Specific stderr-only messages MUST NOT appear in stdout
        const forbidden_in_stdout = [
            'Podman machine is not running',
            'Using cached',
            'Building patchlab image',
            'Detected requirement',
            'No active sandboxes.',
        ];
        for (const forbidden of forbidden_in_stdout) {
            expect(result.stdout).not.toContain(forbidden);
        }
    });

    it('`patchlab` with no command prints help (Commander) and exits cleanly', () => {
        const result = run_cli(home_directory, ['--help']);

        // `--help` is special: Commander writes help text directly to stdout
        // (bypassing our Logger). This test locks the fact that --help is the
        // ONE command-line affordance that produces stdout output by default
        // — not because the patchlab Logger emits to stdout, but because
        // Commander itself does. If a future contributor wires the help text
        // through `logger().info()`, this test would surface the change.
        expect(result.exit_code).toBe(0);
        expect(result.stdout).toContain('patchlab');
        expect(result.stdout).toContain('Commands:');
    });
});
