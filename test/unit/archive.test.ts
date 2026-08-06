import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { assert_present } from '../helpers/assert_present.js';
import { install_isolated_home_hooks } from '../helpers/home_directory.js';
import {
    build_archive_path,
    build_session_path,
    get_repository_root,
    get_source_prefix,
    next_session_number,
    latest_session_with_metadata,
    write_session_metadata,
    read_session_metadata,
    read_archive,
    PATCHLAB_DIRECTORY,
    type Session_Metadata,
} from '../../src/archive.js';
import { create_manifest, write_manifest, CURRENT_FORMAT_VERSION } from '../../src/manifest.js';

describe('archive: path helpers', () => {
    it('archive_path returns absolute path under ~/.patchlab/{id}/', () => {
        const result = build_archive_path('abc-123');
        expect(result).toBe(path.join(os.homedir(), PATCHLAB_DIRECTORY, 'abc-123'));
    });

    it('archive_path with subpath joins the subpath', () => {
        const result = build_archive_path('abc-123', 'manifest.json');
        expect(result).toBe(
            path.join(os.homedir(), PATCHLAB_DIRECTORY, 'abc-123', 'manifest.json')
        );
    });

    it('session_path returns absolute path under sessions/{n}/', () => {
        const result = build_session_path('abc-123', 2);
        expect(result).toBe(
            path.join(os.homedir(), PATCHLAB_DIRECTORY, 'abc-123', 'sessions', '2')
        );
    });

    it('session_path with subpath joins the subpath', () => {
        const result = build_session_path('abc-123', 2, 'metadata.json');
        expect(result).toBe(
            path.join(
                os.homedir(),
                PATCHLAB_DIRECTORY,
                'abc-123',
                'sessions',
                '2',
                'metadata.json'
            )
        );
    });
});

describe('archive: git helpers', () => {
    let temporary_directory: string;

    beforeEach(() => {
        temporary_directory = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-archive-test-'))
        );
    });

    afterEach(() => {
        fs.rmSync(temporary_directory, { recursive: true, force: true });
    });

    it('get_repository_root finds the repo root from a subdirectory', () => {
        execFileSync('git', ['init'], { cwd: temporary_directory });
        const subdir = path.join(temporary_directory, 'src', 'utils');
        fs.mkdirSync(subdir, { recursive: true });

        const root = get_repository_root(subdir);
        expect(fs.realpathSync(root)).toBe(temporary_directory);
    });

    it('get_repository_root throws when path is not in a git repo', () => {
        // No git init in the temp directory
        expect(() => get_repository_root(temporary_directory)).toThrow(/git repository/);
    });

    it('get_source_prefix returns "" for repo-root source', () => {
        expect(get_source_prefix('/repo', '/repo')).toBe('');
    });

    it('get_source_prefix returns relative path with no trailing slash', () => {
        expect(get_source_prefix('/repo', '/repo/src/ui')).toBe('src/ui');
    });

    it('get_source_prefix normalizes path separators on Windows-style paths', () => {
        // path.relative will produce platform-native separators; we normalize to forward slashes.
        const result = get_source_prefix('/repo', '/repo/src');
        expect(result).toBe('src');
    });
});

