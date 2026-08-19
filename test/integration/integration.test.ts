import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { create_sandbox_from_directory, TEST_CONTAINER_WORKING_DIR } from '../test_helpers.js';
import { DEFAULT_TEST_TOOL, write_default_test_tool_manifest_to_home } from '../helpers/stub_tool_provider.js';
import { cli_subprocess_env } from '../helpers/home_directory.js';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { destroy_sandbox } from '../../src/sandbox/index.js';
import { diff_sandbox } from '../../src/changes.js';
import { generate_patch } from '../../src/patches.js';
import { apply_patch } from '../../src/apply.js';
import { exec_container } from '../../src/container_runtime.js';
import { assert_present } from '../helpers/assert_present.js';

// NOTE: Do not remove shared images (patchlab/node-22-slim:*) in afterAll —
// other test files and the sandbox itself may depend on them.
// Container cleanup happens in each test's afterEach via destroy_sandbox.

describe('full round-trip (API)', () => {
    let source_directory: string;
    let sandbox_id: string;
    let container_name: string;
    const cwd = TEST_CONTAINER_WORKING_DIR;

    beforeEach(async () => {
        source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-rt-'));
        fs.writeFileSync(path.join(source_directory, 'index.ts'), 'export const version = "1.0";\n');
        fs.mkdirSync(path.join(source_directory, 'lib'));
        fs.writeFileSync(path.join(source_directory, 'lib', 'utils.ts'), 'export function add(a: number, b: number) { return a + b; }\n');

        // Init source as a git repo with clean working tree so create_sandbox accepts it
        execFileSync('git', ['init'], { cwd: source_directory, stdio: 'pipe' });
        execFileSync('git', ['add', '-A'], { cwd: source_directory, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'init'], {
            cwd: source_directory, stdio: 'pipe',
            env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' },
        });

        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        sandbox_id = manifest.id;
        container_name = manifest.container_name;
    });

    afterEach(async () => {
        await destroy_sandbox(sandbox_id, { force: true });
        fs.rmSync(source_directory, { recursive: true, force: true });
    });

    it('create → edit → patch → apply round-trip matches expectations', () => {
        // Edit files inside sandbox
        exec_container(container_name, ['sh', '-c', 'printf \'export const version = "2.0";\n\' > index.ts'], { cwd });
        exec_container(container_name, ['sh', '-c', "echo 'export function sub(a: number, b: number) { return a - b; }' >> lib/utils.ts"], { cwd });
        exec_container(container_name, ['sh', '-c', "echo '# README' > README.md"], { cwd });

        // Verify diff picks up all changes
        const changes = diff_sandbox(sandbox_id);
        const paths = changes.map((c) => c.relative_path).sort((a, b) => a.localeCompare(b));
        expect(paths).toContain('index.ts');
        expect(paths).toContain('lib/utils.ts');
        expect(paths).toContain('README.md');

        // Generate patch and apply back to source
        const patch = generate_patch(sandbox_id);
        expect(patch).not.toBe('');

        const result = apply_patch(source_directory, patch);
        expect(result.success).toBe(true);

        // Verify source matches expectations
        expect(fs.readFileSync(path.join(source_directory, 'index.ts'), 'utf-8')).toBe(
            'export const version = "2.0";\n'
        );
        const utils = fs.readFileSync(path.join(source_directory, 'lib', 'utils.ts'), 'utf-8');
        expect(utils).toContain('sub(a: number, b: number)');
        expect(fs.readFileSync(path.join(source_directory, 'README.md'), 'utf-8')).toBe(
            '# README\n'
        );
    });

    it('round-trip with file deletion', () => {
        exec_container(container_name, ['rm', 'lib/utils.ts'], { cwd });
        const patch = generate_patch(sandbox_id);
        const result = apply_patch(source_directory, patch);
        expect(result.success).toBe(true);
        expect(fs.existsSync(path.join(source_directory, 'lib', 'utils.ts'))).toBe(false);
    });
});

