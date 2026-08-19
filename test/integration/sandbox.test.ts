import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { create_sandbox_from_directory, TEST_CONTAINER_WORKING_DIR, TEST_IMAGE_HOME } from '../test_helpers.js';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
    list_sandboxes,
    inspect_sandbox,
    destroy_sandbox,
} from '../../src/sandbox/index.js';
import { build_archive_path } from '../../src/archive.js';
import {
    exec_container,
    container_exists,
} from '../../src/container_runtime.js';

function commit_all(repo: string): void {
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'initial', '--allow-empty'], {
        cwd: repo,
        env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' },
    });
}

describe('sandbox lifecycle', () => {
    let source_directory: string;
    const sandbox_ids: string[] = [];

    beforeEach(() => {
        source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-src-'));
        execFileSync('git', ['init'], { cwd: source_directory });
        fs.writeFileSync(path.join(source_directory, 'hello.txt'), 'hello world\n');
        fs.mkdirSync(path.join(source_directory, 'sub'));
        fs.writeFileSync(path.join(source_directory, 'sub', 'nested.txt'), 'nested\n');
        commit_all(source_directory);
    });

    afterEach(async () => {
        for (const id of sandbox_ids) {
            await destroy_sandbox(id, { force: true });
        }
        sandbox_ids.length = 0;
        fs.rmSync(source_directory, { recursive: true, force: true });
    });

    function track<T extends { id: string }>(manifest: T): T {
        sandbox_ids.push(manifest.id);
        return manifest;
    }

    // Six tests originally lived here that don't need podman:
    //   - `records repository_root and source_prefix for repo-root source`
    //     and `for subdirectory source` — DELETED as duplicates;
    //     `test/unit/sources.test.ts` already pins those field shapes via
    //     `resolve_source_inputs` directly.
    //   - `rejects source not in a git repository` and
    //     `throws for non-existent source directory` — MOVED to
    //     `test/unit/sources.test.ts` as `resolve_source_inputs` validator
    //     throws.
    //   - `throws when inspecting non-existent sandbox` and
    //     `destroy is idempotent` — MOVED to
    //     `test/unit/sandbox-lifecycle.test.ts` as pure manifest-lookup
    //     paths that catch podman absence gracefully.
    // See [documents/testing-strategy.md](../../documents/testing-strategy.md)
    // "Before moving a test, reconcile against existing coverage".

    // Three tests that were originally here (`creates a sandbox with files
    // in container`, `creates a git baseline in container`, `inspects a
    // sandbox`) moved to the `sandbox lifecycle — default-config read-only
    // inspections` describe block below. They share one `beforeAll`
    // sandbox there because all three are read-only probes of an
    // unmodified default-config sandbox.

    it('creates sandbox with include filter', async () => {
        const manifest = track(await create_sandbox_from_directory(source_directory, { include: ['*.txt'], no_install: true }));
        const name = manifest.container_name;

        const files = exec_container(name, ['find', TEST_CONTAINER_WORKING_DIR, '-name', '*.txt', '-not', '-path', '*/.git/*']);
        expect(files).toContain('hello.txt');
        expect(files).not.toContain('nested.txt');
    });

    it('creates sandbox with exclude filter', async () => {
        const manifest = track(await create_sandbox_from_directory(source_directory, { exclude: ['sub/**'], no_install: true }));
        const name = manifest.container_name;

        const ls = exec_container(name, ['ls', TEST_CONTAINER_WORKING_DIR]);
        expect(ls).toContain('hello.txt');
        expect(ls).not.toContain('sub');
    });

    it('lists sandboxes with container status', async () => {
        const m1 = track(await create_sandbox_from_directory(source_directory, { no_install: true }));
        const m2 = track(await create_sandbox_from_directory(source_directory, { no_install: true }));
        const list = list_sandboxes();
        const ids = list.map((s) => s.id);
        expect(ids).toContain(m1.id);
        expect(ids).toContain(m2.id);

        const s1 = list.find((s) => s.id === m1.id);
        expect(s1?.container_status).toBe('running');

        // After destroying m1, it must drop out of the list. A regression
        // that left stale entries (or marked a destroyed sandbox as still
        // running) would not be caught by the positive assertions above.
        // m1 is untracked from cleanup_ids manually since the destroy below
        // already handles it; the afterEach is best-effort on missing.
        sandbox_ids.splice(sandbox_ids.indexOf(m1.id), 1);
        await destroy_sandbox(m1.id, { force: true });

        const list_after = list_sandboxes();
        const ids_after = list_after.map((s) => s.id);
        expect(ids_after).not.toContain(m1.id);
        expect(ids_after).toContain(m2.id);
    }, 240_000);

    it('destroys a sandbox and its container', async () => {
        const manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        const name = manifest.container_name;
        const archive_directory = build_archive_path(manifest.id);
        // The archive must exist before destroy; otherwise the post-destroy
        // assertion below proves nothing.
        expect(fs.existsSync(archive_directory)).toBe(true);

        await destroy_sandbox(manifest.id, { force: true });
        expect(container_exists(name)).toBe(false);
        expect(() => inspect_sandbox(manifest.id)).toThrow('not found');
        // A regression that leaks archive files (sessions, manifest,
        // context, etc.) would leave the sandbox half-destroyed even though
        // the container is gone. Lock the on-disk cleanup contract too.
        expect(fs.existsSync(archive_directory)).toBe(false);
    });

    it('concurrent sandboxes are independent', async () => {
        const m1 = track(await create_sandbox_from_directory(source_directory, { no_install: true }));
        const m2 = track(await create_sandbox_from_directory(source_directory, { no_install: true }));

        // Modify a file in sandbox 1
        exec_container(m1.container_name, ['sh', '-c', `echo 'modified in s1' > ${TEST_CONTAINER_WORKING_DIR}/hello.txt`]);

        // Sandbox 2 should be unaffected
        const content_s2 = exec_container(m2.container_name, ['cat', `${TEST_CONTAINER_WORKING_DIR}/hello.txt`]);
        expect(content_s2.trim()).toBe('hello world');

        // Reverse direction: write in sandbox 2, read in sandbox 1. A
        // one-way isolation regression (e.g., a shared mount that propagated
        // s1 → s2 but not s2 → s1, or vice versa) would only show up under
        // this complementary check.
        exec_container(m2.container_name, ['sh', '-c', `echo 'modified in s2' > ${TEST_CONTAINER_WORKING_DIR}/sub/nested.txt`]);

        const content_s1 = exec_container(m1.container_name, ['cat', `${TEST_CONTAINER_WORKING_DIR}/sub/nested.txt`]);
        expect(content_s1.trim()).toBe('nested');
    });

    it('runs npm install in the container when no_install is not set (covers install_dependencies)', async () => {
        // Write a minimal package.json so `install_dependencies` takes the
        // `has_package_json` branch (no lockfile yet → `npm install`). Empty
        // dependencies keeps the test fast: `npm install` exits 0 and writes
        // `package-lock.json`, which is enough to prove the function ran.
        fs.writeFileSync(
            path.join(source_directory, 'package.json'),
            JSON.stringify({ name: 'patchlab-install-deps-fixture', version: '0.0.0' }),
        );
        commit_all(source_directory);

        // Note: omit `no_install` so the default (false) lets the install run.
        const manifest = track(await create_sandbox_from_directory(source_directory, {}));

        // `npm install` writes the lockfile inside the container.
        const lockfile_check = exec_container(
            manifest.container_name,
            ['sh', '-c', `test -f ${TEST_CONTAINER_WORKING_DIR}/package-lock.json && echo present || echo missing`],
        );
        expect(lockfile_check.trim()).toBe('present');

        // install_dependencies commits the install result on the container's
        // git baseline. The most recent commit message records the install.
        const last_commit_message = exec_container(
            manifest.container_name,
            ['git', '-C', TEST_CONTAINER_WORKING_DIR, 'log', '-1', '--pretty=%s'],
        );
        expect(last_commit_message.trim()).toBe('dependencies');
    }, 180_000);

    it('injects context_paths into the container at $HOME/context/', async () => {
        // Create a context file outside the source tree so it must travel
        // through the `copy_context_to_container` path (not the workspace tar).
        const context_root = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-ctx-input-'));
        try {
            const context_file = path.join(context_root, 'notes.md');
            fs.writeFileSync(context_file, 'context payload\n');

            const manifest = track(await create_sandbox_from_directory(source_directory, {
                no_install: true,
                context_paths: [context_file],
            }));

            // Absolute inputs land under archive `context/<basename>` per
            // `resolve_context_paths`'s spec; in-container the same relative
            // layout sits at `$HOME/context/<basename>`.
            const injected = exec_container(
                manifest.container_name,
                ['cat', `${TEST_IMAGE_HOME}/context/notes.md`],
            );
            expect(injected.trim()).toBe('context payload');
        } finally {
            fs.rmSync(context_root, { recursive: true, force: true });
        }
    });
});

