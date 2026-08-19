/**
 * Persisted-manifest layer of the resource-limits feature. Locks the
 * round-trip semantics that resume relies on:
 *   - resolved values written to `Session_Metadata.resource_limits` after
 *     successful create/resume,
 *   - `read_session_metadata` returning the block intact,
 *   - the `"unlimited"` sentinel preserved across the round-trip so a
 *     subsequent bare resume keeps the user's explicit opt-out,
 *   - legacy session metadata (no `resource_limits` block) reading as
 *     `null` so the resolver falls through to lower precedence.
 *
 * These tests exercise the persistence layer directly through
 * `write_session_metadata` / `read_session_metadata`; end-to-end coverage
 * (with a real container) belongs to the integration suite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    build_archive_path,
    build_session_path,
    read_session_metadata,
    write_session_metadata,
    type Session_Metadata,
} from '../../src/archive.js';
import { write_manifest, CURRENT_FORMAT_VERSION } from '../../src/manifest.js';
import {
    resolve_resource_limits,
    resolved_limits_to_persisted,
    resolved_limits_to_create_options,
    persisted_resource_limits_from_on_disk,
    persisted_resource_limits_to_on_disk,
    UNLIMITED,
    type Resolved_Resource_Limits,
} from '../../src/resource_limits.js';
import { read_persisted_resource_limits } from '../../src/sandbox/persisted_resource_limits.js';
import { EMPTY_LOADED_CONFIGURATION } from '../../src/sandbox/persisted_resource_limits.js';
import { install_isolated_home_hooks } from '../helpers/home_directory.js';

const NO_LOADED_CONFIGURATION = EMPTY_LOADED_CONFIGURATION;

const PATCHLAB_ID = 'manifest-test';
/** Synthetic `repository_root` used as the per-repo map key in these tests. */
const RESOURCE_TEST_REPO = '/host/resource-repo';

function make_metadata_with_limits(overrides: Partial<Session_Metadata> = {}): Session_Metadata {
    return {
        session_number: 1,
        created_at: '2026-05-17T00:00:00.000Z',
        completed_at: null,
        status: 'completed',
        tool: 'gemini-cli-oauth',
        container_name: 'patchlab-test',
        commit_shas: { [RESOURCE_TEST_REPO]: null },
        fallback_patches: { [RESOURCE_TEST_REPO]: null },
        resource_limits: null,
        ...overrides,
    };
}

