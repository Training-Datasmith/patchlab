import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
    create_patchlab_branch,
} from '../../../src/branch/index.js';
import {
    build_archive_path,
    write_session_metadata,
    type Session_Metadata,
} from '../../../src/archive.js';
import {
    create_manifest,
    read_manifest,
    write_manifest,
    type Sandbox_Manifest,
} from '../../../src/manifest.js';
import { generate_patch } from '../../../src/patches.js';
import {
    GIT_TEST_ENVIRONMENT,
    initialize_repository_with_initial_commit,
    resolve_revision,
} from '../../helpers/git_repository.js';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';

function add_session_commit(
    repository: string,
    patchlab_id: string,
    session_number: number,
    file_path: string,
    new_content: string
): string {
    const branch = `patchlab/${patchlab_id}`;
    const branch_tip = resolve_revision(repository, `refs/heads/${branch}`);
    const temporary_index = path.join(
        os.tmpdir(),
        `patchlab-test-${patchlab_id}-${session_number}-${Date.now()}.idx`
    );
    try {
        execFileSync('git', ['read-tree', branch_tip], {
            cwd: repository,
            env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
        });
        const blob_sha = execFileSync('git', ['hash-object', '-w', '--stdin'], {
            cwd: repository,
            env: GIT_TEST_ENVIRONMENT,
            input: new_content,
            encoding: 'utf-8',
        }).trim();
        execFileSync('git',
            ['update-index', '--add', '--cacheinfo', `100644,${blob_sha},${file_path}`],
            { cwd: repository, env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index } }
        );
        const tree_sha = execFileSync('git', ['write-tree'], {
            cwd: repository,
            env: { ...GIT_TEST_ENVIRONMENT, GIT_INDEX_FILE: temporary_index },
            encoding: 'utf-8',
        }).trim();
        const commit_sha = execFileSync('git',
            ['commit-tree', tree_sha, '-p', branch_tip, '-m', `session ${session_number}`],
            { cwd: repository, env: GIT_TEST_ENVIRONMENT, encoding: 'utf-8' }
        ).trim();
        execFileSync('git', ['update-ref', `refs/heads/${branch}`, commit_sha], {
            cwd: repository, env: GIT_TEST_ENVIRONMENT,
        });
        const metadata: Session_Metadata = {
            session_number,
            created_at: new Date().toISOString(),
            completed_at: null,
            status: 'completed',
            tool: 'gemini-cli-oauth',
            container_name: null,
            commit_shas: { [repository]: commit_sha },
            fallback_patches: { [repository]: null },
            resource_limits: null,
        };
        write_session_metadata(patchlab_id, session_number, metadata);
        return commit_sha;
    } finally {
        try {
            fs.unlinkSync(temporary_index);
        } catch (_ignored) {
            // gone
        }
    }
}

