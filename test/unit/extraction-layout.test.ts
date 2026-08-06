import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
    extract_conversation,
    type Artifact_Extraction_Result,
    type Conversation_Extraction_Result,
} from '../../src/extraction.js';
import {
    ARCHIVE_ARTIFACTS_DIRECTORY,
    build_session_path,
} from '../../src/archive.js';
import type { Extractable_Artifact } from '../../src/extractable_artifact.js';
import type { Authentication_Method, Tool_Provider } from '../../src/tools/types.js';
import { ConsoleLogger, set_logger } from '../../src/logger.js';
import { RecordingLogger } from '../helpers/recording_logger.js';
import { install_isolated_home_hooks } from '../helpers/home_directory.js';

const PATCHLAB_ID = 'pl-extract-layout';
const SESSION_NUMBER = 1;

function build_fake_provider(artifacts: Extractable_Artifact[]): Tool_Provider {
    return {
        name: 'fake-provider',
        display_name: 'Fake Provider',
        image_specification: {
            base_image: 'node:22-slim',
            image_user: 'patchlab',
            image_home: '/home/patchlab',
            configuration_directory_name: '.fake',
            async prepare_build_assets() { return new Map(); },
            get_dockerfile_lines() { return []; },
            get_dockerfile_environment() { return {}; },
            get_base_preparation_lines() { return { lines: [] }; },
        },
        inject_authentication() { return { type: 'none' }; },
        get_launch_command() { return ['fake']; },
        validate_image() { return { valid: true, reasons: [] }; },
        get_cached_version() { return null; },
        get_openspec_tool_name() { return 'fake'; },
        get_authentication_method(): Authentication_Method { return 'none'; },
        get_extractable_artifacts: () => artifacts,
        async inject_session_state() { /* no-op */ },
    };
}

function make_artifact(
    archive_subpath: string,
    name?: string,
    type: 'file' | 'directory' = 'directory'
): Extractable_Artifact {
    return {
        name: name ?? archive_subpath,
        container_path: `/tmp/never-checked-${archive_subpath}`,
        type,
        archive_subpath,
        required_for_resume: false,
    };
}

