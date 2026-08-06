import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
    apply_patchlab_branch,
    create_patchlab_branch,
    list_session_commits,
} from '../../src/branch/index.js';
import { apply_patch, apply_patch_file } from '../../src/apply.js';
import {
    build_archive_path,
    write_session_metadata,
    type Session_Metadata,
} from '../../src/archive.js';
import { create_manifest, read_manifest, write_manifest } from '../../src/manifest.js';
import {
    GIT_TEST_ENVIRONMENT,
    initialize_repository_with_initial_commit,
    read_default_branch,
    resolve_revision,
    run_git_silently,
} from '../helpers/git_repository.js';
import { install_isolated_home_hooks } from '../helpers/home_directory.js';

interface Setup_Result {
    repository: string;
    patchlab_id: string;
    default_branch: string;
}

function git(repository: string, args: string[]): string {
    return execFileSync('git', args, {
        cwd: repository,
        env: GIT_TEST_ENVIRONMENT,
        encoding: 'utf-8',
    });
}

function init_test_repository(repository: string): string {
    initialize_repository_with_initial_commit(repository);
    return read_default_branch(repository);
}

function write_session(
    patchlab_id: string,
    session_number: number,
    overrides: { commit_sha?: string | null }
): void {
    // Derive the per-repo key from the patchlab's manifest so the session
    // metadata's map keys line up with what `list_session_commits` /
    // `apply_patchlab_branch` look up from the manifest.
    const manifest = read_manifest(build_archive_path(patchlab_id));
    const primary_repo = manifest.sources[0].repository_root;
    const metadata: Session_Metadata = {
        session_number,
        created_at: new Date().toISOString(),
        completed_at: null,
        status: 'completed',
        tool: 'gemini-cli-oauth',
        container_name: null,
        commit_shas: { [primary_repo]: overrides.commit_sha ?? null },
        fallback_patches: { [primary_repo]: null },
        resource_limits: null,
    };
    write_session_metadata(patchlab_id, session_number, metadata);
}

/**
 * Add a session commit to a patchlab branch with a single-file change.
 * Records the new commit SHA in session metadata.
 */
function add_session_commit(
    repository: string,
    patchlab_id: string,
    session_number: number,
    file_path: string,
    new_content: string
): string {
    const branch = `patchlab/${patchlab_id}`;
    const branch_tip = resolve_revision(repository, `refs/heads/${branch}`);

    // Build new tree by checking out the branch tip into a temporary index, applying the change.
    const temporary_index = path.join(
        os.tmpdir(),
        `patchlab-test-${patchlab_id}-${session_number}-${Date.now()}.idx`
    );
    try {
        execFileSync('git', ['read-tree', branch_tip], {
            cwd: repository,
            env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
        });

        // Write the new file blob and stage it via update-index.
        const blob_sha = execFileSync('git', ['hash-object', '-w', '--stdin'], {
            cwd: repository,
            env: GIT_TEST_ENVIRONMENT,
            input: new_content,
            encoding: 'utf-8',
        }).trim();

        execFileSync(
            'git',
            ['update-index', '--add', '--cacheinfo', `100644,${blob_sha},${file_path}`],
            {
                cwd: repository,
                env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
            }
        );

        const tree_sha = execFileSync('git', ['write-tree'], {
            cwd: repository,
            env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
            encoding: 'utf-8',
        }).trim();

        const commit_sha = execFileSync(
            'git',
            ['commit-tree', tree_sha, '-p', branch_tip, '-m', `session ${session_number}`],
            { cwd: repository, env: GIT_TEST_ENVIRONMENT, encoding: 'utf-8' }
        ).trim();

        execFileSync('git', ['update-ref', `refs/heads/${branch}`, commit_sha], {
            cwd: repository,
            env: GIT_TEST_ENVIRONMENT,
        });

        write_session(patchlab_id, session_number, { commit_sha });
        return commit_sha;
    } finally {
        try {
            fs.unlinkSync(temporary_index);
        } catch (_ignored) {
            /* already gone */
        }
    }
}

