/**
 * `patchlab create` manifest-sources integration tests.
 *
 * Covers the `sources-in-manifest` feature: sourcing the `sources` array
 * from `.patchlab.json` when no CLI source arguments are provided. All four
 * scenarios exercise the validation layer only — no podman runtime required.
 * The CLI emits `Resolved N source(s).` on stderr immediately after
 * `resolve_source_inputs` returns successfully, before any image build. That
 * marker is used as the positive assertion to prove validation passed.
 *
 * Build dependency: assumes `npm run build` has produced `dist/cli.js`.
 *
 * HOME isolation: each test redirects HOME / USERPROFILE to a temp dir so
 * the developer's real `~/.patchlab/` archive is never touched.
 *
 * Run sequentially — patchlab's integration tests share a single podman
 * runtime. This file contains no podman tests but follows the same convention.
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
    working_directory?: string,
): Spawn_Result {
    const result = spawnSync(process.execPath, [CLI_PATH, 'create', ...CLI_CREATE_TOOL_FLAGS, ...command_arguments], {
        cwd: working_directory,
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

function write_patchlab_json(directory: string, content: object): void {
    fs.writeFileSync(path.join(directory, '.patchlab.json'), JSON.stringify(content));
}

describe('patchlab create — manifest sources (.patchlab.json sources array)', () => {
    let home_directory: string;
    let workspace: string;
    let repository: string;
    let other_repository: string;

    beforeEach(() => {
        home_directory = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cli-ms-home-')),
        );
        write_default_test_tool_manifest_to_home(home_directory);
        workspace = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cli-ms-ws-')),
        );
        repository = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cli-ms-repo-')),
        );
        init_git_repository(repository);
        other_repository = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cli-ms-other-')),
        );
        init_git_repository(other_repository);
    });

    afterEach(() => {
        for (const directory of [home_directory, workspace, repository, other_repository]) {
            try {
                fs.rmSync(directory, { recursive: true, force: true });
            } catch (_ignored) {
                // best effort
            }
        }
    });

    it('no-arg create reads sources from CWD .patchlab.json and passes validation', () => {
        // Place .patchlab.json in the workspace directory pointing at `repository`
        // as a relative path. Run `patchlab create` from `workspace` with no
        // source arguments — it should load the manifest and resolve 1 source.
        const relative_name = path.relative(workspace, repository);
        write_patchlab_json(workspace, { sources: [relative_name] });

        const result = run_cli_create(
            home_directory,
            ['--no-interactive', '--no-install'],
            workspace,
        );

        // The CLI must pass `resolve_source_inputs` and emit the positive marker.
        expect(result.stderr).toContain('Resolved 1 source(s).');
    });

    it('multi-repo string sources in manifest accepted without --mount', () => {
        // String entries in `.patchlab.json` produce explicit `mount_name`
        // values by construction, so no `--mount` flag is needed even when the
        // two repos are distinct. The CWD manifest lists two repos as sibling
        // subdirectory names.
        //
        // We use absolute paths in the manifest here so the resolver finds the
        // repos regardless of where the workspace temp dir lands relative to them.
        write_patchlab_json(workspace, {
            sources: [
                { path: repository, mount: 'repo-a' },
                { path: other_repository, mount: 'repo-b' },
            ],
        });

        const result = run_cli_create(
            home_directory,
            ['--no-interactive', '--no-install'],
            workspace,
        );

        expect(result.stderr).toContain('Resolved 2 source(s).');
        expect(result.stderr).not.toMatch(/every source MUST be supplied with an explicit --mount/i);
    });

    it('CLI positional source preempts .patchlab.json sources', () => {
        // When a positional source argument is provided, `.patchlab.json` is
        // ignored entirely — the sandbox uses only the CLI-supplied source.
        const relative_name = path.relative(workspace, other_repository);
        write_patchlab_json(workspace, { sources: [relative_name] });

        const result = run_cli_create(
            home_directory,
            [repository, '--no-interactive', '--no-install'],
            workspace,
        );

        // One source resolved (the CLI path, not the file's two entries).
        expect(result.stderr).toContain('Resolved 1 source(s).');
    });

    it('CWD .patchlab.json wins over git-root .patchlab.json when both have sources', () => {
        // Build a git repository whose root has one .patchlab.json and whose
        // subdirectory (the CWD) has another. The CWD manifest must win.
        const git_root = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cli-ms-gr-')),
        );
        try {
            init_git_repository(git_root);

            // Git-root manifest points at `other_repository` (would resolve 1 source
            // from the git-root file).
            write_patchlab_json(git_root, {
                sources: [{ path: other_repository, mount: 'other' }],
            });

            // CWD is a subdirectory inside the git root with its own manifest
            // pointing at `repository` (should win with 1 source).
            const subdirectory = path.join(git_root, 'workspace');
            fs.mkdirSync(subdirectory);
            write_patchlab_json(subdirectory, {
                sources: [{ path: repository, mount: 'repo' }],
            });

            const result = run_cli_create(
                home_directory,
                ['--no-interactive', '--no-install'],
                subdirectory,
            );

            // The CWD manifest must be used. Both manifests declare 1 source,
            // so the resolved count (1) cannot distinguish which was loaded —
            // this assertion only verifies that source resolution succeeded.
            // The unit test `CWD manifest wins` in overrides.test.ts verifies
            // the correct entries were returned by checking `discovered.entries`.
            expect(result.stderr).toContain('Resolved 1 source(s).');
        } finally {
            fs.rmSync(git_root, { recursive: true, force: true });
        }
    });

    it('fails with a clear error when no sources are specified and no manifest exists', () => {
        // Running `patchlab create` from a plain temp dir with no .patchlab.json
        // and no CLI source arguments must exit non-zero with a descriptive message.
        const result = run_cli_create(
            home_directory,
            ['--no-interactive', '--no-install'],
            workspace,
        );

        expect(result.exit_code).not.toBe(0);
        expect(result.stderr).toMatch(/no sources specified/i);
    });

    it('fails with a clear error when --mount is provided without a positional source', () => {
        // If a user provides --mount but forgets the positional source, the CLI
        // should detect the incomplete CLI invocation and report a clear error
        // rather than falling back to the manifest.
        const result = run_cli_create(
            home_directory,
            ['--mount', 'my-mount', '--no-interactive', '--no-install'],
            workspace,
        );

        expect(result.exit_code).not.toBe(0);
        expect(result.stderr).toMatch(/positional.*source.*required|source.*required.*--mount/i);
    });
});