describe('CLI round-trip', () => {
    let source_directory: string;
    let home_directory: string;
    let sandbox_id: string;

    /**
     * Run a CLI subcommand and return its COMBINED stdout+stderr. The
     * caller's assertions match against text that may land on either
     * channel: `Sandbox created: <id>` and other action confirmations are
     * intentionally routed to stderr per the patchlab output-channels
     * convention (see README's "Output channels" section), while
     * `patchlab patch` / `patchlab diff` / `patchlab list` etc. emit their
     * pipeable results on stdout. Capturing both keeps this single
     * integration test agnostic to the stdout/stderr split.
     */
    function run_cli(...args: string[]): string {
        const result = spawnSync(
            'node',
            [path.resolve(__dirname, '..', '..', 'dist', 'cli.js'), ...args],
            {
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 300000,
                encoding: 'utf-8',
                env: cli_subprocess_env(home_directory),
            },
        );
        if (result.status !== 0) {
            throw new Error(
                `CLI exited with status ${result.status}: ${(result.stderr ?? '').trim()}`,
            );
        }

        return `${result.stdout ?? ''}${result.stderr ?? ''}`;
    }

    beforeEach(() => {
        home_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cli-home-'));
        write_default_test_tool_manifest_to_home(home_directory);

        source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cli-'));
        fs.writeFileSync(path.join(source_directory, 'app.js'), "console.log('hello');\n");

        // Init as git repo for apply to work
        execFileSync('git', ['init'], { cwd: source_directory, stdio: 'pipe' });
        execFileSync('git', ['add', '-A'], { cwd: source_directory, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'init'], { cwd: source_directory, stdio: 'pipe' });
    });

    afterEach(() => {
        if (sandbox_id) {
            try {
                run_cli('destroy', sandbox_id);
            } catch {
                // ignore
            }
        }
        fs.rmSync(source_directory, { recursive: true, force: true });
        fs.rmSync(home_directory, { recursive: true, force: true });
    });

    it('create → exec → diff → patch → apply via CLI', () => {
        // Create
        const create_output = run_cli('create', source_directory, '--tool', DEFAULT_TEST_TOOL, '--image', 'node:22-slim', '--no-install', '--deny-socket-mount', '--no-interactive', '--allow-untrusted-manifests');
        const id_match = /Patchlab created: (.+)/.exec(create_output);
        assert_present(id_match);
        sandbox_id = id_match[1].trim();

        // Exec a modification (-- stops Commander from parsing -c as its own flag)
        run_cli('exec', sandbox_id, '--', 'sh', '-c', `echo "console.log('goodbye');" > ${TEST_CONTAINER_WORKING_DIR}/app.js`);

        // Diff
        const diff_output = run_cli('diff', sandbox_id);
        expect(diff_output).toContain('app.js');

        // Patch to file
        const patch_path = path.join(os.tmpdir(), `patchlab-cli-test-${Date.now()}.patch`);
        try {
            run_cli('patch', sandbox_id, '-o', patch_path);
            expect(fs.existsSync(patch_path)).toBe(true);

            // Apply the captured patch to the source tree via git. The
            // `patchlab apply <patchlab>` CLI command applies the patchlab
            // BRANCH onto the current git branch (cherry-pick/merge), which
            // is a different operation than what this test exercises —
            // here we are validating that the bytes captured by
            // `patchlab patch` are themselves a valid unified diff that
            // applies cleanly against the tree at the source's baseline.
            execFileSync('git', ['apply', patch_path], { cwd: source_directory, stdio: 'pipe' });

            // Verify file changed
            expect(fs.readFileSync(path.join(source_directory, 'app.js'), 'utf-8').trim()).toBe(
                "console.log('goodbye');"
            );
        } finally {
            try {
                fs.unlinkSync(patch_path);
            } catch {
                // ignore
            }
        }
    });
});

