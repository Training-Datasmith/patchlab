import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
    GIT_TEST_ENVIRONMENT,
    initialize_repository_with_initial_commit,
    run_git_silently,
} from '../../helpers/git_repository.js';
import {
    branch_exists,
    create_patchlab_branch,
    patchlab_branch_name,
} from '../../../src/branch/index.js';
const { state, REAL_HOMEDIR, REAL_TMPDIR } = vi.hoisted(() => {
    const os = require('node:os');
    const home = os.homedir() as string;
    const tmp = os.tmpdir() as string;
    return {
        state: { homedir: home },
        REAL_HOMEDIR: home,
        REAL_TMPDIR: tmp,
    };
});

vi.mock('node:os', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:os')>();
    return {
        ...original,
        homedir: () => state.homedir,
    };
});

// Mock podman — garbage_collection.ts imports it directly
vi.mock('../../../src/podman.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../../src/podman.js')>();
    return {
        ...original,
        create_container: vi.fn(),
        start_container: vi.fn(),
        stop_container: vi.fn(),
        remove_container: vi.fn(),
        exec_container: vi.fn(() => ''),
        copy_to_container: vi.fn(),
        container_exists: vi.fn(() => false),
        container_running: vi.fn(() => false),
        install_package: vi.fn(),
        get_image_tool_state: vi.fn(() => 'absent'),
        image_exists: vi.fn(() => false),
        commit_container: vi.fn(),
        get_image_home: (user: string) => `/home/${user}`,
        get_working_directory: (user: string) => `/home/${user}/workspace`,
    };
});

import { garbage_collect_sandboxes, destroy_sandbox } from '../../../src/sandbox/index.js';
import { write_manifest, create_manifest } from '../../../src/manifest.js';

function days_ago(n: number): string {
    const date = new Date();
    date.setDate(date.getDate() - n);
    return date.toISOString();
}

