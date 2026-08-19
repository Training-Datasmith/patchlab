/**
 * Unit tests for `src/sandbox/workspace_staging.ts`. The podman primitives
 * (`exec_container`, `copy_to_container`) are mocked at module level so the
 * orchestration paths can be exercised against a real on-disk fixture without
 * a running container.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

vi.mock('../../../src/container_runtime.js', () => ({
    CONTAINER_WORKING_DIR: '/home/patchlab/workspace',
    copy_to_container: vi.fn(),
    copy_into_workspace: vi.fn(),
    exec_container: vi.fn(),
    fix_workspace_ownership_if_needed: vi.fn(),
    runtime_host_tmpdir: vi.fn(() => os.tmpdir()),
}));

import {
    configure_composer_path_repositories,
    DEFAULT_SECRET_EXCLUDES,
    copy_multi_source_files,
    initialize_sandbox_git_baseline,
    install_dependencies,
    install_npm_packages,
    overlay_into_container,
    overlay_multi_source_host_files,
    prepare_workspace,
} from '../../../src/sandbox/workspace_staging.js';
import { copy_to_container, exec_container } from '../../../src/container_runtime.js';
import type { Source_Specification } from '../../../src/manifest.js';
import type { Npm_Package_Requirement } from '../../../src/detect/index.js';
import {
    install_recording_logger_hooks,
    filter_recorded_messages,
} from '../../helpers/recording_logger.js';

const mocked_exec_container = vi.mocked(exec_container);
const mocked_copy_to_container = vi.mocked(copy_to_container);

function make_source(overrides: Partial<Source_Specification> = {}): Source_Specification {
    return {
        host_path: '/host/path',
        repository_root: '/host/path',
        source_prefix: '',
        mount_name: '',
        ...overrides,
    };
}

/** Recursively list the files under `root` as forward-slash relative paths. */
function list_staged_files(root: string): string[] {
    const results: string[] = [];
    const walk = (directory: string, prefix: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory()) {
                walk(path.join(directory, entry.name), relative);
            } else {
                results.push(relative);
            }
        }
    };
    walk(root, '');
    return results;
}

/**
 * Snapshot every staging directory `copy_multi_source_files` hands to
 * `copy_to_container`, captured INSIDE the mock — i.e. while the directory
 * still exists, before the function's `finally` removes it. Reading it after
 * the call (as a few older tests did) always saw an empty/missing directory,
 * so those assertions could never fail. Returns the accumulator the
 * implementation pushes each per-source snapshot into.
 */
function capture_staged_files(): string[][] {
    const snapshots: string[][] = [];
    mocked_copy_to_container.mockImplementation((_name, source_argument) => {
        const staging = String(source_argument).replace(/\/\.$/, '');
        snapshots.push(list_staged_files(staging));
    });
    return snapshots;
}

describe('DEFAULT_SECRET_EXCLUDES', () => {
    it('exports a non-empty list of default secret patterns', () => {
        expect(DEFAULT_SECRET_EXCLUDES.length).toBeGreaterThan(0);
        expect(DEFAULT_SECRET_EXCLUDES).toContain('**/.env');
        expect(DEFAULT_SECRET_EXCLUDES).toContain('**/*.pem');
        expect(DEFAULT_SECRET_EXCLUDES).toContain('**/.ssh/**');
    });
});

describe('copy_multi_source_files — gitignore support', () => {
    let source_directory: string;

    beforeEach(() => {
        mocked_exec_container.mockReset();
        mocked_copy_to_container.mockReset();
        source_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-gitignore-')));
        // Initialise a real git repo so git ls-files is used instead of the glob fallback.
        execSync('git init', { cwd: source_directory, stdio: 'ignore' });
        execSync('git config user.email "test@test.com"', { cwd: source_directory, stdio: 'ignore' });
        execSync('git config user.name "Test"', { cwd: source_directory, stdio: 'ignore' });
    });

    afterEach(() => {
        fs.rmSync(source_directory, { recursive: true, force: true });
    });

    it('excludes files matched by .gitignore', () => {
        fs.writeFileSync(path.join(source_directory, '.gitignore'), 'build/\n');
        fs.mkdirSync(path.join(source_directory, 'build'));
        fs.writeFileSync(path.join(source_directory, 'build', 'output.js'), 'built');
        fs.writeFileSync(path.join(source_directory, 'app.ts'), 'source');

        const staged_snapshots = capture_staged_files();
        copy_multi_source_files('container-x', [make_source({
            host_path: source_directory,
            repository_root: source_directory,
            source_prefix: '',
            mount_name: '',
        })], undefined, '/workspace');

        expect(staged_snapshots).toHaveLength(1);
        expect(staged_snapshots[0]).toContain('app.ts');
        expect(staged_snapshots[0]).toContain('.gitignore');
        expect(staged_snapshots[0]).not.toContain('build/output.js');
    });

    it('excludes node_modules when gitignored without a warning', () => {
        fs.writeFileSync(path.join(source_directory, '.gitignore'), 'node_modules/\n');
        fs.mkdirSync(path.join(source_directory, 'node_modules', 'lodash'), { recursive: true });
        fs.writeFileSync(path.join(source_directory, 'node_modules', 'lodash', 'index.js'), 'module');
        fs.writeFileSync(path.join(source_directory, 'app.ts'), 'source');

        const staged_snapshots = capture_staged_files();
        copy_multi_source_files('container-x', [make_source({
            host_path: source_directory,
            repository_root: source_directory,
            source_prefix: '',
            mount_name: '',
        })], undefined, '/workspace');

        expect(staged_snapshots).toHaveLength(1);
        expect(staged_snapshots[0]).toContain('app.ts');
        expect(staged_snapshots[0]).not.toContain('node_modules/lodash/index.js');
    });
});

