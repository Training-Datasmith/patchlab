/**
 * Gap-filler tests for `src/branch/delete.ts` paths not reached by the
 * happy-path coverage in `test/unit/branch/index.test.ts`.
 *
 *   - `unapplied_session_commits` when the patchlab branch is absent
 *     (early-return empty).
 *   - `unapplied_session_commits` when there are no other local branches
 *     (the `compute_unapplied_intersection` fallback to
 *     `parse_branch_commit_list`).
 *   - `compute_unapplied_intersection`'s intersection-narrowing step when
 *     there are TWO or more other branches.
 *   - `delete_patchlab_branch` the `'error'` outcome when a repository's
 *     `repository_root` is no longer a git repository at destroy time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
    delete_patchlab_branch,
    unapplied_session_commits,
} from '../../../src/branch/delete.js';
import { create_patchlab_branch } from '../../../src/branch/create.js';
import { patchlab_branch_name } from '../../../src/branch/naming.js';
import { create_manifest, type Sandbox_Manifest } from '../../../src/manifest.js';
import {
    GIT_TEST_ENVIRONMENT,
    initialize_repository_with_initial_commit,
    read_default_branch,
    run_git_silently,
} from '../../helpers/git_repository.js';

function build_manifest(repository_root: string, baseline_commit_sha: string | null = null): Sandbox_Manifest {
    const manifest = create_manifest(
        'pl-test',
        [{ host_path: repository_root, repository_root, source_prefix: '', mount_name: '' }],
        'container-pl-test',
        'node:22-slim',
    );
    manifest.baseline_commit_shas[repository_root] = baseline_commit_sha;
    return manifest;
}

describe('unapplied_session_commits — early returns and fallback path', () => {
    let repository: string;

    beforeEach(() => {
        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-unapplied-')));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('returns empty when the patchlab branch does not exist (no branch → nothing to compare)', () => {
        const result = unapplied_session_commits(repository, 'pl-no-branch', null);
        expect(result).toEqual([]);
    });

    it('falls back to the full branch commit list when there are no other local branches', () => {
        // Create the patchlab branch, add a session commit, then DELETE the
        // default branch so the patchlab branch is the only ref. With zero
        // other branches, `compute_unapplied_intersection` returns null and
        // the orchestrator falls back to `parse_branch_commit_list`.
        const patchlab_id = 'pl-only-branch';
        create_patchlab_branch(repository, patchlab_id);
        const default_branch = read_default_branch(repository);
        const branch = patchlab_branch_name(patchlab_id);

        execFileSync('git', ['checkout', '-b', 'tmp', branch], { cwd: repository });
        fs.writeFileSync(path.join(repository, 'session.txt'), 'session work\n');
        execFileSync('git', ['add', '-A'], { cwd: repository });
        execFileSync('git', ['commit', '-m', 'session'], { cwd: repository, env: GIT_TEST_ENVIRONMENT });
        const session_sha = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: repository,
            encoding: 'utf-8',
        }).trim();
        execFileSync('git', ['update-ref', `refs/heads/${branch}`, session_sha], { cwd: repository });
        execFileSync('git', ['checkout', branch], { cwd: repository });
        execFileSync('git', ['branch', '-D', 'tmp'], { cwd: repository });
        // Delete the default branch — patchlab branch is now the only ref.
        execFileSync('git', ['branch', '-D', default_branch], { cwd: repository });

        const result = unapplied_session_commits(repository, patchlab_id, null);
        // The branch's commit list is { initial_commit, session_sha }; the
        // fallback returns both (since there's no other branch to compare
        // against). The initial commit may or may not appear depending on
        // git's log ordering; what matters is that the session SHA does.
        expect(result).toContain(session_sha);
    });

    it('narrows the unapplied set across multiple other branches via set intersection', () => {
        // Two scenario branches both reachable from the patchlab branch's
        // session commit will report it as APPLIED; the intersection logic
        // must agree they both have it. To exercise the narrowing branch
        // (line 96 — intersection !== null), we need ≥2 other branches that
        // both succeed at `git cherry`. Build a session commit on the
        // patchlab branch that neither default nor a second branch carries
        // — both `git cherry` calls report it unapplied, and the
        // intersection-narrow filter keeps it.
        const patchlab_id = 'pl-multi-cherry';
        create_patchlab_branch(repository, patchlab_id);
        const default_branch = read_default_branch(repository);
        const branch = patchlab_branch_name(patchlab_id);

        // Create a second sibling branch at the default tip so iteration
        // over `other_branches` has two entries to intersect.
        execFileSync('git', ['branch', 'sibling', default_branch], { cwd: repository });

        // Add a session commit on the patchlab branch only.
        execFileSync('git', ['checkout', '-b', 'tmp', branch], { cwd: repository });
        fs.writeFileSync(path.join(repository, 'session.txt'), 'session\n');
        execFileSync('git', ['add', '-A'], { cwd: repository });
        execFileSync('git', ['commit', '-m', 'session-multi'], { cwd: repository, env: GIT_TEST_ENVIRONMENT });
        const session_sha = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: repository,
            encoding: 'utf-8',
        }).trim();
        execFileSync('git', ['update-ref', `refs/heads/${branch}`, session_sha], { cwd: repository });
        execFileSync('git', ['checkout', default_branch], { cwd: repository });
        execFileSync('git', ['branch', '-D', 'tmp'], { cwd: repository });

        const result = unapplied_session_commits(repository, patchlab_id, null);
        // Both default and sibling agree the session SHA is unapplied; the
        // intersection keeps it.
        expect(result).toContain(session_sha);
    });
});

describe('delete_patchlab_branch — error outcome when repository is no longer a git repo', () => {
    let temporary: string;
    let regular_directory: string;

    beforeEach(() => {
        temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-delete-error-')));
        // A regular directory that exists but is NOT a git repository — the
        // `get_repository_root` call in `delete_branch_in_one_repository`
        // will throw, the catch sets `valid = false`, and the outcome is 'error'.
        regular_directory = path.join(temporary, 'not-a-git-repo');
        fs.mkdirSync(regular_directory);
        fs.writeFileSync(path.join(regular_directory, 'placeholder.txt'), '');
    });

    afterEach(() => {
        fs.rmSync(temporary, { recursive: true, force: true });
    });

    it("returns 'error' when the repository path exists but is not a git repository", async () => {
        const manifest = build_manifest(regular_directory);

        const outcomes = await delete_patchlab_branch(manifest, 'pl-not-git');
        expect(outcomes[regular_directory]).toBe('error');
    });

    it("returns 'error' when the repository path no longer exists at all", async () => {
        const missing_directory = path.join(temporary, 'never-existed');
        const manifest = build_manifest(missing_directory);

        const outcomes = await delete_patchlab_branch(manifest, 'pl-missing');
        expect(outcomes[missing_directory]).toBe('error');
    });
});

describe('delete_patchlab_branch — confirmation hook receives unapplied count', () => {
    let repository: string;

    beforeEach(() => {
        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-delete-confirm-')));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('passes the unapplied count to the confirm callback', async () => {
        const patchlab_id = 'pl-confirm-count';
        const default_branch = read_default_branch(repository);
        create_patchlab_branch(repository, patchlab_id);
        const branch = patchlab_branch_name(patchlab_id);

        // Add a session commit on the patchlab branch only so it's unapplied.
        execFileSync('git', ['checkout', '-b', 'tmp', branch], { cwd: repository });
        fs.writeFileSync(path.join(repository, 'session.txt'), 'session\n');
        execFileSync('git', ['add', '-A'], { cwd: repository });
        execFileSync('git', ['commit', '-m', 'session'], { cwd: repository, env: GIT_TEST_ENVIRONMENT });
        const session_sha = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: repository,
            encoding: 'utf-8',
        }).trim();
        execFileSync('git', ['update-ref', `refs/heads/${branch}`, session_sha], { cwd: repository });
        execFileSync('git', ['checkout', default_branch], { cwd: repository });
        execFileSync('git', ['branch', '-D', 'tmp'], { cwd: repository });

        const manifest = build_manifest(repository);
        const observed: { repository_root: string; count: number }[] = [];
        await delete_patchlab_branch(manifest, patchlab_id, {
            confirm: (repository_root, count) => {
                observed.push({ repository_root, count });
                return true;
            },
        });

        expect(observed).toHaveLength(1);
        expect(observed[0].repository_root).toBe(repository);
        expect(observed[0].count).toBeGreaterThan(0);
    });

    it('respects an async confirm callback (Promise<boolean>)', async () => {
        const patchlab_id = 'pl-confirm-async';
        const default_branch = read_default_branch(repository);
        create_patchlab_branch(repository, patchlab_id);
        const branch = patchlab_branch_name(patchlab_id);

        execFileSync('git', ['checkout', '-b', 'tmp', branch], { cwd: repository });
        fs.writeFileSync(path.join(repository, 'work.txt'), 'work\n');
        execFileSync('git', ['add', '-A'], { cwd: repository });
        execFileSync('git', ['commit', '-m', 'work'], { cwd: repository, env: GIT_TEST_ENVIRONMENT });
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: repository,
            encoding: 'utf-8',
        }).trim();
        execFileSync('git', ['update-ref', `refs/heads/${branch}`, sha], { cwd: repository });
        execFileSync('git', ['checkout', default_branch], { cwd: repository });
        execFileSync('git', ['branch', '-D', 'tmp'], { cwd: repository });

        const manifest = build_manifest(repository);
        const outcomes = await delete_patchlab_branch(manifest, patchlab_id, {
            confirm: async () => false,
        });

        expect(outcomes[repository]).toBe('skipped');
    });
});

describe('delete_patchlab_branch — one repository throwing does not abort the fan-out', () => {
    let repository: string;

    beforeEach(() => {
        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-delete-throw-')));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it("records 'skipped' (not a rejection) when `git branch -D` throws because the branch is checked out", async () => {
        const patchlab_id = 'pl-checked-out';
        create_patchlab_branch(repository, patchlab_id);
        const branch = patchlab_branch_name(patchlab_id);
        // Check the patchlab branch out so `git branch -D` refuses to delete it
        // ("Cannot delete branch ... checked out at ...") — the realistic
        // linked-worktree failure the fan-out must survive.
        execFileSync('git', ['checkout', branch], { cwd: repository });

        const manifest = build_manifest(repository);
        // force:true bypasses the unapplied gate so the delete is actually
        // attempted and the `branch -D` throw is reached.
        const outcomes = await delete_patchlab_branch(manifest, patchlab_id, { force: true });

        // The throw is caught and mapped to 'skipped' (branch preserved, blocks
        // archive removal); the call resolves rather than rejecting and the
        // outcomes map is returned intact.
        expect(outcomes[repository]).toBe('skipped');
    });
});

describe('unapplied_session_commits — baseline filtering edge cases', () => {
    let repository: string;

    beforeEach(() => {
        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-baseline-')));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('ignores a baseline SHA that is not in the unapplied set (no-op delete)', () => {
        // Create patchlab branch tracking default; no extra commits. The
        // result is empty, and a baseline SHA that happens not to be on the
        // branch should be a silent no-op (Set.delete returns false).
        const patchlab_id = 'pl-noop-baseline';
        create_patchlab_branch(repository, patchlab_id);
        run_git_silently(repository, ['rev-parse', 'HEAD']);

        const result = unapplied_session_commits(repository, patchlab_id, 'deadbeef0000');
        expect(result).toEqual([]);
    });
});