function setup_patchlab(
    repository: string,
    patchlab_id: string,
    options?: { capture_dirty_baseline?: boolean }
): { default_branch: string; baseline_commit_sha: string | null } {
    const default_branch = read_default_branch(repository);

    const archive_directory = build_archive_path(patchlab_id);
    fs.mkdirSync(archive_directory, { recursive: true });

    const branch_result = create_patchlab_branch(repository, patchlab_id, options);

    const manifest = create_manifest(
        patchlab_id,
        [{ host_path: repository, repository_root: repository, source_prefix: '', mount_name: '' }],
        'unused',
        'unused',
        {
            baseline_commit_sha: branch_result.baseline_sha,
        },
    );
    write_manifest(archive_directory, manifest);

    return {
        default_branch,
        baseline_commit_sha: branch_result.baseline_sha,
    };
}

describe('apply_patchlab_branch', () => {
    install_isolated_home_hooks('patchlab-apply-home-');
    let repository: string;

    beforeEach(() => {
        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-apply-repo-')));
        init_test_repository(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('cherry-picks session commits in order (4.1)', () => {
        const setup: Setup_Result = {
            repository,
            patchlab_id: 'pl-order',
            default_branch: read_default_branch(repository),
        };
        setup_patchlab(repository, setup.patchlab_id);

        const sha_one = add_session_commit(repository, setup.patchlab_id, 1, 'a.txt', 'first\n');
        const sha_two = add_session_commit(repository, setup.patchlab_id, 2, 'b.txt', 'second\n');

        const result = apply_patchlab_branch(repository, setup.patchlab_id);
        expect(result.applied.map((item) => item.session_number)).toEqual([1, 2]);
        expect(result.applied.map((item) => item.commit_sha)).toEqual([sha_one, sha_two]);
        expect(result.conflict).toBeUndefined();

        expect(fs.readFileSync(path.join(repository, 'a.txt'), 'utf-8')).toBe('first\n');
        expect(fs.readFileSync(path.join(repository, 'b.txt'), 'utf-8')).toBe('second\n');
    });

    it('--session N cherry-picks only that session via metadata SHA (4.2)', () => {
        const patchlab_id = 'pl-single';
        setup_patchlab(repository, patchlab_id);
        add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');
        const sha_two = add_session_commit(repository, patchlab_id, 2, 'b.txt', 'second\n');

        const result = apply_patchlab_branch(repository, patchlab_id, { session_number: 2 });
        expect(result.applied).toEqual([
            { session_number: 2, commit_sha: sha_two },
        ]);
        expect(fs.existsSync(path.join(repository, 'a.txt'))).toBe(false);
        expect(fs.readFileSync(path.join(repository, 'b.txt'), 'utf-8')).toBe('second\n');
    });

    it('--merge produces a merge commit (4.3)', () => {
        const patchlab_id = 'pl-merge';
        setup_patchlab(repository, patchlab_id);
        add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');

        const head_before = resolve_revision(repository, 'HEAD');
        const result = apply_patchlab_branch(repository, patchlab_id, { mode: 'merge-commit' });
        expect(result.merge_commit_sha).toBeDefined();
        const head_after = resolve_revision(repository, 'HEAD');
        expect(head_after).not.toBe(head_before);

        const parents = git(repository, ['rev-list', '--parents', '-n', '1', head_after]).trim().split(' ');
        expect(parents.length).toBeGreaterThanOrEqual(3);  // self + two parents = merge commit
    });

    it('--merge=squash produces a single new commit (4.4)', () => {
        const patchlab_id = 'pl-squash';
        setup_patchlab(repository, patchlab_id);
        add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');
        add_session_commit(repository, patchlab_id, 2, 'b.txt', 'second\n');

        const head_before = resolve_revision(repository, 'HEAD');
        const result = apply_patchlab_branch(repository, patchlab_id, { mode: 'merge-squash' });
        expect(result.merge_commit_sha).toBeDefined();

        const head_after = resolve_revision(repository, 'HEAD');
        const parents = git(repository, ['rev-list', '--parents', '-n', '1', head_after]).trim().split(' ');
        // Squash produces a single-parent commit (self + 1 parent).
        expect(parents.length).toBe(2);
        expect(parents[1]).toBe(head_before);

        expect(fs.readFileSync(path.join(repository, 'a.txt'), 'utf-8')).toBe('first\n');
        expect(fs.readFileSync(path.join(repository, 'b.txt'), 'utf-8')).toBe('second\n');
    });

    it('skips already-applied sessions detected via git cherry (4.5)', () => {
        const patchlab_id = 'pl-skip';
        setup_patchlab(repository, patchlab_id);
        const sha_one = add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');
        add_session_commit(repository, patchlab_id, 2, 'b.txt', 'second\n');

        // Pre-apply session 1 by cherry-picking it onto the default branch.
        run_git_silently(repository, ['cherry-pick', sha_one]);

        const result = apply_patchlab_branch(repository, patchlab_id);
        const applied_sessions = result.applied.map((item) => item.session_number);
        const skipped_sessions = result.skipped.map((item) => item.session_number);
        expect(skipped_sessions).toContain(1);
        expect(applied_sessions).toContain(2);
    });

    it('--include-baseline cherry-picks the baseline commit before sessions (4.6)', () => {
        const patchlab_id = 'pl-baseline';
        // Pre-create dirty state: a file outside the initial commit that becomes the baseline.
        fs.writeFileSync(path.join(repository, 'wip.txt'), 'work in progress\n');
        const setup_result = setup_patchlab(repository, patchlab_id, { capture_dirty_baseline: true });
        expect(setup_result.baseline_commit_sha).not.toBeNull();

        // Reset working tree to match HEAD so the cherry-pick of the baseline reapplies the file.
        fs.unlinkSync(path.join(repository, 'wip.txt'));
        // Stage the deletion so the working tree matches HEAD before apply.
        // (We need to commit it so HEAD truly matches the working tree state.)
        // Actually the working tree just needs to be clean at apply time.

        add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');

        const result = apply_patchlab_branch(repository, patchlab_id, { include_baseline: true });
        const applied_sessions = result.applied.map((item) => item.session_number);
        expect(applied_sessions).toContain(null);  // baseline appears as null session_number
        expect(applied_sessions).toContain(1);
        expect(fs.readFileSync(path.join(repository, 'wip.txt'), 'utf-8')).toBe('work in progress\n');
        expect(fs.readFileSync(path.join(repository, 'a.txt'), 'utf-8')).toBe('first\n');
    });

    it('skips sessions whose commit_sha is null (4.7)', () => {
        const patchlab_id = 'pl-null';
        setup_patchlab(repository, patchlab_id);

        // Session 1 has null SHA (no code changes); session 2 has a real commit.
        write_session(patchlab_id, 1, { commit_sha: null });
        const sha_two = add_session_commit(repository, patchlab_id, 2, 'b.txt', 'second\n');

        const reference_list = list_session_commits(patchlab_id, repository);
        expect(reference_list).toEqual([{ session_number: 2, commit_sha: sha_two }]);

        const result = apply_patchlab_branch(repository, patchlab_id);
        expect(result.applied.map((item) => item.session_number)).toEqual([2]);
    });

    it('surfaces git errors and reports submodule paths on conflict (4.8)', () => {
        const patchlab_id = 'pl-submodule';
        // Declare a submodule entry on the host before creating the patchlab branch.
        fs.writeFileSync(
            path.join(repository, '.gitmodules'),
            '[submodule "vendor/foo"]\n\tpath = vendor/foo\n\turl = https://example.com/foo.git\n'
        );
        run_git_silently(repository, ['add', '.gitmodules']);
        run_git_silently(repository, ['commit', '-m', 'add gitmodules']);

        setup_patchlab(repository, patchlab_id);

        // Add a session commit that touches a path inside the submodule directory.
        const conflicting_sha = add_session_commit(
            repository,
            patchlab_id,
            1,
            'vendor/foo/file.txt',
            'inside submodule\n'
        );

        // Make a divergent change on the default branch to produce a conflict.
        fs.mkdirSync(path.join(repository, 'vendor', 'foo'), { recursive: true });
        fs.writeFileSync(
            path.join(repository, 'vendor', 'foo', 'file.txt'),
            'host content\n'
        );
        run_git_silently(repository, ['add', '-A']);
        run_git_silently(repository, ['commit', '-m', 'host change in submodule directory']);

        const result = apply_patchlab_branch(repository, patchlab_id);
        // The session and host commits add the SAME path with different content,
        // which always conflicts under cherry-pick — so the conflict is
        // deterministic and asserted unconditionally. Hedging behind
        // `if (result.conflict)` would let a regression that stopped reporting
        // conflicts at all slide through this test green, defeating its purpose
        // (conflict reporting is the user's only signal that an apply half-landed).
        expect(result.conflict).toBeDefined();
        expect(result.conflict?.commit_sha).toBe(conflicting_sha);
        expect(result.conflict?.submodule_paths).toEqual(['vendor/foo']);
    });

    /* merge-mode flag handling. */

    it('rejects --session N combined with --merge (cherry-pick covers per-session)', () => {
        const patchlab_id = 'pl-session-merge';
        setup_patchlab(repository, patchlab_id);
        add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');

        expect(() =>
            apply_patchlab_branch(repository, patchlab_id, {
                mode: 'merge-commit',
                session_number: 1,
            })
        ).toThrow(/--session N is only supported in cherry-pick mode/);
    });

    it('rejects --session N combined with --merge=squash', () => {
        const patchlab_id = 'pl-session-squash';
        setup_patchlab(repository, patchlab_id);
        add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');

        expect(() =>
            apply_patchlab_branch(repository, patchlab_id, {
                mode: 'merge-squash',
                session_number: 1,
            })
        ).toThrow(/--session N is only supported in cherry-pick mode/);
    });

    it('rejects --merge=commit when a baseline exists and --include-baseline is not set', () => {
        const patchlab_id = 'pl-merge-baseline';
        // Dirty working tree at create → baseline commit on the patchlab branch.
        fs.writeFileSync(path.join(repository, 'wip.txt'), 'work in progress\n');
        setup_patchlab(repository, patchlab_id, { capture_dirty_baseline: true });
        add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');

        expect(() =>
            apply_patchlab_branch(repository, patchlab_id, { mode: 'merge-commit' })
        ).toThrow(/--include-baseline when the patchlab has a baseline commit/);
    });

    it('--merge=squash without --include-baseline excludes the baseline via diff-and-apply', () => {
        const patchlab_id = 'pl-squash-exclude-baseline';
        // Dirty working tree at create → baseline commit captures it.
        fs.writeFileSync(path.join(repository, 'wip.txt'), 'work in progress\n');
        setup_patchlab(repository, patchlab_id, { capture_dirty_baseline: true });

        // Reset host working tree to clean (matches default branch HEAD) so git apply
        // has clean state to apply onto.
        fs.unlinkSync(path.join(repository, 'wip.txt'));

        add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');

        const head_before = resolve_revision(repository, 'HEAD');
        const result = apply_patchlab_branch(repository, patchlab_id, { mode: 'merge-squash' });
        expect(result.merge_commit_sha).toBeDefined();
        expect(result.conflict).toBeUndefined();

        const head_after = resolve_revision(repository, 'HEAD');
        const parents = git(repository, ['rev-list', '--parents', '-n', '1', head_after]).trim().split(' ');
        // Squash → single-parent commit.
        expect(parents.length).toBe(2);
        expect(parents[1]).toBe(head_before);

        // Session content is on the current branch — but wip.txt (baseline content) is NOT.
        expect(fs.readFileSync(path.join(repository, 'a.txt'), 'utf-8')).toBe('first\n');
        expect(fs.existsSync(path.join(repository, 'wip.txt'))).toBe(false);
    });

    it('--merge=squash with --include-baseline still merges everything', () => {
        const patchlab_id = 'pl-squash-include-baseline';
        fs.writeFileSync(path.join(repository, 'wip.txt'), 'work in progress\n');
        setup_patchlab(repository, patchlab_id, { capture_dirty_baseline: true });
        fs.unlinkSync(path.join(repository, 'wip.txt'));

        add_session_commit(repository, patchlab_id, 1, 'a.txt', 'first\n');

        const result = apply_patchlab_branch(repository, patchlab_id, {
            mode: 'merge-squash',
            include_baseline: true,
        });
        expect(result.merge_commit_sha).toBeDefined();

        // Both baseline content (wip.txt) and session content (a.txt) end up on the branch.
        expect(fs.readFileSync(path.join(repository, 'a.txt'), 'utf-8')).toBe('first\n');
        expect(fs.readFileSync(path.join(repository, 'wip.txt'), 'utf-8')).toBe('work in progress\n');
    });

    it('throws when the patchlab branch does not exist in the repository', () => {
        // `apply_patchlab_branch`'s pre-flight rejects before any cherry-pick
        // or merge work runs — surfacing a clear error if the user typed the
        // wrong id or the branch was deleted out from under them. Without
        // this check, downstream `git cherry-pick` would fail with a less
        // actionable "unknown revision" message.
        const patchlab_id = 'pl-no-branch';
        // No `create_patchlab_branch` call → branch doesn't exist.
        expect(() => apply_patchlab_branch(repository, patchlab_id))
            .toThrow(/does not exist/);
    });

    it('cherry-picks against a detached HEAD (read_current_branch returns "HEAD")', () => {
        // The cherry-pick path calls `read_current_branch`, which runs
        // `git symbolic-ref --short HEAD`. On detached HEAD that exits
        // non-zero and the function returns the literal string 'HEAD' —
        // which `compute_cherry_summary` then passes to `git cherry HEAD
        // <branch>` (still valid syntax). A regression that threw on the
        // symbolic-ref failure instead of falling back to 'HEAD' would
        // break apply against any detached worktree (e.g., a CI runner
        // that checked out a commit by SHA rather than by branch).
        const patchlab_id = 'pl-detached-head';
        setup_patchlab(repository, patchlab_id);
        const session_sha = add_session_commit(
            repository, patchlab_id, 1, 'detached.txt', 'detached body\n',
        );

        // Detach HEAD by checking it out as itself with --detach. The repo
        // is still pointed at the same commit but HEAD is no longer a
        // symbolic ref.
        run_git_silently(repository, ['checkout', '--detach', 'HEAD']);

        const result = apply_patchlab_branch(repository, patchlab_id);
        expect(result.applied).toEqual([
            { session_number: 1, commit_sha: session_sha },
        ]);
        expect(result.conflict).toBeUndefined();
        expect(fs.readFileSync(path.join(repository, 'detached.txt'), 'utf-8'))
            .toBe('detached body\n');
    });
});

// The describe block below covers the host-side `git apply` wrapper
// (`apply_patch` / `apply_patch_file`) — distinct from `apply_patchlab_branch`
// above, which is the cherry-pick/merge engine. The tests originally lived in
// `test/integration/apply.test.ts` and used `create_sandbox` + `generate_patch`
// to author the patch string. After the audit at
// `reports/integration-test-audit.md` flagged the sandbox path as fixture
// overhead (the assertion subject is host-side `git apply`), they were moved
// here with hand-crafted unified-diff fixtures matching the shape
// `generate_patch` would emit byte-for-byte.
describe('apply_patch / apply_patch_file', () => {
    let target_directory: string;

    beforeEach(() => {
        target_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-apply-target-')));
        fs.writeFileSync(path.join(target_directory, 'a.txt'), 'line 1\nline 2\n');
        fs.writeFileSync(path.join(target_directory, 'b.txt'), 'hello\n');
        // Initialize as a git repo so `git apply` has a proper context.
        run_git_silently(target_directory, ['init']);
        run_git_silently(target_directory, ['add', '-A']);
        run_git_silently(target_directory, ['commit', '-m', 'init']);
    });

    afterEach(() => {
        fs.rmSync(target_directory, { recursive: true, force: true });
    });

    it('applies a modification patch', () => {
        // Hand-crafted equivalent of `generate_patch`'s output for changing
        // `line 2` → `line 2 modified` in a.txt. The `git diff` header,
        // file-mode-implicit form (no `new file mode` line for
        // modifications), and unified-diff body match what a sandbox-authored
        // patch would emit byte-for-byte.
        const patch = [
            'diff --git a/a.txt b/a.txt',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1,2 +1,2 @@',
            ' line 1',
            '-line 2',
            '+line 2 modified',
            '',
        ].join('\n');

        const result = apply_patch(target_directory, patch);
        expect(result.success).toBe(true);
        expect(result.failed).toEqual([]);
        expect(result.applied.map((entry) => entry.file_path)).toContain('a.txt');
        expect(fs.readFileSync(path.join(target_directory, 'a.txt'), 'utf-8')).toBe(
            'line 1\nline 2 modified\n'
        );
        // Untouched file survives unchanged.
        expect(fs.readFileSync(path.join(target_directory, 'b.txt'), 'utf-8')).toBe('hello\n');
    });

    it('applies a patch that adds a new file', () => {
        const patch = [
            'diff --git a/new.txt b/new.txt',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/new.txt',
            '@@ -0,0 +1 @@',
            '+brand new',
            '',
        ].join('\n');

        const result = apply_patch(target_directory, patch);
        expect(result.success).toBe(true);
        expect(result.failed).toEqual([]);
        expect(result.applied.map((entry) => entry.file_path)).toContain('new.txt');
        expect(fs.readFileSync(path.join(target_directory, 'new.txt'), 'utf-8')).toBe(
            'brand new\n'
        );
        // Pre-existing files survive unchanged.
        expect(fs.readFileSync(path.join(target_directory, 'a.txt'), 'utf-8')).toBe('line 1\nline 2\n');
        expect(fs.readFileSync(path.join(target_directory, 'b.txt'), 'utf-8')).toBe('hello\n');
    });

    it('applies a patch that deletes a file', () => {
        const patch = [
            'diff --git a/b.txt b/b.txt',
            'deleted file mode 100644',
            '--- a/b.txt',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-hello',
            '',
        ].join('\n');

        const result = apply_patch(target_directory, patch);
        expect(result.success).toBe(true);
        expect(result.failed).toEqual([]);
        expect(result.applied.map((entry) => entry.file_path)).toContain('b.txt');
        expect(fs.existsSync(path.join(target_directory, 'b.txt'))).toBe(false);
        // Untouched file survives unchanged.
        expect(fs.readFileSync(path.join(target_directory, 'a.txt'), 'utf-8')).toBe('line 1\nline 2\n');
    });

    it('dry-run does not modify files', () => {
        const patch = [
            'diff --git a/a.txt b/a.txt',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1,2 +1 @@',
            '-line 1',
            '-line 2',
            '+changed',
            '',
        ].join('\n');

        const result = apply_patch(target_directory, patch, { dry_run: true });
        expect(result.success).toBe(true);
        expect(result.failed).toEqual([]);
        // Every file in the target survives unchanged — broader than just
        // asserting a.txt, since a dry-run regression could partially apply.
        expect(fs.readFileSync(path.join(target_directory, 'a.txt'), 'utf-8')).toBe(
            'line 1\nline 2\n'
        );
        expect(fs.readFileSync(path.join(target_directory, 'b.txt'), 'utf-8')).toBe('hello\n');
    });

    it('applies from a patch file', () => {
        const patch = [
            'diff --git a/a.txt b/a.txt',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1,2 +1 @@',
            '-line 1',
            '-line 2',
            '+patched from file',
            '',
        ].join('\n');

        const patch_path = path.join(os.tmpdir(), `patchlab-test-apply-${Date.now()}.patch`);
        try {
            fs.writeFileSync(patch_path, patch, 'utf-8');
            const result = apply_patch_file(target_directory, patch_path);
            expect(result.success).toBe(true);
            expect(result.failed).toEqual([]);
            expect(result.applied.map((entry) => entry.file_path)).toContain('a.txt');
            expect(fs.readFileSync(path.join(target_directory, 'a.txt'), 'utf-8')).toBe(
                'patched from file\n'
            );
            expect(fs.readFileSync(path.join(target_directory, 'b.txt'), 'utf-8')).toBe('hello\n');
        } finally {
            fs.unlinkSync(patch_path);
        }
    });

    it('partial failure when source has diverged', () => {
        // Moved verbatim from `test/integration/integration.test.ts:238` per
        // [openspec change `restructure-integration-test-suite-podman-cost`
        // task 3.3](../../openspec/changes/restructure-integration-test-suite-podman-cost/tasks.md).
        // The corrected assertion shape (honest partial reporting, NOT
        // atomicity) was already in the working tree from the audit's
        // High-priority pass; this move preserves that shape byte-for-byte.
        // The integration version used `create_sandbox` + `generate_patch` to
        // author a patch touching two files; the unit version hand-crafts the
        // same multi-file patch.
        const divergent_directory = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-apply-divergent-')),
        );
        try {
            // Target directory: stable.txt at baseline (apply will succeed),
            // diverged.txt rewritten so its hunk's context can't match.
            fs.writeFileSync(path.join(divergent_directory, 'stable.txt'), 'unchanged\n');
            fs.writeFileSync(
                path.join(divergent_directory, 'diverged.txt'),
                'completely rewritten\nno matching context\n',
            );
            run_git_silently(divergent_directory, ['init']);
            run_git_silently(divergent_directory, ['add', '-A']);
            run_git_silently(divergent_directory, ['commit', '-m', 'init']);

            // Hand-crafted equivalent of `generate_patch` output covering
            // both files. stable.txt's hunk expects `unchanged\n` (matches
            // host) → applies. diverged.txt's hunk expects `line 1\nline 2\n
            // line 3\n` (does NOT match host's `completely rewritten...`) →
            // fails.
            const patch = [
                'diff --git a/stable.txt b/stable.txt',
                '--- a/stable.txt',
                '+++ b/stable.txt',
                '@@ -1 +1 @@',
                '-unchanged',
                '+sandbox stable',
                'diff --git a/diverged.txt b/diverged.txt',
                '--- a/diverged.txt',
                '+++ b/diverged.txt',
                '@@ -1,3 +1,3 @@',
                ' line 1',
                '-line 2',
                '+modified line 2',
                ' line 3',
                '',
            ].join('\n');

            // Capture the host's diverged.txt content right before the apply —
            // this file's hunk will be rejected, so its bytes should survive.
            const diverged_before = fs.readFileSync(
                path.join(divergent_directory, 'diverged.txt'),
                'utf-8',
            );

            const result = apply_patch(divergent_directory, patch);
            expect(result.success).toBe(false);

            // Load-bearing contract is HONEST PARTIAL REPORTING, not atomicity:
            // `git apply` applies file-by-file by default (no `--3way`, no
            // `--whole`), so `stable.txt` succeeds and `diverged.txt` fails. The
            // user MUST be able to tell from the result which files were written
            // and which were not — that's the property a regression here would
            // break, not host-tree byte-identity.
            expect(result.applied.map((entry) => entry.file_path)).toEqual(['stable.txt']);
            expect(result.failed.map((entry) => entry.file_path)).toContain('diverged.txt');

            // The host tree reflects the partial outcome exactly as reported:
            // stable.txt carries the sandbox's content (it was applied) and
            // diverged.txt is byte-identical to its pre-apply state (its hunk
            // was rejected). A regression where `result.applied` named a file
            // that wasn't actually written — or `result.failed` named a file
            // that WAS written — would let the user act on a wrong picture of
            // disk state.
            expect(fs.readFileSync(path.join(divergent_directory, 'stable.txt'), 'utf-8'))
                .toBe('sandbox stable\n');
            expect(fs.readFileSync(path.join(divergent_directory, 'diverged.txt'), 'utf-8'))
                .toBe(diverged_before);
        } finally {
            fs.rmSync(divergent_directory, { recursive: true, force: true });
        }
    });
});