describe('prepare_workspace', () => {
    beforeEach(() => {
        mocked_exec_container.mockReset();
    });

    it('issues a single sh -c that rm -rfs then mkdir -ps, with the path as a positional arg', () => {
        prepare_workspace('container-x', '/home/patchlab/workspace');

        // One exec, not two: podman exec chdir's into the WORKDIR before each
        // command, so a second exec after `rm -rf` could not chdir into the
        // directory it just deleted. The script text is FIXED ($1), so the path
        // is data, never interpolated code.
        expect(mocked_exec_container).toHaveBeenCalledTimes(1);
        expect(mocked_exec_container.mock.calls[0]).toEqual([
            'container-x',
            ['sh', '-c', 'rm -rf "$1" && mkdir -p "$1"', 'sh', '/home/patchlab/workspace'],
        ]);
    });

    it('passes a path with shell metacharacters as a positional arg, not into the script', () => {
        // A configured provider's image_home could be `/opt/my tool; rm -rf /`;
        // it must arrive as $1 (data), and the script text must NOT contain it.
        prepare_workspace('container-x', '/opt/my tool; rm -rf /');

        const [, command] = mocked_exec_container.mock.calls[0];
        expect(command).toEqual([
            'sh', '-c', 'rm -rf "$1" && mkdir -p "$1"', 'sh', '/opt/my tool; rm -rf /',
        ]);
        // The dangerous string is the positional arg, never spliced into the script.
        expect(command[2]).toBe('rm -rf "$1" && mkdir -p "$1"');
        expect(command[2]).not.toContain('rm -rf /');
    });
});

describe('overlay_into_container', () => {
    let staging_directory: string;

    beforeEach(() => {
        mocked_copy_to_container.mockReset();
        staging_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-overlay-')));
    });

    afterEach(() => {
        fs.rmSync(staging_directory, { recursive: true, force: true });
    });

    it('returns without copying when the staging directory is empty', () => {
        overlay_into_container('container-x', staging_directory, '/workspace');

        expect(mocked_copy_to_container).not.toHaveBeenCalled();
    });

    it('copies the staging directory contents into the container working directory', () => {
        fs.writeFileSync(path.join(staging_directory, 'a.txt'), 'a');

        overlay_into_container('container-x', staging_directory, '/workspace');

        expect(mocked_copy_to_container).toHaveBeenCalledTimes(1);
        const [container_name, source_argument, destination_argument] = mocked_copy_to_container.mock.calls[0];
        expect(container_name).toBe('container-x');
        expect(source_argument).toBe(staging_directory + '/.');
        expect(destination_argument).toBe('/workspace');
    });
});

describe('initialize_sandbox_git_baseline', () => {
    beforeEach(() => {
        mocked_exec_container.mockReset();
    });

    it('runs the seven git commands that establish the sandbox baseline', () => {
        initialize_sandbox_git_baseline('container-x', '/workspace');

        // Seven exec calls: init, two configs (autocrlf, eol), two configs
        // (user.email, user.name), add -A, commit.
        expect(mocked_exec_container).toHaveBeenCalledTimes(7);
        const command_sequence = mocked_exec_container.mock.calls.map((call) => call[1].join(' '));
        expect(command_sequence[0]).toBe('git init');
        expect(command_sequence[1]).toContain('core.autocrlf false');
        expect(command_sequence[2]).toContain('core.eol lf');
        expect(command_sequence[3]).toContain('user.email');
        expect(command_sequence[4]).toContain('user.name');
        expect(command_sequence[5]).toBe('git add -A');
        expect(command_sequence[6]).toContain('commit -m baseline --allow-empty');
    });
});