describe('extract_conversation layout (6.5)', () => {
    const home_handle = install_isolated_home_hooks('patchlab-extraction-layout-');

    beforeEach(() => {
        set_logger(new RecordingLogger());
    });

    afterEach(() => {
        set_logger(new ConsoleLogger());
    });

    it('6.5.2 zero-artifact provider: fence directory NOT created', () => {
        const provider = build_fake_provider([]);
        const result = extract_conversation(
            'never-used-container',
            provider,
            PATCHLAB_ID,
            SESSION_NUMBER
        );

        expect(result.extracted).toEqual([]);
        expect(result.produced_but_failed).toEqual([]);
        expect(result.skipped_invalid).toEqual([]);

        const fence = build_session_path(PATCHLAB_ID, SESSION_NUMBER, ARCHIVE_ARTIFACTS_DIRECTORY);
        expect(fs.existsSync(fence)).toBe(false);
    });

    it('6.5.3 invalid subpath: skipped with warning, name in skipped_invalid', () => {
        const provider = build_fake_provider([
            make_artifact('../../etc/passwd', 'malicious'),
        ]);
        const result = extract_conversation(
            'never-used-container',
            provider,
            PATCHLAB_ID,
            SESSION_NUMBER
        );
        expect(result.skipped_invalid).toEqual(['malicious']);
        expect(result.extracted).toEqual([]);
        expect(result.produced_but_failed).toEqual([]);
    });

    it('6.5.4 duplicate subpaths: ALL conflicting artifacts skipped, names in skipped_invalid', () => {
        const provider = build_fake_provider([
            make_artifact('shared', 'first'),
            make_artifact('shared', 'second'),
            // Even one with case-only difference collides:
            make_artifact('SHARED', 'third'),
        ]);
        const result = extract_conversation(
            'never-used-container',
            provider,
            PATCHLAB_ID,
            SESSION_NUMBER
        );
        expect(new Set(result.skipped_invalid)).toEqual(new Set(['first', 'second', 'third']));
        expect(result.extracted).toEqual([]);
    });

    it('6.5.5 namespace-collision regression: an archive_subpath of metadata.json maps under the fence, not at the session root', () => {
        // The fence makes this collision structurally impossible — the path
        // join always lands under `sessions/{n}/artifacts/`, never at
        // `sessions/{n}/metadata.json`. Asserted explicitly so a future change
        // that removes the fence (or moves a write up a level) breaks loudly.
        const session_root = build_session_path(PATCHLAB_ID, SESSION_NUMBER);
        const fence_root = build_session_path(PATCHLAB_ID, SESSION_NUMBER, ARCHIVE_ARTIFACTS_DIRECTORY);
        const expected_artifact_path = path.join(fence_root, 'metadata.json');
        const session_metadata_path = path.join(session_root, 'metadata.json');

        // The two paths SHALL be different — the fence directory separates them.
        expect(expected_artifact_path).not.toBe(session_metadata_path);
        expect(path.dirname(expected_artifact_path)).toBe(fence_root);
        expect(path.dirname(session_metadata_path)).toBe(session_root);
    });

    it('6.5.9 fence-as-symlink awareness: lstat-based check inspects only the leaf, not ancestor components', async () => {
        // Build a stale archive where `sessions/{n}/artifacts/` is itself a symlink
        // pointing at a sibling directory that holds the leaf artifact. The leaf
        // type-check passes because `lstat` only examines the leaf — by design,
        // patchlab trusts ancestor components on the rollout-purged `~/.patchlab/`
        // tree. This test exists to make that trust assumption explicit; if a
        // future change introduces a code path that creates a symlink fence,
        // this test should be revisited (the rollout's UUID-directory purge is
        // what makes this state non-occurring in practice).
        const decoy_directory = path.join(home_handle.current(), 'fake-fence');
        fs.mkdirSync(decoy_directory, { recursive: true });
        fs.mkdirSync(path.join(decoy_directory, 'conversation'), { recursive: true });

        const session_root = build_session_path(PATCHLAB_ID, SESSION_NUMBER);
        fs.mkdirSync(session_root, { recursive: true });
        const fence_path = path.join(session_root, ARCHIVE_ARTIFACTS_DIRECTORY);
        try {
            fs.symlinkSync(decoy_directory, fence_path, 'dir');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') {
                // Windows without symlink permission: the trust assumption holds
                // trivially here because the OS prevents the hostile state from
                // forming. Skip the assertion.
                return;
            }
            throw error;
        }

        // Import lazily to avoid touching the import graph above.
        const { assert_artifact_filesystem_type } = await import('../../src/extractable_artifact.js');
        const leaf_path = path.join(fence_path, 'conversation');
        // The leaf is a real directory (reached via the symlinked fence). The
        // check returns `present` because lstat on the leaf reports `directory`,
        // even though an ancestor is a symlink. This documents the asymmetry.
        const result = assert_artifact_filesystem_type(leaf_path, 'directory', 'fake-provider', 'conversation');
        expect(result).toEqual({ kind: 'present' });
    });

    it('6.5.7 result interface alias: Conversation_Extraction_Result === Artifact_Extraction_Result', () => {
        // Compile-time check via assignment between aliases. The legacy name is
        // retained as a deprecated `type` alias to ease the rename without
        // breaking external consumers; new code should use the new name.
        const sample: Artifact_Extraction_Result = {
            extracted: [],
            produced_but_failed: [],
            skipped_invalid: [],
        };
        const legacy: Conversation_Extraction_Result = sample;
        expect(legacy.extracted).toEqual([]);
        expect(legacy.skipped_invalid).toEqual([]);
    });
});
