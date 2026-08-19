/**
 * `patchlab create` multi-source flag-parsing and validation tests.
 *
 * The validation rules (same-repository invariant, source-prefix uniqueness,
 * empty-prefix exclusivity, no nested-prefix overlap) fire INSIDE
 * `resolve_source_inputs` before any container or branch is created. This
 * suite asserts the user-facing outcome for each rule by spawning the built
 * CLI as a subprocess and observing exit code + stderr — no podman runtime
 * is required for these specific paths.
 *
 * Build dependency: assumes `npm run build` has produced `dist/cli.js`.
 *
 * HOME isolation: each test redirects HOME (POSIX) and USERPROFILE (Windows)
 * to a tempdir so the developer's real `~/.patchlab/` archive is never
 * touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DEFAULT_TEST_TOOL, write_default_test_tool_manifest_to_home } from '../helpers/stub_tool_provider.js';
import { cli_subprocess_env } from '../helpers/home_directory.js';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPOSITORY_ROOT, 'dist', 'cli.js');

const GIT_ENVIRONMENT = {
    ...process.env,
    GIT_AUTHOR_NAME: 'patchlab-test',
    GIT_AUTHOR_EMAIL: 'test@patchlab.local',
    GIT_COMMITTER_NAME: 'patchlab-test',
    GIT_COMMITTER_EMAIL: 'test@patchlab.local',
};

interface Spawn_Result {
    stdout: string;
    stderr: string;
    exit_code: number | null;
}

const CLI_CREATE_TOOL_FLAGS = ['--tool', DEFAULT_TEST_TOOL, '--allow-untrusted-manifests'];

function run_cli_create(
    home_directory: string,
    command_arguments: string[],
): Spawn_Result {
    const result = spawnSync(process.execPath, [CLI_PATH, 'create', ...CLI_CREATE_TOOL_FLAGS, ...command_arguments], {
        env: cli_subprocess_env(home_directory),
        encoding: 'utf-8',
        timeout: 60_000,
    });
    return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exit_code: result.status,
    };
}

function init_git_repository(repository: string): void {
    execFileSync('git', ['init'], { cwd: repository, env: GIT_ENVIRONMENT, stdio: 'pipe' });
    fs.writeFileSync(path.join(repository, 'README.md'), 'initial\n');
    execFileSync('git', ['add', '-A'], { cwd: repository, env: GIT_ENVIRONMENT, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repository, env: GIT_ENVIRONMENT, stdio: 'pipe' });
}

describe('patchlab create — multi-source flag parsing and validation', () => {
    let home_directory: string;
    let repository: string;
    let other_repository: string;

    beforeEach(() => {
        home_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cli-mpx-home-')));
        write_default_test_tool_manifest_to_home(home_directory);
        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cli-mpx-repo-')));
        init_git_repository(repository);
        // Pre-populate the subpaths used across the suite.
        fs.mkdirSync(path.join(repository, 'src', 'ui'), { recursive: true });
        fs.mkdirSync(path.join(repository, 'src', 'server'), { recursive: true });
        fs.mkdirSync(path.join(repository, 'src2'), { recursive: true });
        other_repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cli-mpx-other-')));
        init_git_repository(other_repository);
    });

    afterEach(() => {
        try {
            fs.rmSync(home_directory, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
        try {
            fs.rmSync(repository, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
        try {
            fs.rmSync(other_repository, { recursive: true, force: true });
        } catch (_ignored) {
            // best effort
        }
    });

    it('rejects multi-repository sources without an explicit --mount on every source', () => {
        // Under multi-source-lifecycle, sources MAY span multiple repositories
        // — but every source must carry an explicit --mount flag. Without --mount,
        // the resolver rejects with the multi-repo explicitness error.
        const result = run_cli_create(home_directory, [
            repository,
            '--source', other_repository,
            '--no-interactive',
            '--no-install',
        ]);
        expect(result.exit_code).not.toBe(0);
        expect(result.stderr).toMatch(/every source MUST be supplied with an explicit --mount/i);
    });

    it('rejects two sources that resolve to the same source_prefix', () => {
        // Passing the same subpath twice triggers the prefix-uniqueness rule
        // (case-insensitive ASCII fold).
        const ui = path.join(repository, 'src', 'ui');
        const result = run_cli_create(home_directory, [
            ui,
            '--source', ui,
            '--no-interactive',
            '--no-install',
        ]);
        expect(result.exit_code).not.toBe(0);
        expect(result.stderr).toMatch(/must be unique/i);
    });

    it('rejects empty-prefix source combined with another source', () => {
        const ui = path.join(repository, 'src', 'ui');
        const result = run_cli_create(home_directory, [
            repository, // empty source_prefix (source IS repo root)
            '--source', ui,
            '--no-interactive',
            '--no-install',
        ]);
        expect(result.exit_code).not.toBe(0);
        expect(result.stderr).toMatch(/shadow every sibling/i);
    });

    it('rejects nested-prefix overlap (src vs src/ui)', () => {
        const src = path.join(repository, 'src');
        const ui = path.join(repository, 'src', 'ui');
        const result = run_cli_create(home_directory, [
            src,
            '--source', ui,
            '--no-interactive',
            '--no-install',
        ]);
        expect(result.exit_code).not.toBe(0);
        expect(result.stderr).toMatch(/path-component prefix/i);
    });

    it('accepts sibling lookalike prefixes (src + src2) at validation', () => {
        // The CLI emits a `Resolved N source(s).` positive marker on stderr
        // immediately after `resolve_source_inputs` returns successfully,
        // before the (potentially slow) image build. Asserting BOTH the
        // absence of rejection messages AND the presence of this marker
        // proves the subprocess actually reached and passed validation — a
        // regression that silently stripped a source on this path (so the
        // rejection strings would still be absent) would fail this test
        // because the resolved count or the marker itself would change.
        const src = path.join(repository, 'src');
        const src2 = path.join(repository, 'src2');
        const result = run_cli_create(home_directory, [
            src,
            '--source', src2,
            '--no-interactive',
            '--no-install',
        ]);
        expect(result.stderr).not.toMatch(/path-component prefix/i);
        expect(result.stderr).not.toMatch(/must be unique/i);
        expect(result.stderr).not.toMatch(/shadow every sibling/i);
        expect(result.stderr).not.toMatch(/multi-sources follow-up/i);
        expect(result.stderr).toContain('Resolved 2 source(s).');
    });

    it('single positional source with no --source flag passes validation', () => {
        // Same logic as the sibling-lookalike check: the single-source
        // baseline must not be rejected by the multi-source validator. The
        // positive marker locks the count, so a regression that
        // accidentally added an empty source to the list would fail here.
        const ui = path.join(repository, 'src', 'ui');
        const result = run_cli_create(home_directory, [
            ui,
            '--no-interactive',
            '--no-install',
        ]);
        expect(result.stderr).not.toMatch(/path-component prefix/i);
        expect(result.stderr).not.toMatch(/must be unique/i);
        expect(result.stderr).not.toMatch(/shadow every sibling/i);
        expect(result.stderr).not.toMatch(/multi-sources follow-up/i);
        expect(result.stderr).toContain('Resolved 1 source(s).');
    });

    it('rejects a source path not inside a git repository', () => {
        const non_git = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cli-mpx-nogit-'));
        try {
            const result = run_cli_create(home_directory, [
                non_git,
                '--no-interactive',
                '--no-install',
            ]);
            expect(result.exit_code).not.toBe(0);
            expect(result.stderr).toMatch(/git repository/i);
        } finally {
            fs.rmSync(non_git, { recursive: true, force: true });
        }
    });

    it('rejects more --mount values than sources (cli.ts:549 count guard)', () => {
        // The guard at src/cli.ts:549-554 is distinct from
        // `resolve_source_inputs`'s rules — an off-by-one in `total_sources`
        // computation would let a wrong --mount-to-source pairing slip
        // through. One positional source + zero `--source` flags means
        // total_sources=1; two --mount flags MUST be rejected.
        const ui = path.join(repository, 'src', 'ui');
        const result = run_cli_create(home_directory, [
            ui,
            '--mount', 'mount_one',
            '--mount', 'mount_two',
            '--no-interactive',
            '--no-install',
        ]);
        expect(result.exit_code).not.toBe(0);
        // The error message names both the supplied --mount count (2) and
        // the source count (1) so the user can fix the mismatch.
        expect(result.stderr).toMatch(/--mount supplied 2 times/);
        expect(result.stderr).toMatch(/only 1 source/);
    });
});