describe('install_dependencies', () => {
    const logger_handle = install_recording_logger_hooks();

    beforeEach(() => {
        mocked_exec_container.mockReset();
    });

    it('runs npm ci followed by a git checkpoint when package-lock.json is present', () => {
        mocked_exec_container.mockImplementation((_name, command) => {
            if (command[0] === 'ls') {
                return 'package.json\npackage-lock.json\n';
            }
            return '';
        });

        install_dependencies('container-x', '/workspace');

        const command_sequence = mocked_exec_container.mock.calls.map((call) => call[1].join(' '));
        expect(command_sequence).toContain('npm ci');
        expect(command_sequence.some((c) => c.startsWith('git commit -m dependencies'))).toBe(true);
    });

    it('runs npm install when package.json is present without a lockfile', () => {
        mocked_exec_container.mockImplementation((_name, command) => {
            if (command[0] === 'ls') {
                return 'package.json\n';
            }
            return '';
        });

        install_dependencies('container-x', '/workspace');

        const command_sequence = mocked_exec_container.mock.calls.map((call) => call[1].join(' '));
        expect(command_sequence).toContain('npm install');
    });

    it('does nothing when neither package.json nor package-lock.json is present', () => {
        mocked_exec_container.mockImplementation((_name, command) => {
            if (command[0] === 'ls') {
                return 'README.md\nsrc\n';
            }
            return '';
        });

        install_dependencies('container-x', '/workspace');

        const command_sequence = mocked_exec_container.mock.calls.map((call) => call[1].join(' '));
        expect(command_sequence.some((c) => c.startsWith('npm'))).toBe(false);
    });

    it('does not trigger npm ci when only a false-substring lockfile name is present', () => {
        // A file named e.g. "my-package-lock.json" contains "package-lock.json"
        // as a substring, so the old includes() check would have incorrectly run
        // npm ci. The fix splits ls output by newline and checks for an exact name.
        mocked_exec_container.mockImplementation((_name, command) => {
            if (command[0] === 'ls') {
                return 'my-package-lock.json\npackage.json\n';
            }
            return '';
        });

        install_dependencies('container-x', '/workspace');

        const command_sequence = mocked_exec_container.mock.calls.map((call) => call[1].join(' '));
        expect(command_sequence).not.toContain('npm ci');
        expect(command_sequence).toContain('npm install');
    });

    it('does not trigger npm install when only a false-substring package.json name is present', () => {
        // A file named "package.json.bak" contains "package.json" as a substring.
        mocked_exec_container.mockImplementation((_name, command) => {
            if (command[0] === 'ls') {
                return 'package.json.bak\nREADME.md\n';
            }
            return '';
        });

        install_dependencies('container-x', '/workspace');

        const command_sequence = mocked_exec_container.mock.calls.map((call) => call[1].join(' '));
        expect(command_sequence.some((c) => c.startsWith('npm'))).toBe(false);
    });

    it('logs a warning and continues when exec_container throws', () => {
        mocked_exec_container.mockImplementation((_name, command) => {
            if (command[0] === 'ls') {
                throw new Error('container not running');
            }
            return '';
        });

        install_dependencies('container-x', '/workspace');

        const warnings = filter_recorded_messages(logger_handle.current(), 'warn');
        expect(warnings.some((message) => message.includes('npm install failed'))).toBe(true);
    });
});