describe('edge cases', () => {
    let source_directory: string;
    let sandbox_id: string;
    let container_name: string;
    const cwd = TEST_CONTAINER_WORKING_DIR;

    function commit_clean(repo: string): void {
        execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'edge', '--allow-empty'], {
            cwd: repo, stdio: 'pipe',
            env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' },
        });
    }

    beforeEach(() => {
        source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-edge-'));
        execFileSync('git', ['init'], { cwd: source_directory, stdio: 'pipe' });
    });

    afterEach(async () => {
        if (sandbox_id) {
            await destroy_sandbox(sandbox_id, { force: true });
        }
        fs.rmSync(source_directory, { recursive: true, force: true });
    });

    it('.gitignore is respected during diff and patch generation', async () => {
        fs.writeFileSync(path.join(source_directory, 'code.ts'), 'const x = 1;\n');
        fs.writeFileSync(path.join(source_directory, '.gitignore'), '*.log\nbuild/\n');
        commit_clean(source_directory);

        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        sandbox_id = manifest.id;
        container_name = manifest.container_name;

        // Create ignored and non-ignored files
        exec_container(container_name, ['sh', '-c', "echo 'debug info' > debug.log"], { cwd });
        exec_container(container_name, ['mkdir', '-p', 'build'], { cwd });
        exec_container(container_name, ['sh', '-c', "echo 'compiled' > build/out.js"], { cwd });
        exec_container(container_name, ['sh', '-c', "echo 'new source' > feature.ts"], { cwd });

        // Diff should exclude .gitignore'd files
        const changes = diff_sandbox(sandbox_id);
        const changed_paths = changes.map((c) => c.relative_path);
        expect(changed_paths).toContain('feature.ts');
        expect(changed_paths).not.toContain('debug.log');
        expect(changed_paths).not.toContain('build/out.js');

        // Patch should also exclude them
        const patch = generate_patch(sandbox_id);
        expect(patch).toContain('feature.ts');
        expect(patch).not.toContain('debug.log');
        expect(patch).not.toContain('build/out.js');
    });

    // `partial failure when source has diverged` moved to
    // `test/unit/apply.test.ts`. The subject under test (`apply_patch`'s
    // honest-partial-reporting contract) is host-side; the sandbox was
    // fixture overhead. The move surfaced and drove a corresponding fix in
    // `src/apply.ts`: the file now splits multi-file patches on
    // `diff --git ` boundaries and applies each block independently, so
    // `git apply`'s default all-or-nothing rollback no longer leaks across
    // files. See
    // [documents/testing-strategy.md](../../documents/testing-strategy.md)
    // "Preserving load-bearing assertions across moves" for the discipline
    // that drove this.

    it('binary files in sandbox surface as appliable GIT binary patches', async () => {
        fs.writeFileSync(path.join(source_directory, 'code.ts'), 'const x = 1;\n');
        // `-text` marks *.png as binary-safe (no line-ending conversion) without
        // setting `-diff`. Using `binary` (which implies `-diff`) would prevent
        // git from generating the GIT binary patch that `git apply` needs;
        // the patch would degrade to a "Binary files ... differ" marker that
        // `git apply --index` silently skips, causing image.png to disappear
        // from the cumulative patch entirely.
        fs.writeFileSync(path.join(source_directory, '.gitattributes'), '*.png -text\n');
        commit_clean(source_directory);

        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        sandbox_id = manifest.id;
        container_name = manifest.container_name;

        // Create a binary file inside the container. Octal escapes are used
        // because dash (POSIX sh) does not expand \xHH hex escapes in printf.
        // \211=0x89 (PNG magic), \032=0x1A, \000=NUL (NUL signals binary to git).
        exec_container(container_name, [
            'sh', '-c',
            String.raw`printf '\211PNG\r\n\032\n\000\000\000\rIHDR' > image.png`,
        ], { cwd });

        // Also modify a text file
        exec_container(container_name, ['sh', '-c', "echo 'const x = 2;' > code.ts"], { cwd });

        const patch = generate_patch(sandbox_id);
        // Text change should be present
        expect(patch).toContain('code.ts');
        // Binary files MUST surface in the patch as a GIT binary patch — silently
        // dropping them would leave the user without any signal that a new binary
        // file existed in their sandbox. A regression that omitted binaries
        // entirely would pass the old conditional `if (patch.includes(...))`
        // check (both arms were vacuously true); these assertions are unconditional.
        expect(patch).toContain('image.png');
        expect(patch).toMatch(/GIT binary patch/);
        // Raw PNG header bytes (e.g., "\x89PNG") MUST NOT leak into the patch
        // text — binary content is base85-encoded, so raw bytes never appear.
        expect(patch).not.toMatch(/\x89PNG/);
    });
});