describe('garbage_collect_sandboxes', () => {
    let test_root: string;

    beforeEach(() => {
        test_root = fs.mkdtempSync(path.join(REAL_TMPDIR, 'patchlab-gc-test-'));
        state.homedir = test_root;
    });

    afterEach(() => {
        state.homedir = REAL_HOMEDIR;
        fs.rmSync(test_root, { recursive: true, force: true });
    });

    function create_test_sandbox(id: string, created_at: string, repository_root: string = '/some/path'): void {
        const sandbox_dir = path.join(test_root, '.patchlab', id);
        fs.mkdirSync(sandbox_dir, { recursive: true });
        const manifest = create_manifest(
            id,
            [{ host_path: repository_root, repository_root, source_prefix: '', mount_name: '' }],
            `patchlab-${id}`,
            'node:22-slim',
        );
        manifest.created_at = created_at;
        write_manifest(sandbox_dir, manifest);
    }

    it('returns empty result when no sandboxes exist', async () => {
        const result = await garbage_collect_sandboxes();
        expect(result.destroyed).toHaveLength(0);
        expect(result.skipped).toHaveLength(0);
    });

    it('destroys sandboxes older than 7 days by default', async () => {
        create_test_sandbox('old-one', days_ago(10));
        create_test_sandbox('recent-one', days_ago(1));

        const result = await garbage_collect_sandboxes({ include_missing: false });

        expect(result.destroyed).toHaveLength(1);
        expect(result.destroyed[0].id).toBe('old-one');
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0].id).toBe('recent-one');
    });

    it('respects custom older_than_days', async () => {
        create_test_sandbox('three-days', days_ago(3));
        create_test_sandbox('one-day', days_ago(1));

        const result = await garbage_collect_sandboxes({ older_than_days: 2, include_missing: false });

        expect(result.destroyed).toHaveLength(1);
        expect(result.destroyed[0].id).toBe('three-days');
        expect(result.skipped).toHaveLength(1);
        expect(result.skipped[0].id).toBe('one-day');
    });

    it('destroys sandboxes with missing containers by default', async () => {
        // Container doesn't exist (podman mock returns false), so status = missing
        create_test_sandbox('missing-one', days_ago(1));

        const result = await garbage_collect_sandboxes();

        expect(result.destroyed).toHaveLength(1);
        expect(result.destroyed[0].id).toBe('missing-one');
        expect(result.destroyed[0].container_status).toBe('missing');
    });

    it('skips missing containers when include_missing is false', async () => {
        create_test_sandbox('missing-one', days_ago(1));

        const result = await garbage_collect_sandboxes({ include_missing: false });

        expect(result.destroyed).toHaveLength(0);
        expect(result.skipped).toHaveLength(1);
    });

    it('does not destroy in dry_run mode', async () => {
        create_test_sandbox('old-one', days_ago(10));

        const result = await garbage_collect_sandboxes({ dry_run: true });

        expect(result.destroyed).toHaveLength(1);
        expect(result.destroyed[0].id).toBe('old-one');
        // Manifest directory should still exist
        const sandbox_dir = path.join(test_root, '.patchlab', 'old-one');
        expect(fs.existsSync(sandbox_dir)).toBe(true);
    });

    it('does NOT force-delete a stale patchlab whose session commits are unapplied (default gc, no --force)', async () => {
        // Regression lock for the data-loss fix: age alone must not forfeit
        // unrecovered work. A real repo whose `patchlab/{id}` branch carries a
        // session commit absent from every other branch is "unapplied"; default
        // gc must SKIP it (branch + archive preserved), the same protection the
        // orphan-branch path already applies.
        const id = 'pl-gc-unapplied';
        const repository = fs.realpathSync(fs.mkdtempSync(path.join(REAL_TMPDIR, 'patchlab-gc-unapplied-')));
        try {
            initialize_repository_with_initial_commit(repository);
            create_patchlab_branch(repository, id);
            const branch = patchlab_branch_name(id);

            // Add a session commit on the patchlab branch only → unapplied.
            execFileSync('git', ['checkout', '-b', 'tmp', branch], { cwd: repository });
            fs.writeFileSync(path.join(repository, 'session.txt'), 'work\n');
            execFileSync('git', ['add', '-A'], { cwd: repository });
            execFileSync('git', ['commit', '-m', 'session'], { cwd: repository, env: GIT_TEST_ENVIRONMENT });
            const session_sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf-8' }).trim();
            execFileSync('git', ['update-ref', `refs/heads/${branch}`, session_sha], { cwd: repository });
            run_git_silently(repository, ['checkout', '-']);
            execFileSync('git', ['branch', '-D', 'tmp'], { cwd: repository });

            create_test_sandbox(id, days_ago(10), repository);

            const result = await garbage_collect_sandboxes({ include_missing: false });

            expect(result.skipped.map((sandbox) => sandbox.id)).toContain(id);
            expect(result.destroyed.map((sandbox) => sandbox.id)).not.toContain(id);
            // Archive preserved and the branch left intact.
            expect(fs.existsSync(path.join(test_root, '.patchlab', id))).toBe(true);
            expect(branch_exists(repository, branch)).toBe(true);
        } finally {
            fs.rmSync(repository, { recursive: true, force: true });
        }
    });

    it('actually removes manifest directory when not dry_run', async () => {
        create_test_sandbox('old-one', days_ago(10));
        const sandbox_dir = path.join(test_root, '.patchlab', 'old-one');
        expect(fs.existsSync(sandbox_dir)).toBe(true);

        await destroy_sandbox('old-one', { force: true });

        expect(fs.existsSync(sandbox_dir)).toBe(false);
    });
});