describe('install_npm_packages', () => {
    const logger_handle = install_recording_logger_hooks();

    beforeEach(() => {
        mocked_exec_container.mockReset();
    });

    it('runs npm install -g for each package, with init_command when supplied', () => {
        mocked_exec_container.mockReturnValue('');
        const packages: Npm_Package_Requirement[] = [
            { type: 'npm_package', package: '@anthropic-ai/claude-code', init_command: ['claude-code', '--version'], source: 'dev_dependencies' },
            { type: 'npm_package', package: 'typescript', source: 'dev_dependencies' },
        ];

        install_npm_packages('container-x', packages, '/workspace');

        const command_sequence = mocked_exec_container.mock.calls.map((call) => call[1].join(' '));
        expect(command_sequence.some((c) => c.includes('npm install -g @anthropic-ai/claude-code'))).toBe(true);
        expect(command_sequence.some((c) => c.includes('claude-code --version'))).toBe(true);
        expect(command_sequence.some((c) => c.includes('npm install -g typescript'))).toBe(true);
    });

    it('writes a checkpoint commit after the package loop', () => {
        mocked_exec_container.mockReturnValue('');

        install_npm_packages('container-x', [{ type: 'npm_package', package: 'typescript', source: 'dev_dependencies' }], '/workspace');

        const command_sequence = mocked_exec_container.mock.calls.map((call) => call[1].join(' '));
        expect(command_sequence.some((c) => c.includes('commit -m tools --allow-empty'))).toBe(true);
    });

    it('logs the install action via logger().info before each package', () => {
        mocked_exec_container.mockReturnValue('');

        install_npm_packages('container-x', [{ type: 'npm_package', package: 'typescript', source: 'dev_dependencies' }], '/workspace');

        const infos = filter_recorded_messages(logger_handle.current(), 'info');
        expect(infos.some((message) => message.includes('Installing tool: typescript'))).toBe(true);
    });

    it('logs a warning when an individual package install fails but continues the loop', () => {
        mocked_exec_container.mockImplementation((_name, command) => {
            if (command.includes('typescript') && command[0] === 'npm') {
                throw new Error('registry timeout');
            }
            return '';
        });

        install_npm_packages('container-x', [
            { type: 'npm_package', package: 'typescript', source: 'dev_dependencies' },
            { type: 'npm_package', package: 'eslint', source: 'dev_dependencies' },
        ], '/workspace');

        const warnings = filter_recorded_messages(logger_handle.current(), 'warn');
        expect(warnings.some((message) => message.includes('failed to install typescript'))).toBe(true);
        const command_sequence = mocked_exec_container.mock.calls.map((call) => call[1].join(' '));
        // The second package was still attempted.
        expect(command_sequence.some((c) => c.includes('npm install -g eslint'))).toBe(true);
    });

    it('swallows a failure on the trailing git checkpoint commit (non-essential)', () => {
        let call_index = 0;
        mocked_exec_container.mockImplementation((_name, command) => {
            call_index++;
            if (command.join(' ').includes('commit -m tools')) {
                throw new Error('git commit failed');
            }
            return '';
        });

        // Should not throw despite the trailing commit failing.
        expect(() =>
            install_npm_packages('container-x', [{ type: 'npm_package', package: 'typescript', source: 'dev_dependencies' }], '/workspace'),
        ).not.toThrow();
        expect(call_index).toBeGreaterThan(0);
    });
});

describe('copy_multi_source_files', () => {
    let source_directory_a: string;
    let source_directory_b: string;

    beforeEach(() => {
        mocked_exec_container.mockReset();
        mocked_copy_to_container.mockReset();
        source_directory_a = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-copy-src-a-')));
        source_directory_b = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-copy-src-b-')));
    });

    afterEach(() => {
        fs.rmSync(source_directory_a, { recursive: true, force: true });
        fs.rmSync(source_directory_b, { recursive: true, force: true });
    });

    it('wipes the workspace, mkdir -ps the per-source target, and copies the staging directory in', () => {
        fs.writeFileSync(path.join(source_directory_a, 'app.ts'), 'export {};\n');
        const sources = [make_source({
            host_path: source_directory_a,
            repository_root: source_directory_a,
            source_prefix: 'app',
            mount_name: 'app',
        })];

        copy_multi_source_files('container-x', sources, undefined, '/workspace');

        const command_sequence = mocked_exec_container.mock.calls.map((call) => call[1].join(' '));
        // prepare_workspace — single sh -c with the workspace path as positional $1
        expect(command_sequence[0]).toBe('sh -c rm -rf "$1" && mkdir -p "$1" sh /workspace');
        // mkdir -p for the source's mount path
        expect(command_sequence.some((c) => c.includes('mkdir -p /workspace/app'))).toBe(true);
        expect(mocked_copy_to_container).toHaveBeenCalled();
        const [_container_name, _source_argument, destination_argument] = mocked_copy_to_container.mock.calls[0];
        expect(destination_argument).toBe('/workspace/app');
    });

    it('copies to the workspace root when mount_name is empty', () => {
        fs.writeFileSync(path.join(source_directory_a, 'app.ts'), 'export {};\n');
        const sources = [make_source({
            host_path: source_directory_a,
            repository_root: source_directory_a,
            source_prefix: '',
            mount_name: '',
        })];

        copy_multi_source_files('container-x', sources, undefined, '/workspace');

        expect(mocked_copy_to_container).toHaveBeenCalled();
        const [_container_name, _source_argument, destination_argument] = mocked_copy_to_container.mock.calls[0];
        expect(destination_argument).toBe('/workspace');
    });

    it('skips a source whose host path is empty (no files matched)', () => {
        // source_directory_b is empty (no files written into it).
        const sources = [make_source({
            host_path: source_directory_b,
            repository_root: source_directory_b,
            source_prefix: 'empty',
            mount_name: 'empty',
        })];

        copy_multi_source_files('container-x', sources, undefined, '/workspace');

        // prepare_workspace still ran; no copy_to_container though.
        expect(mocked_exec_container).toHaveBeenCalled();
        expect(mocked_copy_to_container).not.toHaveBeenCalled();
    });

    it('respects include globs (and skips files not matching)', () => {
        fs.writeFileSync(path.join(source_directory_a, 'app.ts'), 'ts');
        fs.writeFileSync(path.join(source_directory_a, 'README.md'), 'md');
        const sources = [make_source({
            host_path: source_directory_a,
            repository_root: source_directory_a,
            source_prefix: '',
            mount_name: '',
        })];

        const staged_snapshots = capture_staged_files();
        copy_multi_source_files('container-x', sources, { include: ['*.ts'] }, '/workspace');

        expect(mocked_copy_to_container).toHaveBeenCalled();
        // Snapshot taken inside the copy mock, so the staging directory is real:
        // only app.ts matched the include glob; README.md must not be staged.
        expect(staged_snapshots).toHaveLength(1);
        expect(staged_snapshots[0]).toContain('app.ts');
        expect(staged_snapshots[0]).not.toContain('README.md');
    });
});