describe('container isolation', () => {
    let source_directory: string;
    let sandbox_id: string;
    let container_name: string;
    const cwd = TEST_CONTAINER_WORKING_DIR;

    beforeEach(async () => {
        source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-iso-'));
        execFileSync('git', ['init'], { cwd: source_directory, stdio: 'pipe' });
        fs.writeFileSync(path.join(source_directory, 'original.txt'), 'do not change\n');
        execFileSync('git', ['add', '-A'], { cwd: source_directory, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'init'], {
            cwd: source_directory, stdio: 'pipe',
            env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' },
        });

        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        sandbox_id = manifest.id;
        container_name = manifest.container_name;
    });

    afterEach(async () => {
        await destroy_sandbox(sandbox_id, { force: true });
        fs.rmSync(source_directory, { recursive: true, force: true });
    });

    it('edits inside container do not leak to host until apply', () => {
        // Modify files inside container
        exec_container(container_name, ['sh', '-c', "echo 'modified in container' > original.txt"], { cwd });
        exec_container(container_name, ['sh', '-c', "echo 'new file' > added.txt"], { cwd });

        // Host should be unaffected
        expect(fs.readFileSync(path.join(source_directory, 'original.txt'), 'utf-8')).toBe('do not change\n');
        expect(fs.existsSync(path.join(source_directory, 'added.txt'))).toBe(false);
    });

    it('only apply transfers changes to host', () => {
        // Source already initialized in beforeEach.
        exec_container(container_name, ['sh', '-c', "echo 'updated' > original.txt"], { cwd });

        // Before apply — host unchanged
        expect(fs.readFileSync(path.join(source_directory, 'original.txt'), 'utf-8')).toBe('do not change\n');

        // Generate and apply
        const patch = generate_patch(sandbox_id);
        const result = apply_patch(source_directory, patch);
        expect(result.success).toBe(true);

        // After apply — host updated
        expect(fs.readFileSync(path.join(source_directory, 'original.txt'), 'utf-8')).toBe('updated\n');
    });
});

