import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    list_session_commits,
    make_initial_session_metadata,
} from '../../../src/branch/session_metadata.js';
import {
    build_archive_path,
    build_session_path,
    write_session_metadata,
    type Session_Metadata,
} from '../../../src/archive.js';
import { create_manifest, write_manifest } from '../../../src/manifest.js';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';

describe('make_initial_session_metadata', () => {
    it('throws when repositories is empty', () => {
        expect(() => make_initial_session_metadata(1, 'gemini-cli-oauth', 'patchlab-x', [])).toThrow(/non-empty/);
    });

    it('builds a single-repository metadata with one null entry per map', () => {
        const result = make_initial_session_metadata(
            3,
            'gemini-cli-oauth',
            'patchlab-container',
            ['/host/repo-a'],
        );
        expect(result.session_number).toBe(3);
        expect(result.tool).toBe('gemini-cli-oauth');
        expect(result.container_name).toBe('patchlab-container');
        expect(result.commit_shas).toEqual({ '/host/repo-a': null });
        expect(result.fallback_patches).toEqual({ '/host/repo-a': null });
        expect(result.status).toBe('interrupted');
        expect(result.completed_at).toBeNull();
        expect(result.resource_limits).toBeNull();
        // created_at must be an ISO-8601 timestamp the rest of the pipeline can parse.
        expect(new Date(result.created_at).toISOString()).toBe(result.created_at);
    });

    it('preserves repository order in commit_shas and fallback_patches', () => {
        const result = make_initial_session_metadata(
            1,
            'gemini-cli-oauth',
            'name',
            ['/host/c', '/host/a', '/host/b'],
        );
        expect(Object.keys(result.commit_shas)).toEqual(['/host/c', '/host/a', '/host/b']);
        expect(Object.keys(result.fallback_patches)).toEqual(['/host/c', '/host/a', '/host/b']);
    });

    it('preserves a duplicate repository key (caller is responsible for deduping)', () => {
        const result = make_initial_session_metadata(
            1,
            'gemini-cli-oauth',
            'name',
            ['/host/a', '/host/a'],
        );
        // Object literals collapse duplicates; the documentation only says the
        // input MUST be non-empty.
        expect(result.commit_shas).toEqual({ '/host/a': null });
    });
});

describe('list_session_commits', () => {
    install_isolated_home_hooks('patchlab-session-metadata-');

    function seed_archive(patchlab_id: string, repository_roots: string[]): void {
        const sources = repository_roots.map((repository_root) => ({
            host_path: repository_root,
            repository_root,
            source_prefix: '',
            mount_name: path.basename(repository_root) || 'mount',
        }));
        const manifest = create_manifest(
            patchlab_id,
            sources,
            `c-${patchlab_id}`,
            'docker.io/library/node:24-bookworm-slim',
        );
        const directory = build_archive_path(patchlab_id);
        fs.mkdirSync(directory, { recursive: true });
        write_manifest(directory, manifest);
    }

    function write_session(
        patchlab_id: string,
        session_number: number,
        overrides: Partial<Session_Metadata>,
    ): void {
        const directory = build_session_path(patchlab_id, session_number);
        fs.mkdirSync(directory, { recursive: true });
        const metadata: Session_Metadata = {
            session_number,
            created_at: '2026-01-01T00:00:00.000Z',
            completed_at: null,
            status: 'completed',
            tool: 'gemini-cli-oauth',
            container_name: `c-${session_number}`,
            commit_shas: {},
            fallback_patches: {},
            resource_limits: null,
            ...overrides,
        };
        write_session_metadata(patchlab_id, session_number, metadata);
    }

    it('returns [] when the patchlab archive has no sessions', () => {
        const patchlab_id = 'pl-empty';
        seed_archive(patchlab_id, ['/host/repo-a']);
        expect(list_session_commits(patchlab_id, '/host/repo-a')).toEqual([]);
    });

    it('returns commits for the requested repository in session-number order', () => {
        const patchlab_id = 'pl-ordered';
        seed_archive(patchlab_id, ['/host/repo-a']);
        write_session(patchlab_id, 1, { commit_shas: { '/host/repo-a': 'sha-1' } });
        write_session(patchlab_id, 2, { commit_shas: { '/host/repo-a': 'sha-2' } });
        write_session(patchlab_id, 3, { commit_shas: { '/host/repo-a': 'sha-3' } });
        expect(list_session_commits(patchlab_id, '/host/repo-a')).toEqual([
            { session_number: 1, commit_sha: 'sha-1' },
            { session_number: 2, commit_sha: 'sha-2' },
            { session_number: 3, commit_sha: 'sha-3' },
        ]);
    });

    it('silently skips sessions whose commit_shas entry for the repository is null', () => {
        const patchlab_id = 'pl-with-nulls';
        seed_archive(patchlab_id, ['/host/repo-a']);
        write_session(patchlab_id, 1, { commit_shas: { '/host/repo-a': 'sha-1' } });
        write_session(patchlab_id, 2, { commit_shas: { '/host/repo-a': null } });
        write_session(patchlab_id, 3, { commit_shas: { '/host/repo-a': 'sha-3' } });
        expect(list_session_commits(patchlab_id, '/host/repo-a')).toEqual([
            { session_number: 1, commit_sha: 'sha-1' },
            { session_number: 3, commit_sha: 'sha-3' },
        ]);
    });

    it('filters by repository_root — sibling repositories\' commits are excluded', () => {
        const patchlab_id = 'pl-multi-repo';
        seed_archive(patchlab_id, ['/host/repo-a', '/host/repo-b']);
        write_session(patchlab_id, 1, {
            commit_shas: { '/host/repo-a': 'sha-a-1', '/host/repo-b': 'sha-b-1' },
        });
        write_session(patchlab_id, 2, {
            commit_shas: { '/host/repo-a': null, '/host/repo-b': 'sha-b-2' },
        });
        expect(list_session_commits(patchlab_id, '/host/repo-a')).toEqual([
            { session_number: 1, commit_sha: 'sha-a-1' },
        ]);
        expect(list_session_commits(patchlab_id, '/host/repo-b')).toEqual([
            { session_number: 1, commit_sha: 'sha-b-1' },
            { session_number: 2, commit_sha: 'sha-b-2' },
        ]);
    });
});