describe('archive: session metadata', () => {
    install_isolated_home_hooks('patchlab-archive-test-');

    const ARCHIVE_TEST_REPO = '/host/repo';

    /**
     * Write a minimal-but-valid manifest fixture so `read_session_metadata`'s
     * legacy-synthesis path (which needs the patchlab's primary repository
     * derived from the manifest) can resolve a stable key.
     */
    function write_fixture_manifest(id: string): void {
        const archive_directory = build_archive_path(id);
        fs.mkdirSync(archive_directory, { recursive: true });
        write_manifest(archive_directory, {
            id,
            format_version: CURRENT_FORMAT_VERSION,
            sources: [
                {
                    host_path: ARCHIVE_TEST_REPO,
                    repository_root: ARCHIVE_TEST_REPO,
                    source_prefix: '',
                    mount_name: '',
                },
            ],
            baseline_commit_shas: { [ARCHIVE_TEST_REPO]: null },
            branch_creation_point_shas: { [ARCHIVE_TEST_REPO]: null },
            created_at: '2026-04-25T00:00:00.000Z',
            container_name: 'patchlab-fixture',
            container_image: 'fixture-image',
        });
    }

    function make_metadata(n: number): Session_Metadata {
        return {
            session_number: n,
            created_at: '2026-04-25T00:00:00.000Z',
            completed_at: null,
            status: 'completed',
            tool: 'gemini-cli-oauth',
            container_name: `patchlab-test-${n}`,
            commit_shas: { [ARCHIVE_TEST_REPO]: null },
            fallback_patches: { [ARCHIVE_TEST_REPO]: null },
            resource_limits: null,
        };
    }

    it('next_session_number returns 1 for empty patchlab', () => {
        const id = 'pl-empty';
        fs.mkdirSync(build_archive_path(id), { recursive: true });
        expect(next_session_number(id)).toBe(1);
    });

    it('next_session_number returns max + 1 with existing sessions', () => {
        const id = 'pl-multi';
        fs.mkdirSync(build_session_path(id, 1), { recursive: true });
        fs.mkdirSync(build_session_path(id, 2), { recursive: true });
        expect(next_session_number(id)).toBe(3);
    });

    it('next_session_number handles gaps by returning max + 1', () => {
        const id = 'pl-gaps';
        fs.mkdirSync(build_session_path(id, 1), { recursive: true });
        fs.mkdirSync(build_session_path(id, 5), { recursive: true });
        expect(next_session_number(id)).toBe(6);
    });

    it('latest_session_with_metadata returns null when no session has metadata', () => {
        const id = 'pl-no-metadata';
        // A claimed-but-not-yet-written session directory exists, but no
        // metadata.json — it must not be reported as a completed session.
        fs.mkdirSync(build_session_path(id, 1), { recursive: true });
        expect(latest_session_with_metadata(id)).toBeNull();
    });

    it('latest_session_with_metadata returns the highest session that has metadata', () => {
        const id = 'pl-latest-metadata';
        write_session_metadata(id, 1, make_metadata(1));
        write_session_metadata(id, 2, make_metadata(2));
        expect(latest_session_with_metadata(id)).toBe(2);
    });

    it('latest_session_with_metadata skips a higher metadata-less (crashed) session', () => {
        const id = 'pl-crashed-latest';
        write_session_metadata(id, 1, make_metadata(1));
        // Session 2 was claimed (mkdir) but crashed before writing metadata;
        // next_session_number would point at it, but the last COMPLETED
        // session is 1.
        fs.mkdirSync(build_session_path(id, 2), { recursive: true });
        expect(next_session_number(id)).toBe(3);
        expect(latest_session_with_metadata(id)).toBe(1);
    });

    it('write_session_metadata then read_session_metadata round-trips', () => {
        const id = 'pl-roundtrip';
        const metadata = make_metadata(1);
        write_session_metadata(id, 1, metadata);

        const read = read_session_metadata(id, 1);
        expect(read).toEqual(metadata);
    });

    it('read_session_metadata returns null for missing session', () => {
        const id = 'pl-missing';
        fs.mkdirSync(build_archive_path(id), { recursive: true });
        expect(read_session_metadata(id, 99)).toBeNull();
    });

    it('write_session_metadata is atomic (no partial files visible)', () => {
        const id = 'pl-atomic';
        const metadata = make_metadata(1);
        write_session_metadata(id, 1, metadata);

        // After write, only the final file should exist (no .tmp leftover).
        const directory = build_session_path(id, 1);
        const entries = fs.readdirSync(directory);
        expect(entries).toEqual(['metadata.json']);
    });

    it('read_session_metadata synthesizes legacy commit_sha / fallback_patch_path into single-entry maps', () => {
        const id = 'pl-legacy-fb';
        write_fixture_manifest(id);
        const directory = build_session_path(id, 1);
        fs.mkdirSync(directory, { recursive: true });
        // Write a legacy metadata file without `fallback_patch_path` and with
        // legacy `commit_sha`. The reader synthesizes both into single-entry
        // maps keyed on `primary_repo`.
        const legacy = {
            session_number: 1,
            created_at: '2026-04-25T00:00:00.000Z',
            completed_at: null,
            status: 'completed',
            tool: 'gemini-cli-oauth',
            container_name: 'patchlab-legacy',
            commit_sha: null,
        };
        fs.writeFileSync(
            path.join(directory, 'metadata.json'),
            JSON.stringify(legacy, null, 2),
            'utf-8'
        );

        const read = read_session_metadata(id, 1);
        assert_present(read);
        // Legacy `commit_sha: null` synthesizes to single-entry map with null.
        expect(read.commit_shas).toEqual({ [ARCHIVE_TEST_REPO]: null });
        // Legacy `fallback_patch_path` absent entirely → synthesizer produces
        // the populated-null shape (not `{}`), per the "rewritten to the
        // populated null shape on the next mutation" clause.
        expect(read.fallback_patches).toEqual({ [ARCHIVE_TEST_REPO]: null });
    });

    it('read_session_metadata synthesizes a legacy commit_sha with a non-null value', () => {
        const id = 'pl-legacy-sha';
        write_fixture_manifest(id);
        const directory = build_session_path(id, 1);
        fs.mkdirSync(directory, { recursive: true });
        const legacy = {
            session_number: 1,
            created_at: '2026-04-25T00:00:00.000Z',
            completed_at: null,
            status: 'completed',
            tool: 'gemini-cli-oauth',
            container_name: 'patchlab-legacy-sha',
            commit_sha: 'abc123',
            fallback_patch_path: '/some/fallback.patch',
        };
        fs.writeFileSync(
            path.join(directory, 'metadata.json'),
            JSON.stringify(legacy, null, 2),
            'utf-8'
        );

        const read = read_session_metadata(id, 1);
        assert_present(read);
        expect(read.commit_shas).toEqual({ [ARCHIVE_TEST_REPO]: 'abc123' });
        expect(read.fallback_patches).toEqual({ [ARCHIVE_TEST_REPO]: '/some/fallback.patch' });
    });

    it('read_session_metadata synthesizes populated-null maps when both shapes are absent', () => {
        // Per the `Session metadata schema` requirement's "rewritten to the
        // populated null shape on the next mutation" clause, the in-memory
        // representation is `{ [primary_repo]: null }` even when neither the
        // new map nor the legacy single-key fields are on disk.
        const id = 'pl-empty-shape';
        write_fixture_manifest(id);
        const directory = build_session_path(id, 1);
        fs.mkdirSync(directory, { recursive: true });
        const sparse = {
            session_number: 1,
            created_at: '2026-04-25T00:00:00.000Z',
            completed_at: null,
            status: 'completed',
            tool: 'gemini-cli-oauth',
            container_name: 'patchlab-sparse',
        };
        fs.writeFileSync(
            path.join(directory, 'metadata.json'),
            JSON.stringify(sparse, null, 2),
            'utf-8'
        );

        const read = read_session_metadata(id, 1);
        assert_present(read);
        expect(read.commit_shas).toEqual({ [ARCHIVE_TEST_REPO]: null });
        expect(read.fallback_patches).toEqual({ [ARCHIVE_TEST_REPO]: null });
    });

    it('read_session_metadata repopulates empty-map shape on read so next write persists populated null', () => {
        const id = 'pl-empty-map-on-disk';
        write_fixture_manifest(id);
        const directory = build_session_path(id, 1);
        fs.mkdirSync(directory, { recursive: true });
        const empty_map = {
            session_number: 1,
            created_at: '2026-04-25T00:00:00.000Z',
            completed_at: null,
            status: 'completed',
            tool: 'gemini-cli-oauth',
            container_name: 'patchlab-empty-map',
            commit_shas: {},
            fallback_patches: {},
        };
        fs.writeFileSync(
            path.join(directory, 'metadata.json'),
            JSON.stringify(empty_map, null, 2),
            'utf-8'
        );

        const read = read_session_metadata(id, 1);
        assert_present(read);
        expect(read.commit_shas).toEqual({ [ARCHIVE_TEST_REPO]: null });
        expect(read.fallback_patches).toEqual({ [ARCHIVE_TEST_REPO]: null });

        // First write after read persists the populated null shape — `{}` is
        // tolerated as input but never persisted by our writer.
        write_session_metadata(id, 1, read);
        const raw = JSON.parse(
            fs.readFileSync(path.join(directory, 'metadata.json'), 'utf-8'),
        );
        expect(raw.commit_shas).toEqual({ [ARCHIVE_TEST_REPO]: null });
        expect(raw.fallback_patches).toEqual({ [ARCHIVE_TEST_REPO]: null });
    });

    it('first write after legacy read persists the new map shape', () => {
        const id = 'pl-first-write';
        write_fixture_manifest(id);
        const directory = build_session_path(id, 1);
        fs.mkdirSync(directory, { recursive: true });
        const legacy = {
            session_number: 1,
            created_at: '2026-04-25T00:00:00.000Z',
            completed_at: null,
            status: 'completed',
            tool: 'gemini-cli-oauth',
            container_name: 'patchlab-first-write',
            commit_sha: 'def456',
            fallback_patch_path: null,
        };
        fs.writeFileSync(
            path.join(directory, 'metadata.json'),
            JSON.stringify(legacy, null, 2),
            'utf-8'
        );

        const read = read_session_metadata(id, 1);
        assert_present(read);
        write_session_metadata(id, 1, read);
        const raw = JSON.parse(
            fs.readFileSync(path.join(directory, 'metadata.json'), 'utf-8'),
        );
        expect(raw.commit_sha).toBeUndefined();
        expect(raw.fallback_patch_path).toBeUndefined();
        expect(raw.commit_shas).toEqual({ [ARCHIVE_TEST_REPO]: 'def456' });
        expect(raw.fallback_patches).toEqual({ [ARCHIVE_TEST_REPO]: null });
    });

    describe('read_session_metadata field validation', () => {
        function write_raw_session_metadata(id: string, payload: unknown): void {
            const directory = build_session_path(id, 1);
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(
                path.join(directory, 'metadata.json'),
                JSON.stringify(payload, null, 2),
                'utf-8',
            );
        }

        it('rejects a parsed JSON root that is an array', () => {
            const id = 'pl-array-root';
            write_raw_session_metadata(id, [1, 2, 3]);
            expect(() => read_session_metadata(id, 1))
                .toThrow(/expected the parsed JSON to be an object/);
        });

        it('rejects metadata missing session_number', () => {
            const id = 'pl-missing-session-number';
            write_raw_session_metadata(id, {
                created_at: '2026-04-25T00:00:00.000Z',
            });
            expect(() => read_session_metadata(id, 1))
                .toThrow(/session_number.*finite number/);
        });

        it('rejects metadata where session_number is a string', () => {
            const id = 'pl-string-session-number';
            write_raw_session_metadata(id, {
                session_number: '1',
                created_at: '2026-04-25T00:00:00.000Z',
            });
            expect(() => read_session_metadata(id, 1))
                .toThrow(/session_number.*finite number/);
        });

        it('rejects metadata missing created_at', () => {
            const id = 'pl-missing-created-at';
            write_raw_session_metadata(id, {
                session_number: 1,
            });
            expect(() => read_session_metadata(id, 1))
                .toThrow(/created_at.*string/);
        });

        it('rejects metadata where commit_shas is an array', () => {
            const id = 'pl-array-commit-shas';
            write_raw_session_metadata(id, {
                session_number: 1,
                created_at: '2026-04-25T00:00:00.000Z',
                commit_shas: ['/repo'],
            });
            expect(() => read_session_metadata(id, 1))
                .toThrow(/commit_shas.*array/);
        });

        it('rejects metadata where a fallback_patches entry is a number', () => {
            const id = 'pl-bad-fallback-entry';
            write_raw_session_metadata(id, {
                session_number: 1,
                created_at: '2026-04-25T00:00:00.000Z',
                fallback_patches: { '/repo': 42 },
            });
            expect(() => read_session_metadata(id, 1))
                .toThrow(/fallback_patches.*\/repo.*number/);
        });
    });
});