describe('branch_creation_point_sha persistence', () => {
    install_isolated_home_hooks('patchlab-bcp-home-');
    let repository: string;

    beforeEach(() => {
        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-bcp-repo-')));
        initialize_repository_with_initial_commit(repository);
    });

    afterEach(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    it('create_patchlab_branch returns the host HEAD SHA at branch-creation time (4.1)', () => {
        const head_before = resolve_revision(repository, 'HEAD');
        const result = create_patchlab_branch(repository, 'pl-cp-clean');
        expect(result.branch_creation_point_sha).toBe(head_before);
    });

    it('create_patchlab_branch records the creation point even when a baseline commit is created (4.1)', () => {
        const head_before = resolve_revision(repository, 'HEAD');
        fs.writeFileSync(path.join(repository, 'wip.txt'), 'work in progress\n');
        const result = create_patchlab_branch(repository, 'pl-cp-dirty', { capture_dirty_baseline: true });
        // Creation point is the host HEAD; baseline_sha is a child of that HEAD.
        expect(result.branch_creation_point_sha).toBe(head_before);
        expect(result.baseline_sha).not.toBeNull();
        expect(result.baseline_sha).not.toBe(head_before);
    });

    it('read_manifest defaults missing branch_creation_point_sha to null (4.3)', () => {
        // Simulate a legacy manifest written before this field existed.
        const archive_directory = build_archive_path('pl-cp-legacy');
        fs.mkdirSync(archive_directory, { recursive: true });
        // Simulate the pre-multi-source legacy on-disk shape directly — the
        // reader's synthesis path produces a Source_Specification[] from the
        // top-level source_path / repository_root / source_prefix triple.
        const legacy = {
            id: 'pl-cp-legacy',
            source_path: repository,
            format_version: 0,
            repository_root: repository,
            source_prefix: '',
            baseline_commit_sha: null,
            // NOTE: branch_creation_point_sha intentionally omitted.
            created_at: '2026-04-29T00:00:00.000Z',
            container_name: 'unused',
            container_image: 'unused',
        };
        fs.writeFileSync(
            path.join(archive_directory, 'manifest.json'),
            JSON.stringify(legacy, null, 2),
            'utf-8'
        );

        const manifest = read_manifest(archive_directory);
        // Legacy field absent on disk → branch_creation_point_shas synthesizes to {}.
        // A missing key for a repo present in the manifest reads as null per
        // patchlab-archive's map synthesis contract.
        expect(manifest.branch_creation_point_shas[repository] ?? null).toBeNull();
    });

    it('generate_patch uses persisted branch_creation_point_sha when no other branches and no baseline (4.4)', () => {
        const patchlab_id = 'pl-cp-only-branch';
        const archive_directory = build_archive_path(patchlab_id);
        fs.mkdirSync(archive_directory, { recursive: true });

        const branch_result = create_patchlab_branch(repository, patchlab_id);
        const manifest = create_manifest(
            patchlab_id,
            [{ host_path: repository, repository_root: repository, source_prefix: '', mount_name: '' }],
            'unused',
            'unused',
            {
                baseline_commit_sha: branch_result.baseline_sha,
                branch_creation_point_sha: branch_result.branch_creation_point_sha,
            },
        );
        write_manifest(archive_directory, manifest);

        // Detach the user from any other branch by deleting all non-patchlab branches.
        // (Default branch may be 'main' or 'master'; switch to patchlab branch first so
        // we can delete whatever the default is.)
        execFileSync('git', ['checkout', `patchlab/${patchlab_id}`], {
            cwd: repository, env: GIT_TEST_ENVIRONMENT, stdio: 'pipe',
        });
        const all_branches = execFileSync('git',
            ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
            { cwd: repository, env: GIT_TEST_ENVIRONMENT, encoding: 'utf-8' }
        ).split('\n').map((line) => line.trim()).filter(Boolean);
        for (const branch of all_branches) {
            if (branch !== `patchlab/${patchlab_id}`) {
                execFileSync('git', ['branch', '-D', branch], {
                    cwd: repository, env: GIT_TEST_ENVIRONMENT, stdio: 'pipe',
                });
            }
        }

        // Add a session commit so the cumulative diff has content.
        add_session_commit(repository, patchlab_id, 1, 'session-only.txt', 'session content\n');

        // With no other local branches, the merge-base fallback would return null and
        // the diff would be empty. The persisted creation point must save us.
        const patch = generate_patch(patchlab_id);
        expect(patch).toContain('session-only.txt');
        expect(patch).toContain('session content');
    });

    it('generate_patch falls back to merge-base for legacy manifest without branch_creation_point_sha (4.5)', () => {
        const patchlab_id = 'pl-cp-fallback';
        const archive_directory = build_archive_path(patchlab_id);
        fs.mkdirSync(archive_directory, { recursive: true });

        create_patchlab_branch(repository, patchlab_id);
        // Write a manifest WITHOUT branch_creation_point_sha (simulate legacy).
        const manifest = create_manifest(
            patchlab_id,
            [{ host_path: repository, repository_root: repository, source_prefix: '', mount_name: '' }],
            'unused',
            'unused',
            {
                baseline_commit_sha: null,
                // Explicitly omit branch_creation_point_sha so it defaults to null.
            },
        );
        expect(manifest.branch_creation_point_shas[repository] ?? null).toBeNull();
        write_manifest(archive_directory, manifest);

        add_session_commit(repository, patchlab_id, 1, 'foo.txt', 'foo content\n');

        // The user still has the default branch around — merge-base fallback finds it.
        const patch = generate_patch(patchlab_id);
        expect(patch).toContain('foo.txt');
        expect(patch).toContain('foo content');
    });
});
