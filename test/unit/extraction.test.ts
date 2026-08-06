import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import {
    finalize_session_metadata,
} from '../../src/extraction.js';
import {
    build_session_path,
    read_session_metadata,
    write_session_metadata,
    type Session_Metadata,
} from '../../src/archive.js';
import { install_isolated_home_hooks } from '../helpers/home_directory.js';

describe('finalize_session_metadata (6.9)', () => {
    install_isolated_home_hooks('patchlab-meta-home-');
    const patchlab_id = 'pl-meta';
    const META_REPO = '/host/meta-repo';

    function seed_metadata(
        overrides: Omit<Partial<Session_Metadata>, 'fallback_patches' | 'resource_limits'> = {},
    ): void {
        const initial: Session_Metadata = {
            session_number: 1,
            created_at: '2026-04-29T00:00:00.000Z',
            completed_at: null,
            status: 'completed',
            tool: 'gemini-cli-oauth',
            container_name: 'patchlab-test',
            commit_shas: { [META_REPO]: 'abc123' },
            fallback_patches: { [META_REPO]: null },
            resource_limits: null,
            ...overrides,
        };
        write_session_metadata(patchlab_id, 1, initial);
    }

    it('sets completed_at and status="completed" on normal exit', () => {
        seed_metadata({ status: 'completed', completed_at: null });

        finalize_session_metadata(patchlab_id, 1, 'completed');
        const metadata = read_session_metadata(patchlab_id, 1);

        expect(metadata?.status).toBe('completed');
        expect(metadata?.completed_at).not.toBeNull();
        expect(typeof metadata?.completed_at).toBe('string');
    });

    it('preserves commit_shas and other fields populated earlier (read-modify-write)', () => {
        seed_metadata({ commit_shas: { [META_REPO]: 'deadbeef' }, tool: 'gemini-cli-oauth' });

        finalize_session_metadata(patchlab_id, 1, 'completed');
        const metadata = read_session_metadata(patchlab_id, 1);

        expect(metadata?.commit_shas[META_REPO]).toBe('deadbeef');
        expect(metadata?.tool).toBe('gemini-cli-oauth');
        expect(metadata?.session_number).toBe(1);
        expect(metadata?.created_at).toBe('2026-04-29T00:00:00.000Z');
    });

    it('keeps completed_at null when status is "interrupted"', () => {
        seed_metadata({ completed_at: null });

        finalize_session_metadata(patchlab_id, 1, 'interrupted');
        const metadata = read_session_metadata(patchlab_id, 1);

        expect(metadata?.status).toBe('interrupted');
        expect(metadata?.completed_at).toBeNull();
    });

    it('does nothing when no metadata exists', () => {
        // No seed call — session 1 has no metadata.
        finalize_session_metadata(patchlab_id, 1, 'completed');

        const metadata_directory = build_session_path(patchlab_id, 1);
        expect(fs.existsSync(metadata_directory)).toBe(false);
    });
});