// Three tests that probe a default-config sandbox without mutating its
// baseline. Share one `beforeAll` sandbox per
// [documents/testing-strategy.md](../../documents/testing-strategy.md)
// "Within an integration file: shared sandbox vs per-test" — saves 2
// `create_sandbox` calls vs the per-test pattern they previously used.
describe('sandbox lifecycle — default-config read-only inspections', () => {
    let source_directory: string;
    let manifest: { id: string; container_name: string };
    let container_name: string;

    beforeAll(async () => {
        source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-src-readonly-'));
        execFileSync('git', ['init'], { cwd: source_directory });
        fs.writeFileSync(path.join(source_directory, 'hello.txt'), 'hello world\n');
        fs.mkdirSync(path.join(source_directory, 'sub'));
        fs.writeFileSync(path.join(source_directory, 'sub', 'nested.txt'), 'nested\n');
        commit_all(source_directory);

        manifest = await create_sandbox_from_directory(source_directory, { no_install: true });
        container_name = manifest.container_name;
    }, 120_000);

    afterAll(async () => {
        await destroy_sandbox(manifest.id, { force: true });
        fs.rmSync(source_directory, { recursive: true, force: true });
    });

    it('creates a sandbox with files in container', () => {
        const content = exec_container(container_name, ['cat', `${TEST_CONTAINER_WORKING_DIR}/hello.txt`]);
        expect(content.trim()).toBe('hello world');

        const nested = exec_container(container_name, ['cat', `${TEST_CONTAINER_WORKING_DIR}/sub/nested.txt`]);
        expect(nested.trim()).toBe('nested');
    });

    it('creates a git baseline in container', () => {
        const log = exec_container(container_name, ['git', 'log', '--oneline'], { cwd: TEST_CONTAINER_WORKING_DIR });
        expect(log).toContain('baseline');
    });

    it('inspects a sandbox', () => {
        const details = inspect_sandbox(manifest.id);
        expect(details.id).toBe(manifest.id);
        expect(details.container_name).toBe(manifest.container_name);
        expect(details.container_status).toBe('running');
        expect(details.container_working_dir).toBe(TEST_CONTAINER_WORKING_DIR);
        // Manifest-recorded per-source layout fields must surface through
        // inspect's `sources` array — a regression that dropped them from
        // the inspect response (or returned an empty array for a valid
        // manifest) would silently break diagnostic tooling that relies on
        // the per-source layout.
        expect(details.sources.length).toBeGreaterThan(0);
        expect(details.sources[0].source_prefix).toBe('');
        // The repository_root in the manifest matches the realpath of
        // source_directory. The exact equality is platform-sensitive
        // (Windows shortname vs longname); a truthy check plus the test's
        // explicit setup is enough to lock the field's presence and shape.
        expect(details.sources[0].repository_root).toBeTruthy();
    });
});