describe('copy_multi_source_files — secret excludes (production resolve_files path)', () => {
    // These drive the REAL `resolve_files` composition inside
    // `copy_multi_source_files` (DEFAULT_SECRET_EXCLUDES + user-exclude merge +
    // the include_secret_files opt-out) over an on-disk fixture, then snapshot
    // the staging directory the copy actually received. The older suite only
    // exercised glob's own `ignore` option from the test itself, so a
    // regression in the production merge (e.g. user excludes replacing the
    // defaults, or an inverted opt-out flag) would have leaked secrets while
    // staying green.
    let source_directory: string;

    function build_fixture(): void {
        // Secrets that must NOT be staged by default.
        fs.writeFileSync(path.join(source_directory, '.env'), 'API_KEY=top-secret');
        fs.writeFileSync(path.join(source_directory, 'server.pem'), 'PRIVATE');
        fs.mkdirSync(path.join(source_directory, '.ssh'));
        fs.writeFileSync(path.join(source_directory, '.ssh', 'id_rsa'), 'PRIVATE');
        // Ordinary files that must be staged.
        fs.writeFileSync(path.join(source_directory, 'app.ts'), 'const x = 1;\n');
        fs.writeFileSync(path.join(source_directory, 'README.md'), '# project');
    }

    function single_source(): Source_Specification[] {
        return [make_source({
            host_path: source_directory,
            repository_root: source_directory,
            source_prefix: '',
            mount_name: '',
        })];
    }

    beforeEach(() => {
        mocked_exec_container.mockReset();
        mocked_copy_to_container.mockReset();
        source_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-secret-stg-')));
        build_fixture();
    });

    afterEach(() => {
        fs.rmSync(source_directory, { recursive: true, force: true });
    });

    it('excludes .env / *.pem / .ssh by default while staging ordinary files', () => {
        const staged_snapshots = capture_staged_files();
        copy_multi_source_files('container-x', single_source(), undefined, '/workspace');

        expect(staged_snapshots).toHaveLength(1);
        const staged = staged_snapshots[0];
        expect(staged).toContain('app.ts');
        expect(staged).toContain('README.md');
        expect(staged).not.toContain('.env');
        expect(staged).not.toContain('server.pem');
        expect(staged).not.toContain('.ssh/id_rsa');
    });

    it('still applies the secret defaults when the user also supplies an exclude (merge, not replace)', () => {
        const staged_snapshots = capture_staged_files();
        copy_multi_source_files(
            'container-x',
            single_source(),
            { exclude: ['**/README.md'] },
            '/workspace',
        );

        expect(staged_snapshots).toHaveLength(1);
        const staged = staged_snapshots[0];
        // User exclude honored...
        expect(staged).not.toContain('README.md');
        // ...and the secret defaults are NOT dropped by the presence of a user exclude.
        expect(staged).not.toContain('.env');
        expect(staged).not.toContain('.ssh/id_rsa');
        expect(staged).toContain('app.ts');
    });

    it('opts out of the secret defaults when include_secret_files is true', () => {
        const staged_snapshots = capture_staged_files();
        copy_multi_source_files(
            'container-x',
            single_source(),
            { include_secret_files: true },
            '/workspace',
        );

        expect(staged_snapshots).toHaveLength(1);
        const staged = staged_snapshots[0];
        expect(staged).toContain('.env');
        expect(staged).toContain('server.pem');
        expect(staged).toContain('.ssh/id_rsa');
    });
});