describe('garbage_collect_sandboxes: orphan-branch scan resilience', () => {
    let test_root: string;
    let host_repository: string;
    const live_sandbox_id = 'live-sandbox-id';
    const orphan_sandbox_id = 'orphan-sandbox-id';
    const malformed_branch = 'patchlab/foo/bar';

    beforeEach(() => {
        test_root = fs.mkdtempSync(path.join(REAL_TMPDIR, 'patchlab-gc-malformed-test-'));
        state.homedir = test_root;
        host_repository = fs.mkdtempSync(path.join(REAL_TMPDIR, 'patchlab-gc-malformed-repo-'));
        initialize_repository_with_initial_commit(host_repository);
    });

    afterEach(() => {
        state.homedir = REAL_HOMEDIR;
        fs.rmSync(test_root, { recursive: true, force: true });
        fs.rmSync(host_repository, { recursive: true, force: true });
    });

    function create_sandbox_with_repository(id: string, repository_root: string): void {
        const sandbox_dir = path.join(test_root, '.patchlab', id);
        fs.mkdirSync(sandbox_dir, { recursive: true });
        const manifest = create_manifest(
            id,
            [{ host_path: repository_root, repository_root, source_prefix: '', mount_name: '' }],
            `patchlab-${id}`,
            'node:22-slim',
        );
        // Recent created_at so include_missing:false leaves this sandbox alone;
        // the orphan-branch scan still sees the manifest's repository_root.
        manifest.created_at = new Date().toISOString();
        write_manifest(sandbox_dir, manifest);
    }

    it('skips a malformed patchlab/foo/bar branch and still cleans up a valid orphan in the same repository', async () => {
        // Three patchlab/* branches in the same repository:
        //   - `patchlab/{live_sandbox_id}` has a matching manifest under
        //     `~/.patchlab/` → the scan classifies it as NOT orphan and skips.
        //   - `patchlab/{orphan_sandbox_id}` has no manifest → the scan
        //     classifies it as orphan and (with force: true) force-deletes.
        //   - `patchlab/foo/bar` has an id (`foo/bar`) that contains a path
        //     separator, which `assert_safe_patchlab_id` rejects when the scan
        //     calls `build_archive_path(patchlab_id)`. Pre-fix the throw
        //     propagated and aborted the entire repository's scan — the valid
        //     orphan was left in place. Post-fix the scan warns and skips the
        //     malformed branch, then continues processing the remaining ones.
        create_sandbox_with_repository(live_sandbox_id, host_repository);
        run_git_silently(host_repository, ['branch', `patchlab/${live_sandbox_id}`]);
        run_git_silently(host_repository, ['branch', `patchlab/${orphan_sandbox_id}`]);
        run_git_silently(host_repository, ['branch', malformed_branch]);

        const result = await garbage_collect_sandboxes({
            include_missing: false, // keep the live sandbox; we only care about the scan
            force: true,            // bypass the unapplied-commits prompt on the orphan
        });

        const outcomes = result.orphan_outcomes[host_repository] ?? {};

        // The valid orphan IS cleaned up — proves the scan continued past the
        // malformed branch instead of aborting the repository.
        expect(outcomes[`patchlab/${orphan_sandbox_id}`]).toBe('deleted');
        // The malformed branch does NOT appear in the outcomes map: the scan
        // recognized it as not-a-patchlab-branch and left it alone.
        expect(outcomes).not.toHaveProperty(malformed_branch);
        // The live sandbox's branch does NOT appear either — its archive
        // directory exists, so the scan classified it as not-orphan.
        expect(outcomes).not.toHaveProperty(`patchlab/${live_sandbox_id}`);

        // Cross-check against real git state: orphan gone, malformed and live survive.
        expect(branch_exists(host_repository, `patchlab/${orphan_sandbox_id}`)).toBe(false);
        expect(branch_exists(host_repository, malformed_branch)).toBe(true);
        expect(branch_exists(host_repository, `patchlab/${live_sandbox_id}`)).toBe(true);
    });

    it("classifies a delete failure as 'error' (not 'missing') when the orphan branch is still present afterward", async () => {
        // The orphan branch is checked out in a sibling worktree, so
        // `git branch -D patchlab/{orphan-id}` refuses with "branch is
        // checked out at <worktree>." The scan's classification probe then
        // sees the branch still present via `git show-ref --verify` and
        // returns the new 'error' outcome.
        //
        // Pre-fix the classifier blindly returned 'missing' on ANY delete
        // failure — a checked-out branch (which is still very much there)
        // would silently surface in the gc report as "gone." This test
        // locks the corrected branch-still-present → 'error' mapping.
        create_sandbox_with_repository(live_sandbox_id, host_repository);
        run_git_silently(host_repository, ['branch', `patchlab/${orphan_sandbox_id}`]);

        const worktree_directory = fs.mkdtempSync(path.join(REAL_TMPDIR, 'patchlab-gc-worktree-'));
        // mkdtempSync creates the directory; `git worktree add` requires the
        // target NOT to exist, so remove it before handing the path to git.
        fs.rmdirSync(worktree_directory);
        run_git_silently(host_repository, [
            'worktree', 'add', worktree_directory, `patchlab/${orphan_sandbox_id}`,
        ]);

        try {
            const result = await garbage_collect_sandboxes({
                include_missing: false,
                force: true,
            });

            const outcomes = result.orphan_outcomes[host_repository] ?? {};

            // The new outcome value from the classification fix.
            expect(outcomes[`patchlab/${orphan_sandbox_id}`]).toBe('error');
            // Cross-check: the branch really IS still present. A regression
            // that classified as 'missing' AND silently deleted via some
            // alternate path would slip past the outcome check; this catches it.
            expect(branch_exists(host_repository, `patchlab/${orphan_sandbox_id}`)).toBe(true);
        } finally {
            // The worktree MUST be removed before the parent `afterEach`
            // tears down `host_repository`; otherwise git leaves a stale
            // `worktrees/` entry in the parent .git/ and (on Windows) the
            // rmSync of host_repository can fail on still-attached worktree
            // metadata.
            try {
                run_git_silently(host_repository, ['worktree', 'remove', '--force', worktree_directory]);
            } catch (_worktree_remove_failed) {
                /* best-effort cleanup */
            }

            fs.rmSync(worktree_directory, { recursive: true, force: true });
        }
    });
});
