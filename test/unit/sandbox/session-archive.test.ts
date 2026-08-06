import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    read_session_summaries,
    write_initial_session_metadata,
    type Session_Summary,
} from '../../../src/sandbox/session_archive.js';
import {
    build_archive_path,
    build_session_path,
    read_session_metadata,
    write_session_metadata,
    type Session_Metadata,
} from '../../../src/archive.js';
import {
    create_manifest,
    write_manifest,
    type Sandbox_Manifest,
} from '../../../src/manifest.js';
import { UNLIMITED, type Resolved_Resource_Limits } from '../../../src/resource_limits.js';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';

const UNLIMITED_RESOURCE_LIMITS: Resolved_Resource_Limits = {
    memory_limit: UNLIMITED,
    cpu_limit: UNLIMITED,
    pids_limit: UNLIMITED,
    blkio_weight: null,
};

function seed_manifest(patchlab_id: string, repository_roots: string[]): Sandbox_Manifest {
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

    return manifest;
}

function write_session(
    patchlab_id: string,
    session_number: number,
    overrides: Partial<Session_Metadata>,
): void {
    const directory = build_session_path(patchlab_id, session_number);
    fs.mkdirSync(directory, { recursive: true });
    write_session_metadata(patchlab_id, session_number, {
        session_number,
        created_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T01:00:00.000Z',
        status: 'completed',
        tool: 'gemini-cli-oauth',
        container_name: `c-${session_number}`,
        commit_shas: {},
        fallback_patches: {},
        resource_limits: null,
        ...overrides,
    });
}

describe('write_initial_session_metadata', () => {
    install_isolated_home_hooks('patchlab-write-initial-session-');

    it('claims session 1 on a fresh archive', () => {
        const patchlab_id = 'pl-first';
        const manifest = seed_manifest(patchlab_id, ['/host/repo-a']);
        const session_number = write_initial_session_metadata(
            patchlab_id,
            'gemini-cli-oauth',
            'container-x',
            manifest,
            UNLIMITED_RESOURCE_LIMITS,
        );
        expect(session_number).toBe(1);
    });

    it('claims the next free session number when prior sessions exist', () => {
        const patchlab_id = 'pl-resume';
        const manifest = seed_manifest(patchlab_id, ['/host/repo-a']);
        write_session(patchlab_id, 1, { commit_shas: { '/host/repo-a': 'sha-1' } });
        write_session(patchlab_id, 2, { commit_shas: { '/host/repo-a': 'sha-2' } });
        const session_number = write_initial_session_metadata(
            patchlab_id,
            'gemini-cli-oauth',
            'container-x',
            manifest,
            UNLIMITED_RESOURCE_LIMITS,
        );
        expect(session_number).toBe(3);
    });

    it('writes a metadata.json with one null entry per repository and the resolved tool name', () => {
        const patchlab_id = 'pl-multi';
        const manifest = seed_manifest(patchlab_id, ['/host/repo-a', '/host/repo-b']);
        const session_number = write_initial_session_metadata(
            patchlab_id,
            'gemini-cli',
            'container-y',
            manifest,
            UNLIMITED_RESOURCE_LIMITS,
        );
        const metadata = read_session_metadata(patchlab_id, session_number);
        expect(metadata).not.toBeNull();
        expect(metadata?.tool).toBe('gemini-cli');
        expect(metadata?.container_name).toBe('container-y');
        expect(metadata?.commit_shas).toEqual({ '/host/repo-a': null, '/host/repo-b': null });
        expect(metadata?.fallback_patches).toEqual({ '/host/repo-a': null, '/host/repo-b': null });
    });

    it('persists the resolved resource limits in on-disk shape', () => {
        const patchlab_id = 'pl-with-limits';
        const manifest = seed_manifest(patchlab_id, ['/host/repo-a']);
        const session_number = write_initial_session_metadata(
            patchlab_id,
            'gemini-cli-oauth',
            'container-z',
            manifest,
            UNLIMITED_RESOURCE_LIMITS,
        );
        const metadata = read_session_metadata(patchlab_id, session_number);
        expect(metadata?.resource_limits).not.toBeNull();
    });
});