describe('overlay_multi_source_host_files', () => {
    let source_directory: string;
    let staging_directory: string;

    beforeEach(() => {
        source_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-overlay-src-')));
        staging_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-overlay-stg-')));
    });

    afterEach(() => {
        fs.rmSync(source_directory, { recursive: true, force: true });
        fs.rmSync(staging_directory, { recursive: true, force: true });
    });

    it('stages a host file that is not already at a branch-tracked path', () => {
        fs.writeFileSync(path.join(source_directory, 'host_only.txt'), 'host content');
        const sources = [make_source({
            host_path: source_directory,
            repository_root: source_directory,
            source_prefix: '',
            mount_name: '',
        })];

        overlay_multi_source_host_files(sources, staging_directory, undefined, undefined, new Set());

        expect(fs.readFileSync(path.join(staging_directory, 'host_only.txt'), 'utf-8')).toBe('host content');
    });

    it('skips files whose mount-relative path appears in the branch_files set', () => {
        fs.writeFileSync(path.join(source_directory, 'branch_owned.txt'), 'host version');
        const sources = [make_source({
            host_path: source_directory,
            repository_root: source_directory,
            source_prefix: '',
            mount_name: '',
        })];

        overlay_multi_source_host_files(
            sources,
            staging_directory,
            undefined,
            undefined,
            new Set(['branch_owned.txt']),
        );

        expect(fs.existsSync(path.join(staging_directory, 'branch_owned.txt'))).toBe(false);
    });

    it('skips a source whose host_path does not exist', () => {
        const sources = [make_source({
            host_path: path.join(source_directory, 'does-not-exist'),
            repository_root: source_directory,
            source_prefix: '',
            mount_name: '',
        })];

        overlay_multi_source_host_files(sources, staging_directory, undefined, undefined, new Set());

        expect(fs.readdirSync(staging_directory)).toEqual([]);
    });

    it('does not overwrite a file already present at the destination', () => {
        fs.writeFileSync(path.join(source_directory, 'shared.txt'), 'host content');
        fs.writeFileSync(path.join(staging_directory, 'shared.txt'), 'pre-existing');
        const sources = [make_source({
            host_path: source_directory,
            repository_root: source_directory,
            source_prefix: '',
            mount_name: '',
        })];

        overlay_multi_source_host_files(sources, staging_directory, undefined, undefined, new Set());

        expect(fs.readFileSync(path.join(staging_directory, 'shared.txt'), 'utf-8')).toBe('pre-existing');
    });

    it('puts files under the mount_name subdirectory when mount_name is non-empty', () => {
        fs.writeFileSync(path.join(source_directory, 'host_only.txt'), 'host');
        const sources = [make_source({
            host_path: source_directory,
            repository_root: source_directory,
            source_prefix: 'app',
            mount_name: 'app',
        })];

        overlay_multi_source_host_files(sources, staging_directory, undefined, undefined, new Set());

        expect(fs.readFileSync(path.join(staging_directory, 'app', 'host_only.txt'), 'utf-8')).toBe('host');
    });

    it('checks branch_files via the mount-name-relative key when mount_name is non-empty', () => {
        fs.writeFileSync(path.join(source_directory, 'tracked.txt'), 'host');
        const sources = [make_source({
            host_path: source_directory,
            repository_root: source_directory,
            source_prefix: 'app',
            mount_name: 'app',
        })];

        // The branch lists the file at its mount-relative path ('app/tracked.txt').
        overlay_multi_source_host_files(
            sources,
            staging_directory,
            undefined,
            undefined,
            new Set(['app/tracked.txt']),
        );

        expect(fs.existsSync(path.join(staging_directory, 'app', 'tracked.txt'))).toBe(false);
    });
});

describe('overlay_multi_source_host_files (symlink staging)', () => {
    const logger_handle = install_recording_logger_hooks();
    let source_directory: string;
    let staging_directory: string;

    beforeEach(() => {
        source_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-symlink-src-')));
        staging_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-symlink-stg-')));
    });

    afterEach(() => {
        fs.rmSync(source_directory, { recursive: true, force: true });
        fs.rmSync(staging_directory, { recursive: true, force: true });
    });

    function try_create_symlink(link_path: string, target: string): boolean {
        try {
            fs.symlinkSync(target, link_path);
            return true;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            return !(code === 'EPERM' || code === 'ENOTSUP');
        }
    }

    it('emits a warning and skips a symlink whose target escapes the source root', () => {
        const link_path = path.join(source_directory, 'escape');
        if (!try_create_symlink(link_path, '/etc/passwd')) {
            return;
        }
        const sources = [make_source({
            host_path: source_directory,
            repository_root: source_directory,
            source_prefix: '',
            mount_name: '',
        })];

        overlay_multi_source_host_files(sources, staging_directory, undefined, undefined, new Set());

        expect(fs.existsSync(path.join(staging_directory, 'escape'))).toBe(false);
        const warnings = filter_recorded_messages(logger_handle.current(), 'warn');
        expect(warnings.some((message) => message.includes('outside the source tree'))).toBe(true);
    });

    it('stages a symlink whose target stays within the source root', () => {
        fs.writeFileSync(path.join(source_directory, 'target.txt'), 'target');
        const link_path = path.join(source_directory, 'good');
        if (!try_create_symlink(link_path, './target.txt')) {
            return;
        }
        const sources = [make_source({
            host_path: source_directory,
            repository_root: source_directory,
            source_prefix: '',
            mount_name: '',
        })];

        overlay_multi_source_host_files(sources, staging_directory, undefined, undefined, new Set());

        // Either staged as a real symlink or dereferenced into a regular file with the
        // target's content — both contracts of `copy_symlink_with_dereference_fallback`.
        const staged = path.join(staging_directory, 'good');
        expect(fs.existsSync(staged)).toBe(true);
    });
});