describe('Session_Metadata.resource_limits persistence', () => {
    install_isolated_home_hooks('patchlab-manifest-limits-');

    beforeEach(() => {
        const archive_directory = build_archive_path(PATCHLAB_ID);
        fs.mkdirSync(archive_directory, { recursive: true });
        // Fixture manifest so `read_session_metadata`'s legacy-synthesis path
        // (which derives the primary repository from the manifest) can resolve.
        write_manifest(archive_directory, {
            id: PATCHLAB_ID,
            format_version: CURRENT_FORMAT_VERSION,
            sources: [
                {
                    host_path: RESOURCE_TEST_REPO,
                    repository_root: RESOURCE_TEST_REPO,
                    source_prefix: '',
                    mount_name: '',
                },
            ],
            baseline_commit_shas: { [RESOURCE_TEST_REPO]: null },
            branch_creation_point_shas: { [RESOURCE_TEST_REPO]: null },
            created_at: '2026-04-01T00:00:00.000Z',
            container_name: 'patchlab-fixture',
            container_image: 'fixture-image',
        });
    });

    it('writes resolved concrete limits with all four fields populated', () => {
        const metadata = make_metadata_with_limits({
            resource_limits: { memory: '12g', cpus: '3.0', pids: 1024, blkio_weight: null },
        });
        write_session_metadata(PATCHLAB_ID, 1, metadata);

        const read = read_session_metadata(PATCHLAB_ID, 1);
        expect(read?.resource_limits).toEqual({
            memory: '12g', cpus: '3.0', pids: 1024, blkio_weight: null,
        });
    });

    it('preserves "unlimited" sentinel through the round-trip for memory', () => {
        const metadata = make_metadata_with_limits({
            resource_limits: { memory: UNLIMITED, cpus: '3.0', pids: 1024, blkio_weight: null },
        });
        write_session_metadata(PATCHLAB_ID, 1, metadata);

        const read = read_session_metadata(PATCHLAB_ID, 1);
        expect(read?.resource_limits?.memory).toBe(UNLIMITED);
        // Locks the literal string for grep-ability across the codebase
        expect(read?.resource_limits?.memory).toBe('unlimited');
    });

    it('preserves "unlimited" sentinel for cpus and pids independently', () => {
        const metadata = make_metadata_with_limits({
            resource_limits: { memory: '12g', cpus: UNLIMITED, pids: UNLIMITED, blkio_weight: 500 },
        });
        write_session_metadata(PATCHLAB_ID, 1, metadata);

        const read = read_session_metadata(PATCHLAB_ID, 1);
        expect(read?.resource_limits?.cpus).toBe(UNLIMITED);
        expect(read?.resource_limits?.pids).toBe(UNLIMITED);
        expect(read?.resource_limits?.blkio_weight).toBe(500);
    });

    it('persists blkio_weight as null when no source set it', () => {
        const metadata = make_metadata_with_limits({
            resource_limits: { memory: '12g', cpus: '3.0', pids: 1024, blkio_weight: null },
        });
        write_session_metadata(PATCHLAB_ID, 1, metadata);

        const read = read_session_metadata(PATCHLAB_ID, 1);
        expect(read?.resource_limits?.blkio_weight).toBeNull();
    });

    it('reads legacy session metadata (no resource_limits block) as null', () => {
        // Simulate a session written by a prior patchlab version: write the
        // metadata file directly with no `resource_limits` field, then read.
        const session_directory = build_session_path(PATCHLAB_ID, 1);
        fs.mkdirSync(session_directory, { recursive: true });
        const legacy = {
            session_number: 1,
            created_at: '2026-04-01T00:00:00.000Z',
            completed_at: null,
            status: 'completed',
            tool: 'gemini-cli-oauth',
            container_name: 'patchlab-legacy',
            commit_sha: null,
            fallback_patch_path: null,
            // Intentionally NO resource_limits field
        };
        fs.writeFileSync(
            path.join(build_session_path(PATCHLAB_ID, 1), 'metadata.json'),
            JSON.stringify(legacy),
        );

        const read = read_session_metadata(PATCHLAB_ID, 1);
        expect(read?.resource_limits).toBeNull();
    });

    it('regression: unlimited persisted from --memory 0 survives a resume-style resolve', () => {
        // Simulates the full create+resume cycle:
        //   1. create --memory 0 → resolver emits memory_limit: UNLIMITED (in-memory)
        //   2. persisted_resource_limits_to_on_disk converts to the bare-key
        //      on-disk shape that Session_Metadata.resource_limits expects
        //   3. resume reads metadata; persisted_resource_limits_from_on_disk
        //      converts the bare on-disk shape back to in-memory suffixed names
        //   4. resolve_resource_limits(NO_LOADED_CONFIGURATION, persisted, {}) → memory_limit stays
        //      UNLIMITED (does NOT fall through to the 75%-of-RAM runtime default)
        const create_time = resolve_resource_limits(NO_LOADED_CONFIGURATION, null, { memory_limit: UNLIMITED });
        const persisted = resolved_limits_to_persisted(create_time);
        const metadata = make_metadata_with_limits({
            resource_limits: persisted_resource_limits_to_on_disk(persisted),
        });
        write_session_metadata(PATCHLAB_ID, 1, metadata);

        const read = read_session_metadata(PATCHLAB_ID, 1);
        const persisted_for_resume = read?.resource_limits == null
            ? null
            : persisted_resource_limits_from_on_disk(read.resource_limits);
        const resume_time = resolve_resource_limits(NO_LOADED_CONFIGURATION, persisted_for_resume, {});
        expect(resume_time.memory_limit).toBe(UNLIMITED);
        // The other three fields fall through correctly too
        expect(resume_time.cpu_limit).toBe(persisted.cpu_limit);
        expect(resume_time.pids_limit).toBe(persisted.pids_limit);
    });
});

