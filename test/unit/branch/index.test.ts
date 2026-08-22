import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
    branch_exists,
    compose_diff_against_baseline_with_pending,
    create_patchlab_branch,
    delete_patchlab_branch,
    detect_submodules,
    disambiguate_repository_basenames,
    is_empty_subtree_archive_error,
    is_git_repository,
    is_working_tree_dirty,
    list_branch_files,
    make_temporary_index_path,
    patchlab_branch_exists,
    patchlab_branch_name,
    read_commit_diff,
    read_cumulative_diff,
    record_extraction_outcome,
    resolve_apply_repository,
    resolve_diff_start_reference,
    resolve_repository_root,
    unapplied_session_commits,
    make_initial_session_metadata,
} from '../../../src/branch/index.js';
import {
    execute_phase_1_preflight,
    execute_phase_2_mutations,
    rollback_phase_2_created_branches,
} from '../../../src/sandbox/index.js';
import {
    build_archive_path,
    canonical_host_path,
    read_session_metadata,
    write_session_metadata,
} from '../../../src/archive.js';
import { create_manifest, manifest_primary_source, read_manifest, write_manifest } from '../../../src/manifest.js';
import {
    GIT_TEST_ENVIRONMENT,
    initialize_repository_with_initial_commit,
    read_default_branch,
} from '../../helpers/git_repository.js';
import { assert_present } from '../../helpers/assert_present.js';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';

function to_forward_slashes(value: string): string {
    return value.replaceAll('\\', '/');
}

function compare_host_path(value: string): string {
    return to_forward_slashes(canonical_host_path(value));
}

function commit_all(directory: string, message: string): string {
    execFileSync('git', ['add', '-A'], { cwd: directory });
    execFileSync('git', ['commit', '-m', message], { cwd: directory, env: GIT_TEST_ENVIRONMENT });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf-8' }).trim();
}