describe('configure_composer_path_repositories', () => {
    const logger_handle = install_recording_logger_hooks();
    let source_directory_a: string;
    let source_directory_b: string;

    beforeEach(() => {
        mocked_exec_container.mockReset();
        mocked_exec_container.mockReturnValue('');
        source_directory_a = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-composer-a-'))
        );
        source_directory_b = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-composer-b-'))
        );
    });

    afterEach(() => {
        fs.rmSync(source_directory_a, { recursive: true, force: true });
        fs.rmSync(source_directory_b, { recursive: true, force: true });
    });

    it('makes no exec calls when no source has a composer.json', () => {
        configure_composer_path_repositories('container-x', [
            make_source({ host_path: source_directory_a, mount_name: 'a' }),
            make_source({ host_path: source_directory_b, mount_name: 'b' }),
        ], '/workspace');

        expect(mocked_exec_container).not.toHaveBeenCalled();
    });

    it('makes no exec calls when no composer.json declares a name', () => {
        fs.writeFileSync(
            path.join(source_directory_a, 'composer.json'),
            JSON.stringify({ description: 'no name field' }),
        );
        fs.writeFileSync(
            path.join(source_directory_b, 'composer.json'),
            JSON.stringify({ require: { 'some/package': '*' } }),
        );

        configure_composer_path_repositories('container-x', [
            make_source({ host_path: source_directory_a, mount_name: 'a' }),
            make_source({ host_path: source_directory_b, mount_name: 'b' }),
        ], '/workspace');

        expect(mocked_exec_container).not.toHaveBeenCalled();
    });

    it('makes no exec calls when local packages are declared but none are required', () => {
        fs.writeFileSync(
            path.join(source_directory_a, 'composer.json'),
            JSON.stringify({ name: 'my/library' }),
        );
        fs.writeFileSync(
            path.join(source_directory_b, 'composer.json'),
            JSON.stringify({ name: 'my/app', require: { 'other/package': '^1.0' } }),
        );

        configure_composer_path_repositories('container-x', [
            make_source({ host_path: source_directory_a, mount_name: 'library' }),
            make_source({ host_path: source_directory_b, mount_name: 'app' }),
        ], '/workspace');

        expect(mocked_exec_container).not.toHaveBeenCalled();
    });

    it('calls composer config when a require entry matches a local source name', () => {
        fs.writeFileSync(
            path.join(source_directory_a, 'composer.json'),
            JSON.stringify({ name: 'my/library' }),
        );
        fs.writeFileSync(
            path.join(source_directory_b, 'composer.json'),
            JSON.stringify({ name: 'my/app', require: { 'my/library': '^1.0' } }),
        );

        configure_composer_path_repositories('container-x', [
            make_source({ host_path: source_directory_a, mount_name: 'library' }),
            make_source({ host_path: source_directory_b, mount_name: 'app' }),
        ], '/workspace');

        expect(mocked_exec_container).toHaveBeenCalledOnce();
        const [container_name, command] = mocked_exec_container.mock.calls[0];
        expect(container_name).toBe('container-x');
        expect(command[0]).toBe('composer');
        expect(command[1]).toBe('config');
        expect(command[2]).toBe('--global');
        expect(command[3]).toBe('repositories.my/library');
        expect(command[4]).toBe(JSON.stringify({ type: 'path', url: '/workspace/library' }));
        expect(command).toContain('--json');
    });

    it('calls composer config when a require-dev entry matches a local source name', () => {
        fs.writeFileSync(
            path.join(source_directory_a, 'composer.json'),
            JSON.stringify({ name: 'my/test-helpers' }),
        );
        fs.writeFileSync(
            path.join(source_directory_b, 'composer.json'),
            JSON.stringify({ name: 'my/app', 'require-dev': { 'my/test-helpers': 'dev-main' } }),
        );

        configure_composer_path_repositories('container-x', [
            make_source({ host_path: source_directory_a, mount_name: 'test-helpers' }),
            make_source({ host_path: source_directory_b, mount_name: 'app' }),
        ], '/workspace');

        expect(mocked_exec_container).toHaveBeenCalledOnce();
        const [, command] = mocked_exec_container.mock.calls[0];
        expect(command[3]).toBe('repositories.my/test-helpers');
    });

    it('uses the working_directory directly when mount_name is empty', () => {
        fs.writeFileSync(
            path.join(source_directory_a, 'composer.json'),
            JSON.stringify({ name: 'my/library' }),
        );
        fs.writeFileSync(
            path.join(source_directory_b, 'composer.json'),
            JSON.stringify({ require: { 'my/library': '*' } }),
        );

        configure_composer_path_repositories('container-x', [
            make_source({ host_path: source_directory_a, mount_name: '' }),
            make_source({ host_path: source_directory_b, mount_name: '' }),
        ], '/workspace');

        const [, command] = mocked_exec_container.mock.calls[0];
        expect(command[4]).toBe(JSON.stringify({ type: 'path', url: '/workspace' }));
    });

    it('emits an info message for each configured repository', () => {
        fs.writeFileSync(
            path.join(source_directory_a, 'composer.json'),
            JSON.stringify({ name: 'my/library' }),
        );
        fs.writeFileSync(
            path.join(source_directory_b, 'composer.json'),
            JSON.stringify({ require: { 'my/library': '*' } }),
        );

        configure_composer_path_repositories('container-x', [
            make_source({ host_path: source_directory_a, mount_name: 'library' }),
            make_source({ host_path: source_directory_b, mount_name: 'app' }),
        ], '/workspace');

        const infos = filter_recorded_messages(logger_handle.current(), 'info');
        expect(infos.some((message) => message.includes('my/library'))).toBe(true);
    });

    it('emits a warning and continues when composer config fails', () => {
        fs.writeFileSync(
            path.join(source_directory_a, 'composer.json'),
            JSON.stringify({ name: 'my/library' }),
        );
        fs.writeFileSync(
            path.join(source_directory_b, 'composer.json'),
            JSON.stringify({ require: { 'my/library': '*' } }),
        );
        mocked_exec_container.mockImplementation(() => {
            throw new Error('composer not found');
        });

        expect(() => configure_composer_path_repositories('container-x', [
            make_source({ host_path: source_directory_a, mount_name: 'library' }),
            make_source({ host_path: source_directory_b, mount_name: 'app' }),
        ], '/workspace')).not.toThrow();

        const warnings = filter_recorded_messages(logger_handle.current(), 'warn');
        expect(warnings.some((message) => message.includes('my/library'))).toBe(true);
    });

    it('silently skips a source whose composer.json contains invalid JSON', () => {
        fs.writeFileSync(path.join(source_directory_a, 'composer.json'), 'not valid json {{{');
        fs.writeFileSync(
            path.join(source_directory_b, 'composer.json'),
            JSON.stringify({ require: { 'my/library': '*' } }),
        );

        configure_composer_path_repositories('container-x', [
            make_source({ host_path: source_directory_a, mount_name: 'library' }),
            make_source({ host_path: source_directory_b, mount_name: 'app' }),
        ], '/workspace');

        expect(mocked_exec_container).not.toHaveBeenCalled();
    });

    it('configures path repositories for multiple matched packages', () => {
        fs.writeFileSync(
            path.join(source_directory_a, 'composer.json'),
            JSON.stringify({ name: 'my/library-one' }),
        );
        fs.writeFileSync(
            path.join(source_directory_b, 'composer.json'),
            JSON.stringify({ name: 'my/library-two' }),
        );
        const source_directory_c = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-composer-c-'))
        );
        try {
            fs.writeFileSync(
                path.join(source_directory_c, 'composer.json'),
                JSON.stringify({ require: { 'my/library-one': '*', 'my/library-two': '*' } }),
            );

            configure_composer_path_repositories('container-x', [
                make_source({ host_path: source_directory_a, mount_name: 'lib-one' }),
                make_source({ host_path: source_directory_b, mount_name: 'lib-two' }),
                make_source({ host_path: source_directory_c, mount_name: 'app' }),
            ], '/workspace');

            expect(mocked_exec_container).toHaveBeenCalledTimes(2);
            const configured = mocked_exec_container.mock.calls.map((call) => call[1][3]);
            expect(configured).toContain('repositories.my/library-one');
            expect(configured).toContain('repositories.my/library-two');
        } finally {
            fs.rmSync(source_directory_c, { recursive: true, force: true });
        }
    });
});