// All three `code generator workflow` tests run on the same minimal source
// (a single `template.txt`) and exercise the same exec → diff → generate →
// apply chain. They share one `beforeAll` sandbox; `afterEach` runs
// `git reset --hard HEAD && git clean -fd` on BOTH the in-container working
// tree AND the host source_directory so the next test starts from baseline.
// The reset on both sides is load-bearing: tests 1 and 3 both touch
// `template.txt`, so without resetting the source after `apply_patch`,
// test 3's `sed 's/PLACEHOLDER/done/'` would no-op against the
// already-replaced content.
describe('code generator workflow', () => {
    let source_directory: string;
    let sandbox_id: string;
    let container_name: string;
    const cwd = TEST_CONTAINER_WORKING_DIR;

    beforeAll(async () => {
        source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-gen-'));
        fs.writeFileSync(path.join(source_directory, 'template.txt'), 'PLACEHOLDER\n');

        // Init as git repo with clean working tree
        execFileSync('git', ['init'], { cwd: source_directory, stdio: 'pipe' });
        execFileSync('git', ['add', '-A'], { cwd: source_directory, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'init'], {
            cwd: source_directory, stdio: 'pipe',
            env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' },
        });

        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        sandbox_id = manifest.id;
        container_name = manifest.container_name;
    }, 120_000);

    afterAll(async () => {
        await destroy_sandbox(sandbox_id, { force: true });
        fs.rmSync(source_directory, { recursive: true, force: true });
    });

    afterEach(() => {
        // Reset BOTH sides to baseline. The container's working tree gets
        // mutated by the test's exec; the source_directory gets mutated by
        // the test's `apply_patch`. Both need to be clean for the next test
        // (specifically: tests 1 and 3 both touch `template.txt`).
        exec_container(container_name, ['git', 'reset', '--hard', 'HEAD'], { cwd });
        exec_container(container_name, ['git', 'clean', '-fd'], { cwd });
        execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: source_directory, stdio: 'pipe' });
        execFileSync('git', ['clean', '-fd'], { cwd: source_directory, stdio: 'pipe' });
    });

    it('exec modifies files, then generates a clean patch', () => {
        // Simulate a code generator running inside the container
        exec_container(container_name, [
            'sh', '-c',
            "sed -i 's/PLACEHOLDER/Generated Content/' template.txt",
        ], { cwd });

        const changes = diff_sandbox(sandbox_id);
        expect(changes.length).toBe(1);
        expect(changes[0].relative_path).toBe('template.txt');
        expect(changes[0].type).toBe('modify');

        const patch = generate_patch(sandbox_id);
        expect(patch).toContain('Generated Content');
        expect(patch).toContain('PLACEHOLDER');

        // Apply and verify
        const result = apply_patch(source_directory, patch);
        expect(result.success).toBe(true);
        expect(fs.readFileSync(path.join(source_directory, 'template.txt'), 'utf-8')).toBe(
            'Generated Content\n'
        );
    });

    it('exec creates multiple files via script, extracts clean patch', () => {
        // Run a "code generator" script inside the container
        exec_container(container_name, [
            'sh', '-c',
            [
                'mkdir -p src',
                "echo 'export class Foo {}' > src/foo.ts",
                "echo 'export class Bar {}' > src/bar.ts",
                'echo \'export { Foo } from "./foo";\' > src/index.ts',
            ].join(' && '),
        ], { cwd });

        const changes = diff_sandbox(sandbox_id);
        const added = changes
            .filter((c) => c.type === 'add')
            .map((c) => c.relative_path)
            .sort((a, b) => a.localeCompare(b));
        expect(added).toEqual(['src/bar.ts', 'src/foo.ts', 'src/index.ts']);

        const patch = generate_patch(sandbox_id);
        expect(patch).toContain('src/foo.ts');
        expect(patch).toContain('src/bar.ts');
        expect(patch).toContain('src/index.ts');

        // Apply to source
        const result = apply_patch(source_directory, patch);
        expect(result.success).toBe(true);
        expect(fs.readFileSync(path.join(source_directory, 'src', 'foo.ts'), 'utf-8').trim()).toBe(
            'export class Foo {}'
        );
    });

    it('exec runs a command that both modifies and creates files', () => {
        // Modify existing + create new
        exec_container(container_name, [
            'sh', '-c',
            "sed -i 's/PLACEHOLDER/done/' template.txt && echo 'log' > output.txt",
        ], { cwd });

        const changes = diff_sandbox(sandbox_id);
        const by_path = new Map(changes.map((c) => [c.relative_path, c.type]));
        expect(by_path.get('template.txt')).toBe('modify');
        expect(by_path.get('output.txt')).toBe('add');

        const patch = generate_patch(sandbox_id);
        const result = apply_patch(source_directory, patch);
        expect(result.success).toBe(true);
        expect(fs.readFileSync(path.join(source_directory, 'template.txt'), 'utf-8')).toBe('done\n');
        expect(fs.readFileSync(path.join(source_directory, 'output.txt'), 'utf-8')).toBe('log\n');
    });
});