// `branch: helpers` is split into two sibling describes so the read-only
// cases can share one fixture (saves ~3 × 150 ms) while the working-tree-
// dirtying cases keep per-test isolation (would otherwise contaminate the
// shared repo's `is_working_tree_dirty` baseline).
describe('branch: helpers — read-only on a clean fixture', () => {
    install_isolated_home_hooks('patchlab-branch-home-', { scope: 'all' });
    let repository: string;

    beforeAll(() => {
        repository = canonical_host_path(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-branch-test-')));
        initialize_repository_with_initial_commit(repository);
    });

    afterAll(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('patchlab_branch_name composes the standard prefix', () => {
        expect(patchlab_branch_name('abc-123')).toBe('patchlab/abc-123');
    });

    it('is_working_tree_dirty returns false on clean repo', () => {
        expect(is_working_tree_dirty(repository)).toBe(false);
    });

    it('detect_submodules returns empty array when no .gitmodules', () => {
        expect(detect_submodules(repository)).toEqual([]);
    });
});

describe('branch: helpers — working-tree mutators (per-test fresh repo)', () => {
    install_isolated_home_hooks('patchlab-branch-mut-home-');
    let repository: string;

    beforeEach(() => {
        repository = canonical_host_path(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-branch-mut-')));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('is_working_tree_dirty returns true when there are untracked files', () => {
        fs.writeFileSync(path.join(repository, 'new.txt'), 'untracked\n');
        expect(is_working_tree_dirty(repository)).toBe(true);
    });

    it('is_working_tree_dirty returns true when there are modifications', () => {
        fs.writeFileSync(path.join(repository, 'README.md'), '# changed\n');
        expect(is_working_tree_dirty(repository)).toBe(true);
    });

    it('detect_submodules parses paths from .gitmodules', () => {
        fs.writeFileSync(
            path.join(repository, '.gitmodules'),
            '[submodule "vendor/foo"]\n\tpath = vendor/foo\n\turl = https://example.com/foo.git\n'
        );
        expect(detect_submodules(repository)).toEqual(['vendor/foo']);
    });
});

describe('branch: two-phase multi-repository branch creation', () => {
    install_isolated_home_hooks('patchlab-twophase-home-');
    let repository_a: string;
    let repository_b: string;

    beforeEach(() => {
        repository_a = canonical_host_path(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-twophase-a-')));
        repository_b = canonical_host_path(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-twophase-b-')));
        initialize_repository_with_initial_commit(repository_a);
        initialize_repository_with_initial_commit(repository_b);
    });

    afterEach(() => {
        fs.rmSync(repository_a, { recursive: true, force: true });
        fs.rmSync(repository_b, { recursive: true, force: true });
    });

    it('Phase 1 runs all checks per repository without mutating any host repository', async () => {
        const dirty_repositories = await execute_phase_1_preflight(
            [repository_a, repository_b],
            'pl-phase1-clean',
            {},
        );
        expect(dirty_repositories.size).toBe(0);
        // No patchlab branch should exist in either repository after Phase 1.
        expect(patchlab_branch_exists(repository_a, 'pl-phase1-clean')).toBe(false);
        expect(patchlab_branch_exists(repository_b, 'pl-phase1-clean')).toBe(false);
    });

    it('Phase 1 detects dirty repos and reports them via the dirty_repos set', async () => {
        // Dirty repository B only.
        fs.writeFileSync(path.join(repository_b, 'wip.txt'), 'work in progress\n');

        const dirty_repositories = await execute_phase_1_preflight(
            [repository_a, repository_b],
            'pl-phase1-mixed',
            { allow_dirty_tree: true },
        );
        expect([...dirty_repositories]).toEqual([repository_b]);
        // No branches were created.
        expect(patchlab_branch_exists(repository_a, 'pl-phase1-mixed')).toBe(false);
        expect(patchlab_branch_exists(repository_b, 'pl-phase1-mixed')).toBe(false);
    });

    it('Phase 1 aborts on the first repository whose branch-existence check fails', async () => {
        // Pre-existing branch in repository B simulates an earlier aborted create.
        execFileSync('git', ['branch', 'patchlab/pl-phase1-collision'], { cwd: repository_b });

        await expect(execute_phase_1_preflight(
            [repository_a, repository_b],
            'pl-phase1-collision',
            {},
        )).rejects.toThrow(/already exists.*patchlab-twophase-b/i);
        // No branch was created in repository A even though A's Phase 1 sub-steps
        // would have passed individually.
        expect(patchlab_branch_exists(repository_a, 'pl-phase1-collision')).toBe(false);
    });

    it('Phase 2 creates branches and captures per-repository baselines for dirty repos', () => {
        // Dirty repository A; clean repository B.
        fs.writeFileSync(path.join(repository_a, 'wip.txt'), 'wip\n');
        const dirty_repositories = new Set<string>([repository_a]);
        const created_branch_repositories: string[] = [];

        const result = execute_phase_2_mutations(
            [repository_a, repository_b],
            'pl-phase2',
            dirty_repositories,
            created_branch_repositories,
        );

        expect(created_branch_repositories).toEqual([repository_a, repository_b]);
        expect(result.baseline_commit_shas[repository_a]).not.toBeNull();
        expect(result.baseline_commit_shas[repository_b]).toBeNull();
        expect(result.branch_creation_point_shas[repository_a]).toBeTruthy();
        expect(result.branch_creation_point_shas[repository_b]).toBeTruthy();
        expect(patchlab_branch_exists(repository_a, 'pl-phase2')).toBe(true);
        expect(patchlab_branch_exists(repository_b, 'pl-phase2')).toBe(true);
    });

    it('Phase 2 rollback force-deletes every branch tracked when a later repository fails', () => {
        // Pre-create a branch in repository B so that Phase 2's create_patchlab_branch
        // throws on B (the existence check fails internally). Repo A succeeds,
        // then B fails; rollback should force-delete A's just-created branch.
        execFileSync('git', ['branch', 'patchlab/pl-phase2-rollback'], { cwd: repository_b });

        const created_branch_repositories: string[] = [];
        expect(() =>
            execute_phase_2_mutations(
                [repository_a, repository_b],
                'pl-phase2-rollback',
                new Set<string>(),
                created_branch_repositories,
            ),
        ).toThrow(/already exists/i);
        expect(created_branch_repositories).toEqual([repository_a]);

        // Simulate the rollback path the caller would invoke.
        rollback_phase_2_created_branches(created_branch_repositories, 'pl-phase2-rollback');
        expect(patchlab_branch_exists(repository_a, 'pl-phase2-rollback')).toBe(false);
    });
});

describe('branch: temp index path uniqueness (concurrent extractions)', () => {
    it('make_temp_index_path produces distinct paths across many calls', () => {
        // Generates path with crypto.randomUUID() suffix; concurrent extractions never collide.
        const paths = new Set<string>();
        const N = 1000;
        for (let i = 0; i < N; i++) {
            paths.add(make_temporary_index_path('pl-shared', 'session-1'));
        }

        expect(paths.size).toBe(N);
    });

    it('make_temp_index_path includes the patchlab id and label for debuggability', () => {
        const p = make_temporary_index_path('abc-123', 'session-7');
        const file_name = path.basename(p);
        expect(file_name).toContain('abc-123');
        expect(file_name).toContain('session-7');
        expect(file_name).toMatch(/\.idx$/);
    });
});

describe('branch: create and delete', () => {
    install_isolated_home_hooks('patchlab-create-home-');
    let repository: string;

    beforeEach(() => {
        repository = canonical_host_path(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-create-test-')));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('creates a patchlab/{id} branch from HEAD on a clean repo', () => {
        const result = create_patchlab_branch(repository, 'pl-clean');
        expect(result.branch_name).toBe('patchlab/pl-clean');
        expect(result.baseline_sha).toBeNull();
        expect(patchlab_branch_exists(repository, 'pl-clean')).toBe(true);
    });

    it('creates a baseline commit when working tree is dirty and capture_dirty_baseline is true', () => {
        fs.writeFileSync(path.join(repository, 'unstaged.txt'), 'work in progress\n');
        const result = create_patchlab_branch(repository, 'pl-dirty', { capture_dirty_baseline: true });
        expect(result.baseline_sha).not.toBeNull();
        // Verify the baseline commit exists on the branch and includes the dirty file
        const log = execFileSync('git', ['log', '--name-only', `patchlab/pl-dirty`], {
            cwd: repository, encoding: 'utf-8',
        });
        expect(log).toContain('unstaged.txt');
        expect(log).toContain('Uncommitted host changes');
    });

    it('does not create baseline commit when working tree is clean even with capture flag', () => {
        const result = create_patchlab_branch(repository, 'pl-clean-flag', { capture_dirty_baseline: true });
        expect(result.baseline_sha).toBeNull();
    });

    it('baseline commit excludes gitignored files (matches git add -A semantics)', () => {
        // .gitignore lives in the committed history, but is also in the working tree.
        fs.writeFileSync(path.join(repository, '.gitignore'), 'secret.env\nbuild/\n');
        execFileSync('git', ['add', '.gitignore'], { cwd: repository });
        execFileSync('git', ['commit', '-m', 'add gitignore'], { cwd: repository, env: GIT_TEST_ENVIRONMENT });

        // Dirty the working tree with a mix of tracked, untracked, and gitignored content.
        fs.writeFileSync(path.join(repository, 'tracked-edit.txt'), 'tracked change\n');
        fs.writeFileSync(path.join(repository, 'new-file.txt'), 'untracked\n');
        fs.writeFileSync(path.join(repository, 'secret.env'), 'API_KEY=should-not-be-in-baseline\n');
        fs.mkdirSync(path.join(repository, 'build'));
        fs.writeFileSync(path.join(repository, 'build', 'out.js'), 'compiled\n');

        const result = create_patchlab_branch(repository, 'pl-gitignore', { capture_dirty_baseline: true });
        expect(result.baseline_sha).not.toBeNull();

        const tree_listing = execFileSync(
            'git',
            ['ls-tree', '-r', '--name-only', `patchlab/pl-gitignore`],
            { cwd: repository, encoding: 'utf-8' }
        );

        expect(tree_listing).toContain('tracked-edit.txt');
        expect(tree_listing).toContain('new-file.txt');
        // Critical: gitignored files MUST NOT appear in the baseline commit.
        expect(tree_listing).not.toContain('secret.env');
        expect(tree_listing).not.toContain('build/out.js');
    });

    it('refuses to create a branch that already exists', () => {
        create_patchlab_branch(repository, 'pl-dup');
        expect(() => create_patchlab_branch(repository, 'pl-dup')).toThrow(/already exists/);
    });

    it('refuses to create a branch on an empty (no-HEAD) repository', () => {
        // Patchlab's branch needs at least one commit to anchor against. A
        // freshly-initialized repo has no HEAD; `create_patchlab_branch`
        // converts the rev-parse failure into a clear "no commits" message
        // that names the remediation (`git commit --allow-empty -m initial`).
        // Build the no-HEAD case fresh — the file's `beforeEach` already
        // committed a README via `init_repository`.
        const empty_repository = canonical_host_path(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-empty-')));
        try {
            execFileSync('git', ['init'], { cwd: empty_repository });
            expect(() => create_patchlab_branch(empty_repository, 'pl-empty'))
                .toThrow(/no commits/);
        } finally {
            fs.rmSync(empty_repository, { recursive: true, force: true });
        }
    });

    function single_repository_manifest(patchlab_id: string, repository_root: string): import('../../../src/manifest.js').Sandbox_Manifest {
        return create_manifest(
            patchlab_id,
            [{ host_path: repository_root, repository_root, source_prefix: '', mount_name: '' }],
            `patchlab-${patchlab_id}`,
            'unused',
        );
    }

    it('delete_patchlab_branch removes the branch (force) and is idempotent', async () => {
        create_patchlab_branch(repository, 'pl-del');
        expect(patchlab_branch_exists(repository, 'pl-del')).toBe(true);
        const manifest = single_repository_manifest('pl-del', repository);

        const result1 = await delete_patchlab_branch(manifest, 'pl-del', { force: true });
        expect(result1[repository]).toBe('deleted');
        expect(patchlab_branch_exists(repository, 'pl-del')).toBe(false);

        // Idempotent: deleting again is fine and yields 'missing'.
        const result2 = await delete_patchlab_branch(manifest, 'pl-del', { force: true });
        expect(result2[repository]).toBe('missing');
    });

    it('delete refuses unapplied non-interactive without --force', async () => {
        const default_branch = read_default_branch(repository);
        // Create branch and add a commit only on it.
        create_patchlab_branch(repository, 'pl-unapp');
        // Add a session commit on the branch with a real change so it's "unapplied" elsewhere.
        execFileSync('git', ['checkout', '-b', 'temp-work', 'patchlab/pl-unapp'], { cwd: repository });
        fs.writeFileSync(path.join(repository, 'session.txt'), 'session work\n');
        execFileSync('git', ['add', '-A'], { cwd: repository });
        execFileSync('git', ['commit', '-m', 'session change'], { cwd: repository, env: GIT_TEST_ENVIRONMENT });
        // Move the branch to point at this new commit, then return to default.
        const new_tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf-8' }).trim();
        execFileSync('git', ['checkout', default_branch], { cwd: repository });
        execFileSync('git', ['branch', '-D', 'temp-work'], { cwd: repository });
        execFileSync('git', ['update-ref', 'refs/heads/patchlab/pl-unapp', new_tip], { cwd: repository });

        // Without force or confirmation hook, should refuse.
        const result = await delete_patchlab_branch(single_repository_manifest('pl-unapp', repository), 'pl-unapp');
        expect(result[repository]).toBe('skipped');
        expect(patchlab_branch_exists(repository, 'pl-unapp')).toBe(true);
    });

    it('delete proceeds when per-repository confirm returns true', async () => {
        const default_branch = read_default_branch(repository);
        create_patchlab_branch(repository, 'pl-confirm');
        // Add a commit on the branch.
        execFileSync('git', ['checkout', '-b', 'temp-work2', 'patchlab/pl-confirm'], { cwd: repository });
        fs.writeFileSync(path.join(repository, 'work.txt'), 'work\n');
        execFileSync('git', ['add', '-A'], { cwd: repository });
        execFileSync('git', ['commit', '-m', 'work'], { cwd: repository, env: GIT_TEST_ENVIRONMENT });
        const tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf-8' }).trim();
        execFileSync('git', ['checkout', default_branch], { cwd: repository });
        execFileSync('git', ['branch', '-D', 'temp-work2'], { cwd: repository });
        execFileSync('git', ['update-ref', 'refs/heads/patchlab/pl-confirm', tip], { cwd: repository });

        const result = await delete_patchlab_branch(single_repository_manifest('pl-confirm', repository), 'pl-confirm', {
            confirm: () => true,
        });
        expect(result[repository]).toBe('deleted');
        expect(patchlab_branch_exists(repository, 'pl-confirm')).toBe(false);
    });
});

describe('branch: delete_patchlab_branch multi-repository per-repository outcomes', () => {
    install_isolated_home_hooks('patchlab-delete-multi-');
    let repository_a: string;
    let repository_b: string;

    beforeEach(() => {
        repository_a = canonical_host_path(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-del-a-')));
        repository_b = canonical_host_path(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-del-b-')));
        initialize_repository_with_initial_commit(repository_a);
        initialize_repository_with_initial_commit(repository_b);
    });

    afterEach(() => {
        fs.rmSync(repository_a, { recursive: true, force: true });
        fs.rmSync(repository_b, { recursive: true, force: true });
    });

    function multi_repository_manifest(patchlab_id: string) {
        return create_manifest(
            patchlab_id,
            [
                { host_path: repository_a, repository_root: repository_a, source_prefix: '', mount_name: 'a' },
                { host_path: repository_b, repository_root: repository_b, source_prefix: '', mount_name: 'b' },
            ],
            `patchlab-${patchlab_id}`,
            'unused',
        );
    }

    it('multi-repository destroy with all branches deleted yields deleted for every repo', async () => {
        create_patchlab_branch(repository_a, 'pl-multi-all');
        create_patchlab_branch(repository_b, 'pl-multi-all');

        const result = await delete_patchlab_branch(multi_repository_manifest('pl-multi-all'), 'pl-multi-all', {
            force: true,
        });
        expect(result[repository_a]).toBe('deleted');
        expect(result[repository_b]).toBe('deleted');
        expect(patchlab_branch_exists(repository_a, 'pl-multi-all')).toBe(false);
        expect(patchlab_branch_exists(repository_b, 'pl-multi-all')).toBe(false);
    });

    it('multi-repository destroy with one branch missing yields missing for that repo', async () => {
        create_patchlab_branch(repository_a, 'pl-multi-missing');
        // No branch in repository B.

        const result = await delete_patchlab_branch(multi_repository_manifest('pl-multi-missing'), 'pl-multi-missing', {
            force: true,
        });
        expect(result[repository_a]).toBe('deleted');
        expect(result[repository_b]).toBe('missing');
    });

    it('multi-repository destroy with one repository unreachable yields error for that repo', async () => {
        create_patchlab_branch(repository_a, 'pl-multi-error');
        create_patchlab_branch(repository_b, 'pl-multi-error');
        const manifest = multi_repository_manifest('pl-multi-error');
        // Remove repository B from the host BEFORE destroy.
        fs.rmSync(repository_b, { recursive: true, force: true });

        const result = await delete_patchlab_branch(manifest, 'pl-multi-error', {
            force: true,
        });
        expect(result[repository_a]).toBe('deleted');
        expect(result[repository_b]).toBe('error');
    });

    it('multi-repository destroy skips one repository whose unapplied confirm declines', async () => {
        const default_branch_a = read_default_branch(repository_a);
        create_patchlab_branch(repository_a, 'pl-multi-skip');
        create_patchlab_branch(repository_b, 'pl-multi-skip');
        // Stage unapplied work on A's branch.
        execFileSync('git', ['checkout', '-b', 'work-a', 'patchlab/pl-multi-skip'], { cwd: repository_a });
        fs.writeFileSync(path.join(repository_a, 'session.txt'), 'session\n');
        execFileSync('git', ['add', '-A'], { cwd: repository_a });
        execFileSync('git', ['commit', '-m', 'session-a'], { cwd: repository_a, env: GIT_TEST_ENVIRONMENT });
        const tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository_a, encoding: 'utf-8' }).trim();
        execFileSync('git', ['checkout', default_branch_a], { cwd: repository_a });
        execFileSync('git', ['branch', '-D', 'work-a'], { cwd: repository_a });
        execFileSync('git', ['update-ref', 'refs/heads/patchlab/pl-multi-skip', tip], { cwd: repository_a });

        const result = await delete_patchlab_branch(multi_repository_manifest('pl-multi-skip'), 'pl-multi-skip', {
            // Decline for A; B has no unapplied work so the hook doesn't fire there.
            confirm: (repository_root) => repository_root !== repository_a,
        });
        expect(result[repository_a]).toBe('skipped');
        expect(result[repository_b]).toBe('deleted');
        expect(patchlab_branch_exists(repository_a, 'pl-multi-skip')).toBe(true);
        expect(patchlab_branch_exists(repository_b, 'pl-multi-skip')).toBe(false);
    });
});

describe('branch: session metadata helpers', () => {
    install_isolated_home_hooks('patchlab-meta-home-');

    const META_REPO = '/host/repo';

    /**
     * `record_extraction_outcome` reads the manifest to reconstruct the
     * commit-shas/fallback-patches keyset (per the spec — stale keys from
     * hand-edited manifests are DROPPED on write). Tests that exercise it
     * therefore need a manifest fixture on disk.
     */
    function write_fixture_manifest(id: string): void {
        const archive_directory = build_archive_path(id);
        fs.mkdirSync(archive_directory, { recursive: true });
        const manifest = create_manifest(
            id,
            [{ host_path: META_REPO, repository_root: META_REPO, source_prefix: '', mount_name: '' }],
            `container-${id}`,
            'node:22-slim',
        );
        write_manifest(archive_directory, manifest);
    }

    it('make_initial_session_metadata produces well-formed defaults', () => {
        const meta = make_initial_session_metadata(3, 'gemini-cli-oauth', 'patchlab-abc', [META_REPO]);
        expect(meta.session_number).toBe(3);
        expect(meta.tool).toBe('gemini-cli-oauth');
        expect(meta.container_name).toBe('patchlab-abc');
        expect(meta.commit_shas).toEqual({ [META_REPO]: null });
        expect(meta.fallback_patches).toEqual({ [META_REPO]: null });
        expect(meta.completed_at).toBeNull();
        expect(meta.status).toBe('interrupted');
        expect(meta.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('make_initial_session_metadata rejects empty repositories array', () => {
        expect(() => make_initial_session_metadata(1, 'gemini-cli-oauth', 'name', []))
            .toThrow(/non-empty/);
    });

    it('record_extraction_outcome persists commit_shas and preserves session-start fields', () => {
        const id = 'pl-rmw';
        write_fixture_manifest(id);
        const meta = make_initial_session_metadata(1, 'gemini-cli-oauth', 'patchlab-rmw', [META_REPO]);
        write_session_metadata(id, 1, meta);

        record_extraction_outcome(id, 1, {
            commit_shas: { [META_REPO]: 'abc123' },
            fallback_patches: { [META_REPO]: null },
        });

        const after = read_session_metadata(id, 1);
        assert_present(after);
        expect(after.commit_shas[META_REPO]).toBe('abc123');
        expect(after.fallback_patches[META_REPO]).toBeNull();
        expect(after.session_number).toBe(1);
        expect(after.tool).toBe('gemini-cli-oauth');
        expect(after.container_name).toBe('patchlab-rmw');
        expect(after.created_at).toBe(meta.created_at);
    });

    it('record_extraction_outcome persists fallback_patches when no commit was made', () => {
        const id = 'pl-fallback';
        write_fixture_manifest(id);
        write_session_metadata(id, 1, make_initial_session_metadata(1, 'gemini-cli-oauth', 'patchlab-fb', [META_REPO]));

        record_extraction_outcome(id, 1, {
            commit_shas: { [META_REPO]: null },
            fallback_patches: { [META_REPO]: '/home/user/.patchlab/pl-fallback/sessions/1/fallback.patch' },
        });

        const after = read_session_metadata(id, 1);
        assert_present(after);
        expect(after.commit_shas[META_REPO]).toBeNull();
        expect(after.fallback_patches[META_REPO]).toBe(
            '/home/user/.patchlab/pl-fallback/sessions/1/fallback.patch'
        );
    });

    it('record_extraction_outcome clears a stale fallback when a later commit succeeds', () => {
        const id = 'pl-clear';
        write_fixture_manifest(id);
        write_session_metadata(id, 1, make_initial_session_metadata(1, 'gemini-cli-oauth', 'patchlab-cl', [META_REPO]));

        // First write: fallback present, no commit.
        record_extraction_outcome(id, 1, {
            commit_shas: { [META_REPO]: null },
            fallback_patches: { [META_REPO]: '/some/old/fallback.patch' },
        });
        // Second write: commit succeeded — fallback must be cleared.
        record_extraction_outcome(id, 1, {
            commit_shas: { [META_REPO]: 'def456' },
            fallback_patches: { [META_REPO]: null },
        });

        const after = read_session_metadata(id, 1);
        assert_present(after);
        expect(after.commit_shas[META_REPO]).toBe('def456');
        expect(after.fallback_patches[META_REPO]).toBeNull();
    });

    it('record_extraction_outcome throws if session metadata does not exist', () => {
        expect(() =>
            record_extraction_outcome('pl-nonexistent', 99, {
                commit_shas: { [META_REPO]: 'abc' },
                fallback_patches: { [META_REPO]: null },
            })
        ).toThrow(/no metadata/);
    });
});

describe('branch: resolve_apply_repository (multi-source-extraction Decision 4)', () => {
    function build_manifest(repos: string[]): Parameters<typeof resolve_apply_repository>[0] {
        return {
            id: 'pl-test',
            format_version: 0,
            sources: repos.map((repository_root) => ({
                host_path: repository_root,
                repository_root,
                source_prefix: '',
                mount_name: '',
            })),
            baseline_commit_shas: Object.fromEntries(repos.map((r) => [r, null])),
            branch_creation_point_shas: Object.fromEntries(repos.map((r) => [r, null])),
            created_at: '2026-05-23T00:00:00.000Z',
            container_name: 'patchlab-test',
            container_image: 'test-image',
        };
    }

    // Build inputs via path.resolve so they survive the resolver's internal
    // path.resolve unchanged. POSIX-style literals like '/home/dev/only' get
    // rewritten to 'C:/home/dev/only' on Windows; this normalization keeps
    // the test platform-agnostic.
    const REPOSITORY_A = path.resolve('/home/dev/a');
    const REPOSITORY_B = path.resolve('/home/dev/b');
    const REPOSITORY_C = path.resolve('/home/dev/c');
    const REPOSITORY_ONLY = path.resolve('/home/dev/only');
    const REPOSITORY_WRONG = path.resolve('/home/dev/wrong');

    it('single-repository + undefined value → returns the only repository', () => {
        const manifest = build_manifest([REPOSITORY_ONLY]);
        expect(resolve_apply_repository(manifest, undefined)).toBe(REPOSITORY_ONLY);
    });

    it('single-repository + matching value → returns the repository', () => {
        const manifest = build_manifest([REPOSITORY_ONLY]);
        expect(resolve_apply_repository(manifest, REPOSITORY_ONLY)).toBe(REPOSITORY_ONLY);
    });

    it('single-repository + non-matching value → throws naming both sides', () => {
        const manifest = build_manifest([REPOSITORY_ONLY]);
        expect(() => resolve_apply_repository(manifest, REPOSITORY_WRONG)).toThrow(
            /is not in the patchlab's repository set/i,
        );
    });

    it('multi-repository + undefined value → throws listing every repository', () => {
        const manifest = build_manifest([REPOSITORY_A, REPOSITORY_B]);
        expect(() => resolve_apply_repository(manifest, undefined)).toThrow(
            /spans multiple repositories/i,
        );
        try {
            resolve_apply_repository(manifest, undefined);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            expect(message).toContain(REPOSITORY_A);
            expect(message).toContain(REPOSITORY_B);
        }
    });

    it('multi-repository + matching value → returns the matched repository', () => {
        const manifest = build_manifest([REPOSITORY_A, REPOSITORY_B]);
        expect(resolve_apply_repository(manifest, REPOSITORY_B)).toBe(REPOSITORY_B);
    });

    it('multi-repository + non-matching value → throws naming the resolved value and the list', () => {
        const manifest = build_manifest([REPOSITORY_A, REPOSITORY_B]);
        expect(() => resolve_apply_repository(manifest, REPOSITORY_C)).toThrow(
            /is not in the patchlab's repository set/i,
        );
    });

    it('resolves a relative supplied value via path.resolve', () => {
        // path.resolve(".") is process.cwd(); manifest entries must match
        // whatever the process is running in.
        const cwd = process.cwd();
        const manifest = build_manifest([cwd]);
        expect(resolve_apply_repository(manifest, '.')).toBe(cwd);
    });
});

describe('branch: disambiguate_repository_basenames', () => {
    it('returns the unmodified basename when every repository has a unique basename', () => {
        const result = disambiguate_repository_basenames([
            '/home/dev/repo-a',
            '/home/dev/repo-b',
            '/var/lib/something',
        ]);
        expect(result.get('/home/dev/repo-a')).toBe('repo-a');
        expect(result.get('/home/dev/repo-b')).toBe('repo-b');
        expect(result.get('/var/lib/something')).toBe('something');
    });

    it('appends an 8-hex hash when two repos share a basename', () => {
        const result = disambiguate_repository_basenames([
            '/home/dev/app',
            '/home/other/app',
        ]);
        const a = result.get('/home/dev/app');
        const b = result.get('/home/other/app');
        expect(a).toMatch(/^app_[0-9a-f]{8}$/);
        expect(b).toMatch(/^app_[0-9a-f]{8}$/);
        // Hashes are different because the input strings (or their realpaths)
        // differ.
        expect(a).not.toBe(b);
    });

    it('is deterministic across runs for the same inputs', () => {
        const inputs = ['/r/app', '/s/app'];
        const first = disambiguate_repository_basenames(inputs);
        const second = disambiguate_repository_basenames(inputs);
        for (const key of inputs) {
            expect(first.get(key)).toBe(second.get(key));
        }
    });

    it('returns single-entry map for a single repository', () => {
        const result = disambiguate_repository_basenames(['/only/repo']);
        expect(result.size).toBe(1);
        expect(result.get('/only/repo')).toBe('repo');
    });

    it('handles three repos sharing one basename', () => {
        const result = disambiguate_repository_basenames([
            '/one/lib',
            '/two/lib',
            '/three/lib',
        ]);
        const values = [...result.values()];
        // All three are disambiguated (the hash suffix is present on every
        // entry in a collision group, including the first).
        expect(values.every((v) => /^lib_[0-9a-f]{8}$/.test(v))).toBe(true);
        // Distinct disambiguators.
        expect(new Set(values).size).toBe(3);
    });
});

describe('branch: unapplied_session_commits via git cherry', () => {
    install_isolated_home_hooks('patchlab-cherry-home-');
    let repository: string;

    beforeEach(() => {
        repository = canonical_host_path(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cherry-test-')));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('returns empty when branch tip is reachable from another branch', () => {
        // Create patchlab branch — its only commit is the same as main's tip.
        create_patchlab_branch(repository, 'pl-applied');
        const unapplied = unapplied_session_commits(repository, 'pl-applied', null);
        expect(unapplied).toEqual([]);
    });

    it('returns the SHA when branch has a commit not in default', () => {
        const default_branch = read_default_branch(repository);
        create_patchlab_branch(repository, 'pl-pending');
        // Add a commit on the branch only.
        execFileSync('git', ['checkout', '-b', 'tmp', 'patchlab/pl-pending'], { cwd: repository });
        fs.writeFileSync(path.join(repository, 'pending.txt'), 'pending work\n');
        execFileSync('git', ['add', '-A'], { cwd: repository });
        execFileSync('git', ['commit', '-m', 'pending'], { cwd: repository, env: GIT_TEST_ENVIRONMENT });
        const tip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf-8' }).trim();
        execFileSync('git', ['checkout', default_branch], { cwd: repository });
        execFileSync('git', ['branch', '-D', 'tmp'], { cwd: repository });
        execFileSync('git', ['update-ref', 'refs/heads/patchlab/pl-pending', tip], { cwd: repository });

        const unapplied = unapplied_session_commits(repository, 'pl-pending', null);
        expect(unapplied).toContain(tip);
    });

    it('excludes the baseline commit from the unapplied set', () => {
        const default_branch = read_default_branch(repository);
        // Build a branch with two commits: a "baseline" and a "session", neither applied elsewhere.
        create_patchlab_branch(repository, 'pl-baseline');
        execFileSync('git', ['checkout', '-b', 'tmp2', 'patchlab/pl-baseline'], { cwd: repository });
        fs.writeFileSync(path.join(repository, 'baseline.txt'), 'baseline\n');
        execFileSync('git', ['add', '-A'], { cwd: repository });
        execFileSync('git', ['commit', '-m', 'Uncommitted host changes'], { cwd: repository, env: GIT_TEST_ENVIRONMENT });
        const baseline_sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf-8' }).trim();
        fs.writeFileSync(path.join(repository, 'session.txt'), 'session\n');
        execFileSync('git', ['add', '-A'], { cwd: repository });
        execFileSync('git', ['commit', '-m', 'Session 1'], { cwd: repository, env: GIT_TEST_ENVIRONMENT });
        const session_sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf-8' }).trim();
        execFileSync('git', ['checkout', default_branch], { cwd: repository });
        execFileSync('git', ['branch', '-D', 'tmp2'], { cwd: repository });
        execFileSync('git', ['update-ref', 'refs/heads/patchlab/pl-baseline', session_sha], { cwd: repository });

        const unapplied = unapplied_session_commits(repository, 'pl-baseline', baseline_sha);
        expect(unapplied).toContain(session_sha);
        expect(unapplied).not.toContain(baseline_sha);
    });
});

describe('branch: subdirectory and source_prefix', () => {
    install_isolated_home_hooks('patchlab-subdir-home-');
    let repository: string;

    beforeEach(() => {
        repository = canonical_host_path(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-subdir-test-')));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('create branch from subdirectory targets the repository root', () => {
        const sub = path.join(repository, 'app');
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'index.js'), 'console.log("a");\n');
        commit_all(repository, 'add app');

        const result = create_patchlab_branch(sub, 'pl-sub');
        expect(result.branch_name).toBe('patchlab/pl-sub');
        // The branch ref lives at the repository root, not the subdirectory.
        expect(patchlab_branch_exists(repository, 'pl-sub')).toBe(true);
    });
});

describe('branch: resolve_repository_root for legacy manifests', () => {
    install_isolated_home_hooks('patchlab-legacy-home-');
    let repository: string;

    beforeEach(() => {
        repository = canonical_host_path(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-legacy-test-')));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('recomputes repository_root for legacy manifest and persists it back', () => {
        // Set up a "legacy" archive — a manifest file with the pre-multi-source
        // top-level shape and repository_root: null. The reader's synthesis
        // path leaves repository_root as an empty string in that case; the
        // resolver recomputes via get_repository_root and writes the new shape.
        const id = 'pl-legacy';
        const archive_dir = build_archive_path(id);
        fs.mkdirSync(archive_dir, { recursive: true });
        const legacy = {
            id,
            source_path: repository,
            repository_root: null,
            source_prefix: '',
            format_version: 0,
            baseline_commit_sha: null,
            branch_creation_point_sha: null,
            created_at: '2026-01-01T00:00:00.000Z',
            container_name: `patchlab-${id}`,
            container_image: 'node:22-slim',
        };
        fs.writeFileSync(
            path.join(archive_dir, 'manifest.json'),
            JSON.stringify(legacy, null, 2),
            'utf-8',
        );

        // Read back to confirm the legacy state (synthesized entry has empty
        // repository_root pending recomputation).
        const before = read_manifest(archive_dir);
        expect(manifest_primary_source(before).repository_root).toBe('');

        // Resolving should recompute via get_repository_root and write it back.
        const result = resolve_repository_root(id);
        expect(compare_host_path(result)).toBe(compare_host_path(repository));

        const after = read_manifest(archive_dir);
        const after_primary = manifest_primary_source(after);
        expect(after_primary.repository_root).toBeTruthy();
        expect(compare_host_path(after_primary.repository_root)).toBe(compare_host_path(repository));
    });

    it('rekeys SHA maps when legacy manifest with repository_root: null carries non-null SHAs', () => {
        // Regression for the narrow legacy path where a pre-multi-source
        // manifest carries `repository_root: null` AND a non-null
        // `baseline_commit_sha` / `branch_creation_point_sha`. The reader's
        // legacy synthesis keys the SHA maps on '' (the placeholder repo
        // root); `resolve_repository_root` recomputes the real root and must
        // also rekey the SHA maps so subsequent lookups against the new key
        // don't silently lose the recorded SHAs.
        const id = 'pl-legacy-rekey';
        const archive_dir = build_archive_path(id);
        fs.mkdirSync(archive_dir, { recursive: true });
        const legacy = {
            id,
            source_path: repository,
            repository_root: null,
            source_prefix: '',
            format_version: 0,
            baseline_commit_sha: 'baseline-sha-abc',
            branch_creation_point_sha: 'creation-point-def',
            created_at: '2026-01-01T00:00:00.000Z',
            container_name: `patchlab-${id}`,
            container_image: 'node:22-slim',
        };
        fs.writeFileSync(
            path.join(archive_dir, 'manifest.json'),
            JSON.stringify(legacy, null, 2),
            'utf-8',
        );

        // Confirm the read-time synthesis keyed the maps on the empty string.
        const before = read_manifest(archive_dir);
        expect(before.baseline_commit_shas).toEqual({ '': 'baseline-sha-abc' });
        expect(before.branch_creation_point_shas).toEqual({ '': 'creation-point-def' });

        resolve_repository_root(id);

        // After the recompute + rekey, the on-disk map keys match the
        // recomputed repository_root, and lookups against the manifest's
        // primary source's repository_root return the recorded SHAs.
        const after = read_manifest(archive_dir);
        const after_root = manifest_primary_source(after).repository_root;
        expect(after_root).toBeTruthy();
        expect(after.baseline_commit_shas[after_root]).toBe('baseline-sha-abc');
        expect(after.branch_creation_point_shas[after_root]).toBe('creation-point-def');
        // The stale empty-string key SHALL NOT survive the rewrite.
        expect(Object.hasOwn(after.baseline_commit_shas, '')).toBe(false);
        expect(Object.hasOwn(after.branch_creation_point_shas, '')).toBe(false);
    });

    it('returns existing repository_root without recomputing when manifest has it', () => {
        const id = 'pl-existing';
        const archive_dir = build_archive_path(id);
        fs.mkdirSync(archive_dir, { recursive: true });
        const manifest = create_manifest(
            id,
            [{ host_path: repository, repository_root: repository, source_prefix: '', mount_name: '' }],
            `patchlab-${id}`,
            'node:22-slim',
        );
        write_manifest(archive_dir, manifest);

        const result = resolve_repository_root(id);
        expect(result).toBe(repository);
    });

    it('throws when legacy manifest source_path is no longer in a git repo', () => {
        // Set up a legacy manifest pointing at a non-git path.
        const id = 'pl-relocated';
        const non_git = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-nogit-'));
        try {
            const archive_dir = build_archive_path(id);
            fs.mkdirSync(archive_dir, { recursive: true });
            const legacy = {
                id,
                source_path: non_git,
                repository_root: null,
                source_prefix: '',
                format_version: 0,
                baseline_commit_sha: null,
                branch_creation_point_sha: null,
                created_at: '2026-01-01T00:00:00.000Z',
                container_name: `patchlab-${id}`,
                container_image: 'node:22-slim',
            };
            fs.writeFileSync(
                path.join(archive_dir, 'manifest.json'),
                JSON.stringify(legacy, null, 2),
                'utf-8',
            );

            expect(() => resolve_repository_root(id)).toThrow(/git repository/);
        } finally {
            fs.rmSync(non_git, { recursive: true, force: true });
        }
    });

    it('throws when a modern-shape manifest points repository_root at a non-git directory (tamper guard)', () => {
        // Defense-in-depth: a tampered manifest could redirect git ops (e.g.
        // `git branch -D patchlab/{id}`) into an unrelated repository. The
        // `assert_is_git_repository` guard in `resolve_repository_root`
        // catches the redirect before any git command runs. Distinct from
        // the legacy-null-then-recompute case above — this path is the
        // modern-shape (`sources: [{ ... }]`) branch where repository_root
        // IS a string but doesn't point at a git repo.
        const id = 'pl-tamper-modern';
        const non_git = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-nogit-modern-'));
        try {
            const archive_dir = build_archive_path(id);
            fs.mkdirSync(archive_dir, { recursive: true });
            const tampered = {
                id,
                sources: [{
                    host_path: non_git,
                    repository_root: non_git,
                    source_prefix: '',
                    mount_name: '',
                }],
                baseline_commit_shas: { [non_git]: null },
                branch_creation_point_shas: { [non_git]: null },
                format_version: 0,
                created_at: '2026-01-01T00:00:00.000Z',
                container_name: `patchlab-${id}`,
                container_image: 'node:22-slim',
            };
            fs.writeFileSync(
                path.join(archive_dir, 'manifest.json'),
                JSON.stringify(tampered, null, 2),
                'utf-8',
            );

            expect(() => resolve_repository_root(id))
                .toThrow(/manifest points repository_root|tampered/);
        } finally {
            fs.rmSync(non_git, { recursive: true, force: true });
        }
    });
});

// Hoisted fixture: each test creates a patchlab branch with a DISTINCT id
// (pl-mpx-empty / -one / -union / -zero) and reads only its own branch, so
// the branches accumulate harmlessly across the shared fixture. A future
// test that asserts "this is the only patchlab branch in the repository"
// would break under sharing — declare a per-test repository in that case.
describe('list_branch_files: per-source signature (multi-source-extraction task 3.5)', () => {
    install_isolated_home_hooks('patchlab-mpx-home-', { scope: 'all' });
    let repository: string;

    beforeAll(() => {
        repository = canonical_host_path(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-mpx-repo-')));
        execFileSync('git', ['init'], { cwd: repository, stdio: 'pipe' });
        // Populate three subpaths plus a top-level file.
        fs.mkdirSync(path.join(repository, 'src', 'ui'), { recursive: true });
        fs.mkdirSync(path.join(repository, 'src', 'server'), { recursive: true });
        fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repository, 'README.md'), 'top\n');
        fs.writeFileSync(path.join(repository, 'src', 'ui', 'app.tsx'), 'ui\n');
        fs.writeFileSync(path.join(repository, 'src', 'server', 'routes.ts'), 'server\n');
        fs.writeFileSync(path.join(repository, 'docs', 'index.md'), 'docs\n');
        execFileSync('git', ['add', '-A'], { cwd: repository, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'init'], { cwd: repository, env: GIT_TEST_ENVIRONMENT, stdio: 'pipe' });
    });

    afterAll(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('lists every repo-relative file when source_prefix is empty (single-source-at-repo-root)', () => {
        const id = 'pl-mpx-empty';
        create_patchlab_branch(repository, id);
        const files = list_branch_files(repository, patchlab_branch_name(id), '');
        expect(new Set(files)).toEqual(new Set([
            'README.md',
            'src/ui/app.tsx',
            'src/server/routes.ts',
            'docs/index.md',
        ]));
    });

    it('scopes the listing to a single non-empty source_prefix and returns prefix-relative paths', () => {
        const id = 'pl-mpx-one';
        create_patchlab_branch(repository, id);
        const files = list_branch_files(repository, patchlab_branch_name(id), 'src/ui');
        // Returned paths are RELATIVE to source_prefix — callers prepend
        // mount_name to build container-relative keys for the overlay.
        expect(files).toEqual(['app.tsx']);
    });

    it('callers union prefix-relative results across sources by prepending mount_name', () => {
        // Demonstrates the multi-source pattern: each source's branch-tip
        // files are listed independently; the caller composes the union.
        const id = 'pl-mpx-union';
        const branch = patchlab_branch_name(id);
        create_patchlab_branch(repository, id);
        const ui_files = list_branch_files(repository, branch, 'src/ui').map((f) => `ui-mount/${f}`);
        const server_files = list_branch_files(repository, branch, 'src/server').map((f) => `server-mount/${f}`);
        const union = new Set([...ui_files, ...server_files]);
        expect(union).toEqual(new Set([
            'ui-mount/app.tsx',
            'server-mount/routes.ts',
        ]));
    });

    it('returns empty when the branch does not exist', () => {
        // No create_patchlab_branch — branch absent.
        const files = list_branch_files(repository, patchlab_branch_name('pl-mpx-missing'), 'src/ui');
        expect(files).toEqual([]);
    });

    it('returns empty for a source_prefix that matches zero files at the branch tip (regression: opus-1)', () => {
        const id = 'pl-mpx-zero';
        create_patchlab_branch(repository, id);
        const files = list_branch_files(repository, patchlab_branch_name(id), 'nonexistent/subpath');
        expect(files).toEqual([]);
    });
});

describe('resolve_repository_root: legacy synthesis with non-empty source_prefix', () => {
    install_isolated_home_hooks('patchlab-legacysync-home-');
    let repository: string;

    beforeEach(() => {
        repository = canonical_host_path(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-legacysync-repo-')));
        execFileSync('git', ['init'], { cwd: repository, stdio: 'pipe' });
        fs.mkdirSync(path.join(repository, 'src', 'ui'), { recursive: true });
        fs.writeFileSync(path.join(repository, 'src', 'ui', 'app.tsx'), 'ui\n');
        execFileSync('git', ['add', '-A'], { cwd: repository, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'init'], { cwd: repository, env: GIT_TEST_ENVIRONMENT, stdio: 'pipe' });
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('legacy manifest with null repository_root AND non-empty source_prefix recomputes host_path via join (regression: opus-2)', () => {
        // A pre-multi-source legacy manifest with repository_root: null and
        // source_prefix: "src/ui" must NOT have its host_path collapsed to
        // the recomputed repository_root alone — that would break the
        // writer invariant `host_path === path.join(repository_root,
        // source_prefix)` on the next write.
        const id = 'pl-legacysync-subdir';
        const archive_directory = build_archive_path(id);
        fs.mkdirSync(archive_directory, { recursive: true });

        const subdir = path.join(repository, 'src', 'ui');
        const legacy = {
            id,
            source_path: subdir,
            repository_root: null,
            source_prefix: 'src/ui',
            format_version: 0,
            baseline_commit_sha: null,
            branch_creation_point_sha: null,
            created_at: '2026-01-01T00:00:00.000Z',
            container_name: `patchlab-${id}`,
            container_image: 'node:22-slim',
        };
        fs.writeFileSync(
            path.join(archive_directory, 'manifest.json'),
            JSON.stringify(legacy, null, 2),
            'utf-8',
        );

        // resolve_repository_root triggers the recompute-and-persist
        // codepath. The bug (now fixed) would corrupt host_path here.
        const result = resolve_repository_root(id);
        expect(compare_host_path(result)).toBe(compare_host_path(repository));

        // After the recompute, the manifest on disk must satisfy the
        // writer invariant. Reading it back exercises the host_path
        // validation in read_manifest.
        const after = read_manifest(archive_directory);
        const primary = after.sources[0];
        expect(primary.source_prefix).toBe('src/ui');
        expect(primary.repository_root).toBeTruthy();
        // host_path should equal path.join(repository_root, source_prefix)
        // — read_manifest would have rejected the manifest otherwise.
        const joined = `${primary.repository_root.replaceAll('\\', '/')}/${primary.source_prefix}`;
        expect(primary.host_path.replaceAll('\\', '/')).toBe(joined);
    });
});

describe('is_empty_subtree_archive_error', () => {
    it('matches "fatal: not a tree object"', () => {
        expect(is_empty_subtree_archive_error('fatal: not a tree object\n')).toBe(true);
    });

    it('matches "fatal: Not a valid object name" with the branch:prefix detail', () => {
        expect(
            is_empty_subtree_archive_error(
                "fatal: Not a valid object name 'patchlab/abc:deleted-prefix'\n",
            ),
        ).toBe(true);
    });

    it('matches when the marker appears after preceding stderr noise', () => {
        // git can emit progress to stderr before the fatal line.
        const stderr = 'warning: gitignore patterns conflict\nfatal: not a tree object\n';
        expect(is_empty_subtree_archive_error(stderr)).toBe(true);
    });

    it('does not match permission errors', () => {
        expect(
            is_empty_subtree_archive_error("fatal: could not open '.git/HEAD': Permission denied\n"),
        ).toBe(false);
    });

    it('does not match bad revision errors (real failure: branch missing or malformed)', () => {
        expect(
            is_empty_subtree_archive_error("fatal: bad revision 'patchlab/nope'\n"),
        ).toBe(false);
    });

    it('does not match pathspec-no-match (we pre-filter pathspecs, so this means a real config issue)', () => {
        expect(
            is_empty_subtree_archive_error("fatal: pathspec 'foo' did not match any files\n"),
        ).toBe(false);
    });

    it('does not match empty stderr (process killed, missing binary, etc.)', () => {
        expect(is_empty_subtree_archive_error('')).toBe(false);
    });
});

// Hoisted fixture: the first four tests are read-only inspections; the
// final test creates a patchlab branch but is declared last so its mutation
// can't leak into earlier tests. Vitest preserves declaration order within
// a describe, so this ordering is the contract a future maintainer must
// preserve when adding tests here.
describe('branch: repository-reachability and named-branch helpers', () => {
    let repository: string;
    let scratch: string;

    beforeAll(() => {
        repository = canonical_host_path(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-isgit-')),
        );
        initialize_repository_with_initial_commit(repository);
        scratch = canonical_host_path(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-notgit-')),
        );
    });

    afterAll(() => {
        fs.rmSync(repository, { recursive: true, force: true });
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    it('is_git_repository returns true for an initialized repository', () => {
        expect(is_git_repository(repository)).toBe(true);
    });

    it('is_git_repository returns false for an ordinary directory', () => {
        expect(is_git_repository(scratch)).toBe(false);
    });

    it('branch_exists returns true for the default branch of a fresh repo', () => {
        const default_branch = read_default_branch(repository);
        expect(branch_exists(repository, default_branch)).toBe(true);
    });

    it('branch_exists returns false for a branch name that was never created', () => {
        expect(branch_exists(repository, 'never-created')).toBe(false);
    });

    it('branch_exists returns true for a created patchlab/<id> ref', () => {
        create_patchlab_branch(repository, 'pl-be');
        expect(branch_exists(repository, 'patchlab/pl-be')).toBe(true);
    });
});

// Hoisted fixture: every test in this describe (other than the branch-
// deletion case below) reads the patchlab branch tip or a temp worktree
// without mutating the branch's refs. Sharing the fixture across 7 tests
// saves ~6 × 700 ms ≈ 4 seconds on Windows. The branch-deletion case lives
// in its own sibling describe so the destructive `branch -D` doesn't leak
// into the shared fixture.
describe('branch: cumulative-diff resolvers', () => {
    install_isolated_home_hooks('patchlab-diff-home-', { scope: 'all' });
    let repository: string;

    /** SHA of the repo's first commit — used as the synthetic `branch_creation_point`. */
    let initial_sha: string;
    /** Synthetic `baseline_commit_sha` — the first appended commit on the patchlab branch. */
    let baseline_sha: string;
    /** SHA of the second appended commit on the patchlab branch. */
    let second_commit_sha: string;

    const PATCHLAB_ID = 'pl-diff';
    const BRANCH = patchlab_branch_name(PATCHLAB_ID);

    function append_commit_to_branch(message: string, file_name: string, content: string): string {
        const default_branch = read_default_branch(repository);
        execFileSync('git', ['checkout', '-b', 'temp-work', BRANCH], { cwd: repository });
        fs.writeFileSync(path.join(repository, file_name), content);
        execFileSync('git', ['add', '-A'], { cwd: repository });
        execFileSync('git', ['commit', '-m', message], { cwd: repository, env: GIT_TEST_ENVIRONMENT });
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: repository, encoding: 'utf-8',
        }).trim();
        execFileSync('git', ['checkout', default_branch], { cwd: repository });
        execFileSync('git', ['branch', '-D', 'temp-work'], { cwd: repository });
        execFileSync('git', ['update-ref', `refs/heads/${BRANCH}`, sha], { cwd: repository });
        return sha;
    }

    beforeAll(() => {
        repository = canonical_host_path(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-diff-')),
        );
        initialize_repository_with_initial_commit(repository);
        initial_sha = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: repository, encoding: 'utf-8',
        }).trim();

        create_patchlab_branch(repository, PATCHLAB_ID);
        baseline_sha = append_commit_to_branch('first session', 'one.txt', 'one\n');
        second_commit_sha = append_commit_to_branch('second session', 'two.txt', 'two\n');
    });

    afterAll(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    describe('resolve_diff_start_reference', () => {
        it('returns the baseline_commit_sha when present (priority 1)', () => {
            const start = resolve_diff_start_reference(repository, PATCHLAB_ID, baseline_sha, initial_sha);
            expect(start).toBe(baseline_sha);
        });

        it('falls back to branch_creation_point_sha when baseline is null', () => {
            const start = resolve_diff_start_reference(repository, PATCHLAB_ID, null, initial_sha);
            expect(start).toBe(initial_sha);
        });
    });

    describe('read_cumulative_diff', () => {
        it('returns an empty string when no starting point can be derived (no baseline, no creation point, no other branches)', () => {
            // Pristine baseline + no other refs → merge-base fallback finds nothing.
            const fresh_id = 'pl-empty';
            create_patchlab_branch(repository, fresh_id);
            expect(read_cumulative_diff(repository, fresh_id, null, null)).toBe('');
        });

        it('renders the diff for baseline_sha..tip when a baseline is supplied', () => {
            const diff = read_cumulative_diff(repository, PATCHLAB_ID, baseline_sha, initial_sha);
            // baseline → tip = just the second commit's addition.
            expect(diff).toContain('two.txt');
            expect(diff).toContain('+two');
            expect(diff).not.toContain('one.txt');
        });

        it('renders the diff for creation_point..tip when only creation point is supplied', () => {
            const diff = read_cumulative_diff(repository, PATCHLAB_ID, null, initial_sha);
            // creation_point → tip = both appended commits.
            expect(diff).toContain('one.txt');
            expect(diff).toContain('two.txt');
        });
    });

    describe('read_commit_diff', () => {
        it('returns the unified diff for a single commit against its first parent', () => {
            const diff = read_commit_diff(repository, second_commit_sha);
            // The second commit added only two.txt.
            expect(diff).toContain('two.txt');
            expect(diff).toContain('+two');
            expect(diff).not.toContain('one.txt');
        });
    });

    describe('compose_diff_against_baseline_with_pending', () => {
        it('composes a coherent diff covering the branch tip plus a pending patch', () => {
            // A minimal valid unified diff adding a new file at the worktree root.
            const pending = [
                'diff --git a/pending.txt b/pending.txt',
                'new file mode 100644',
                'index 0000000..d95f3ad',
                '--- /dev/null',
                '+++ b/pending.txt',
                '@@ -0,0 +1 @@',
                '+pending content',
                '',
            ].join('\n');

            const composed = compose_diff_against_baseline_with_pending(
                repository,
                PATCHLAB_ID,
                baseline_sha,
                Buffer.from(pending, 'utf-8'),
            );
            // The composition covers baseline..tip + pending. baseline → tip
            // already added two.txt; pending adds pending.txt — both belong.
            expect(composed).toContain('two.txt');
            expect(composed).toContain('pending.txt');
            expect(composed).toContain('+pending content');
        });

        it('throws when the pending patch cannot be applied to the branch tip', () => {
            // A patch that modifies a non-existent file's non-existent context will be rejected.
            const broken = [
                'diff --git a/ghost.txt b/ghost.txt',
                '--- a/ghost.txt',
                '+++ b/ghost.txt',
                '@@ -1,1 +1,1 @@',
                '-old line that does not exist',
                '+new line',
                '',
            ].join('\n');

            expect(() => compose_diff_against_baseline_with_pending(
                repository,
                PATCHLAB_ID,
                baseline_sha,
                Buffer.from(broken, 'utf-8'),
            )).toThrow();
        });

        it('cleans up the temporary worktree after a successful composition', () => {
            const tmp_before = new Set(
                fs.readdirSync(os.tmpdir())
                    .filter((entry) => entry.startsWith('patchlab-diff-wt-')),
            );
            const pending = [
                'diff --git a/cleanup.txt b/cleanup.txt',
                'new file mode 100644',
                'index 0000000..0000001',
                '--- /dev/null',
                '+++ b/cleanup.txt',
                '@@ -0,0 +1 @@',
                '+x',
                '',
            ].join('\n');

            compose_diff_against_baseline_with_pending(repository, PATCHLAB_ID, baseline_sha, Buffer.from(pending, 'utf-8'));

            const tmp_after = fs.readdirSync(os.tmpdir())
                .filter((entry) => entry.startsWith('patchlab-diff-wt-'));
            const leaked = tmp_after.filter((entry) => !tmp_before.has(entry));
            expect(leaked).toEqual([]);
        });
    });
});

// Separate describe so the branch-deletion mutator gets its own fresh
// fixture without contaminating the hoisted fixture above. The single test
// here is the only mutator in the cumulative-diff resolvers group.
describe('branch: cumulative-diff resolvers — branch-deletion case', () => {
    install_isolated_home_hooks('patchlab-diff-deletion-home-');
    let repository: string;

    const PATCHLAB_ID = 'pl-diff-deletion';
    const BRANCH = patchlab_branch_name(PATCHLAB_ID);

    beforeEach(() => {
        repository = canonical_host_path(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-diff-deletion-')),
        );
        initialize_repository_with_initial_commit(repository);
        create_patchlab_branch(repository, PATCHLAB_ID);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('resolve_diff_start_reference throws when the patchlab branch does not exist in the repository', () => {
        const initial_sha = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: repository, encoding: 'utf-8',
        }).trim();
        execFileSync('git', ['branch', '-D', BRANCH], { cwd: repository });
        expect(() => resolve_diff_start_reference(repository, PATCHLAB_ID, initial_sha, initial_sha))
            .toThrow(/does not exist/);
    });
});