describe('archive: read_archive', () => {
    install_isolated_home_hooks('patchlab-archive-test-');

    it('returns archive with manifest and no sessions for minimal patchlab', () => {
        const id = 'pl-minimal';
        const directory = build_archive_path(id);
        fs.mkdirSync(directory, { recursive: true });
        const manifest = create_manifest(
            id,
            [{ host_path: '/some/source', repository_root: '/some/source', source_prefix: '', mount_name: '' }],
            'patchlab-minimal',
            'node:22-slim',
        );
        write_manifest(directory, manifest);

        const archive = read_archive(id);
        expect(archive.id).toBe(id);
        expect(archive.manifest.id).toBe(id);
        expect(archive.manifest.format_version).toBe(CURRENT_FORMAT_VERSION);
        expect(archive.sessions).toEqual([]);
    });

    it('returns sessions ordered by session_number ascending', () => {
        const id = 'pl-multi-session';
        const directory = build_archive_path(id);
        fs.mkdirSync(directory, { recursive: true });
        const manifest = create_manifest(
            id,
            [{ host_path: '/some/source', repository_root: '/some/source', source_prefix: '', mount_name: '' }],
            'patchlab-multi',
            'node:22-slim',
        );
        write_manifest(directory, manifest);

        // Write in non-ascending order
        const repo = '/some/source';
        write_session_metadata(id, 2, {
            session_number: 2,
            created_at: '2026-04-25T01:00:00.000Z',
            completed_at: null,
            status: 'completed',
            tool: 'gemini-cli-oauth',
            container_name: 'patchlab-multi-2',
            commit_shas: { [repo]: null },
            fallback_patches: { [repo]: null },
            resource_limits: null,
        });
        write_session_metadata(id, 1, {
            session_number: 1,
            created_at: '2026-04-25T00:00:00.000Z',
            completed_at: null,
            status: 'completed',
            tool: 'gemini-cli-oauth',
            container_name: 'patchlab-multi-1',
            commit_shas: { [repo]: null },
            fallback_patches: { [repo]: null },
            resource_limits: null,
        });

        const archive = read_archive(id);
        expect(archive.sessions.map((s) => s.session_number)).toEqual([1, 2]);
    });

    it('throws when manifest format_version is unrecognized', () => {
        const id = 'pl-future';
        const directory = build_archive_path(id);
        fs.mkdirSync(directory, { recursive: true });
        const future = {
            id,
            source_path: '/future',
            format_version: 99,
            repository_root: null,
            source_prefix: '',
            baseline_commit_sha: null,
            created_at: '2026-01-01T00:00:00.000Z',
            container_name: 'patchlab-future',
            container_image: 'node:22-slim',
        };
        fs.writeFileSync(
            path.join(directory, 'manifest.json'),
            JSON.stringify(future, null, 2),
            'utf-8'
        );

        expect(() => read_archive(id)).toThrow(/format_version/);
    });
});