describe('read_session_summaries', () => {
    install_isolated_home_hooks('patchlab-read-summaries-');

    it('returns [] when the archive directory has no sessions/', () => {
        const patchlab_id = 'pl-no-sessions';
        seed_manifest(patchlab_id, ['/host/repo-a']);
        expect(read_session_summaries(patchlab_id, ['/host/repo-a'])).toEqual([]);
    });

    it('returns [] when sessions/ exists but is empty', () => {
        const patchlab_id = 'pl-empty-sessions';
        seed_manifest(patchlab_id, ['/host/repo-a']);
        const sessions_root = path.join(build_archive_path(patchlab_id), 'sessions');
        fs.mkdirSync(sessions_root, { recursive: true });
        expect(read_session_summaries(patchlab_id, ['/host/repo-a'])).toEqual([]);
    });

    it('returns summaries ordered by session_number ascending', () => {
        const patchlab_id = 'pl-ordered';
        seed_manifest(patchlab_id, ['/host/repo-a']);
        write_session(patchlab_id, 3, { commit_shas: { '/host/repo-a': 'sha-3' } });
        write_session(patchlab_id, 1, { commit_shas: { '/host/repo-a': 'sha-1' } });
        write_session(patchlab_id, 2, { commit_shas: { '/host/repo-a': 'sha-2' } });
        const summaries = read_session_summaries(patchlab_id, ['/host/repo-a']);
        expect(summaries.map((s) => s.session_number)).toEqual([1, 2, 3]);
    });

    it('silently skips directories whose names are not decimal-integer session numbers', () => {
        const patchlab_id = 'pl-with-noise';
        seed_manifest(patchlab_id, ['/host/repo-a']);
        write_session(patchlab_id, 1, { commit_shas: { '/host/repo-a': 'sha-1' } });
        // Manually create noise directories — these should be filtered out.
        const sessions_root = path.join(build_archive_path(patchlab_id), 'sessions');
        fs.mkdirSync(path.join(sessions_root, '1e2'), { recursive: true });
        fs.mkdirSync(path.join(sessions_root, '01'), { recursive: true });
        fs.mkdirSync(path.join(sessions_root, 'noise'), { recursive: true });
        const summaries = read_session_summaries(patchlab_id, ['/host/repo-a']);
        expect(summaries.map((s) => s.session_number)).toEqual([1]);
    });

    it('projects per-repository outcomes against the requested repository list', () => {
        const patchlab_id = 'pl-multi-repo';
        seed_manifest(patchlab_id, ['/host/repo-a', '/host/repo-b']);
        write_session(patchlab_id, 1, {
            commit_shas: { '/host/repo-a': 'sha-a-1' },
            fallback_patches: { '/host/repo-b': '/path/to/patch-b.diff' },
        });
        const summaries = read_session_summaries(patchlab_id, ['/host/repo-a', '/host/repo-b']);
        expect(summaries).toHaveLength(1);
        expect(summaries[0].repositories).toEqual([
            { repository_root: '/host/repo-a', commit_sha: 'sha-a-1', fallback_patch_path: null },
            { repository_root: '/host/repo-b', commit_sha: null, fallback_patch_path: '/path/to/patch-b.diff' },
        ]);
    });

    it('marks partial_success when one repository committed and another only fell back to a patch', () => {
        const patchlab_id = 'pl-partial';
        seed_manifest(patchlab_id, ['/host/repo-a', '/host/repo-b']);
        write_session(patchlab_id, 1, {
            commit_shas: { '/host/repo-a': 'sha-a' },
            fallback_patches: { '/host/repo-b': '/path/to/b.diff' },
        });
        const summaries = read_session_summaries(patchlab_id, ['/host/repo-a', '/host/repo-b']);
        expect(summaries[0].partial_success).toBe(true);
    });

    it('does NOT mark partial_success when every repository either committed or had nothing', () => {
        const patchlab_id = 'pl-no-partial';
        seed_manifest(patchlab_id, ['/host/repo-a', '/host/repo-b']);
        write_session(patchlab_id, 1, {
            commit_shas: { '/host/repo-a': 'sha-a', '/host/repo-b': 'sha-b' },
        });
        const summaries = read_session_summaries(patchlab_id, ['/host/repo-a', '/host/repo-b']);
        expect(summaries[0].partial_success).toBe(false);
    });

    it('does NOT mark partial_success when zero repositories committed (e.g., total failure with patches)', () => {
        const patchlab_id = 'pl-fallback-only';
        seed_manifest(patchlab_id, ['/host/repo-a', '/host/repo-b']);
        write_session(patchlab_id, 1, {
            fallback_patches: { '/host/repo-a': '/p/a.diff', '/host/repo-b': '/p/b.diff' },
        });
        const summaries = read_session_summaries(patchlab_id, ['/host/repo-a', '/host/repo-b']);
        expect(summaries[0].partial_success).toBe(false);
    });

    it('preserves status and timestamp fields from each session', () => {
        const patchlab_id = 'pl-fields';
        seed_manifest(patchlab_id, ['/host/repo-a']);
        write_session(patchlab_id, 1, {
            commit_shas: { '/host/repo-a': 'sha-1' },
            status: 'interrupted',
            completed_at: null,
        });
        const [summary] = read_session_summaries(patchlab_id, ['/host/repo-a']);
        expect(summary.status).toBe('interrupted');
        expect(summary.completed_at).toBeNull();
        expect(summary.created_at).toBe('2026-01-01T00:00:00.000Z');
    });
});

describe('Session_Summary export shape', () => {
    it('compiles as the canonical per-session type for inspect', () => {
        // Compile-time anchor: ensure the type re-exports through the module
        // so downstream consumers don't drift.
        const _check: Session_Summary = {
            session_number: 1,
            created_at: '2026-01-01T00:00:00.000Z',
            completed_at: null,
            status: 'completed',
            repositories: [],
            partial_success: false,
        };
        expect(_check.session_number).toBe(1);
    });
});