describe('read_persisted_resource_limits', () => {
    install_isolated_home_hooks('patchlab-read-persisted-');

    beforeEach(() => {
        const archive_directory = build_archive_path(PATCHLAB_ID);
        fs.mkdirSync(archive_directory, { recursive: true });
        write_manifest(archive_directory, {
            id: PATCHLAB_ID,
            format_version: CURRENT_FORMAT_VERSION,
            sources: [{
                host_path: RESOURCE_TEST_REPO,
                repository_root: RESOURCE_TEST_REPO,
                source_prefix: '',
                mount_name: '',
            }],
            baseline_commit_shas: { [RESOURCE_TEST_REPO]: null },
            branch_creation_point_shas: { [RESOURCE_TEST_REPO]: null },
            created_at: '2026-04-01T00:00:00.000Z',
            container_name: 'patchlab-fixture',
            container_image: 'fixture-image',
        });
    });

    it('returns null when no prior session exists', () => {
        expect(read_persisted_resource_limits(PATCHLAB_ID)).toBeNull();
    });

    it('returns null when the latest session has no resource_limits block (legacy)', () => {
        write_session_metadata(PATCHLAB_ID, 1, make_metadata_with_limits({ resource_limits: null }));

        expect(read_persisted_resource_limits(PATCHLAB_ID)).toBeNull();
    });

    it('converts a populated on-disk block to the in-memory resolver-input shape', () => {
        write_session_metadata(PATCHLAB_ID, 1, make_metadata_with_limits({
            resource_limits: { memory: '8g', cpus: '2.0', pids: 2048, blkio_weight: 600 },
        }));

        expect(read_persisted_resource_limits(PATCHLAB_ID)).toEqual({
            memory_limit: '8g',
            cpu_limit: '2.0',
            pids_limit: 2048,
            blkio_weight: 600,
        });
    });

    it('preserves the unlimited sentinel through the bare-key → suffixed-key translation', () => {
        write_session_metadata(PATCHLAB_ID, 1, make_metadata_with_limits({
            resource_limits: { memory: UNLIMITED, cpus: '2.0', pids: UNLIMITED, blkio_weight: null },
        }));

        const persisted = read_persisted_resource_limits(PATCHLAB_ID);
        expect(persisted?.memory_limit).toBe(UNLIMITED);
        expect(persisted?.pids_limit).toBe(UNLIMITED);
        expect(persisted?.cpu_limit).toBe('2.0');
        expect(persisted?.blkio_weight).toBeNull();
    });

    it('reads the most-recent session when multiple exist', () => {
        write_session_metadata(PATCHLAB_ID, 1, make_metadata_with_limits({
            resource_limits: { memory: '4g', cpus: '1.0', pids: 512, blkio_weight: null },
        }));
        write_session_metadata(PATCHLAB_ID, 2, make_metadata_with_limits({
            session_number: 2,
            resource_limits: { memory: '16g', cpus: '4.0', pids: 4096, blkio_weight: 800 },
        }));

        expect(read_persisted_resource_limits(PATCHLAB_ID)).toEqual({
            memory_limit: '16g',
            cpu_limit: '4.0',
            pids_limit: 4096,
            blkio_weight: 800,
        });
    });
});

describe('resolved_limits_to_create_options', () => {
    it('passes concrete values through unchanged', () => {
        const resolved: Resolved_Resource_Limits = {
            memory_limit: '4g',
            cpu_limit: '2.0',
            pids_limit: 1024,
            blkio_weight: 500,
        };
        expect(resolved_limits_to_create_options(resolved)).toEqual({
            memory_limit: '4g',
            cpu_limit: '2.0',
            pids_limit: 1024,
            blkio_weight: 500,
        });
    });

    it('maps the UNLIMITED sentinel to undefined per-field independently', () => {
        const resolved: Resolved_Resource_Limits = {
            memory_limit: UNLIMITED,
            cpu_limit: '2.0',
            pids_limit: UNLIMITED,
            blkio_weight: null,
        };
        const argv = resolved_limits_to_create_options(resolved);
        expect(argv.memory_limit).toBeUndefined();
        expect(argv.cpu_limit).toBe('2.0');
        expect(argv.pids_limit).toBeUndefined();
        expect(argv.blkio_weight).toBeUndefined();
    });

    it('maps null blkio_weight to undefined', () => {
        const resolved: Resolved_Resource_Limits = {
            memory_limit: '4g',
            cpu_limit: '2.0',
            pids_limit: 1024,
            blkio_weight: null,
        };
        expect(resolved_limits_to_create_options(resolved).blkio_weight).toBeUndefined();
    });

    it('maps every field to undefined when every field is unlimited / null', () => {
        const resolved: Resolved_Resource_Limits = {
            memory_limit: UNLIMITED,
            cpu_limit: UNLIMITED,
            pids_limit: UNLIMITED,
            blkio_weight: null,
        };
        expect(resolved_limits_to_create_options(resolved)).toEqual({
            memory_limit: undefined,
            cpu_limit: undefined,
            pids_limit: undefined,
            blkio_weight: undefined,
        });
    });
});
