/**
 * Negative tests for tag-form-must-match-label invariants. The cache-lookup
 * chain SILENTLY rejects mismatches (falls through, no error), so a
 * regression at the write site would not surface in normal use — these
 * explicit guards catch a future change that accidentally writes the wrong
 * label form. Each `it()` block asserts a "does NOT happen" property.
 *
 * Companion to `tool-state-three-values.test.ts` (which asserts the
 * positive direction). The two files together pin the four-value Tool_State
 * surface from both sides.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { create_sandbox_from_directory } from '../../test_helpers.js';
import {
    FILE_COPY_TEST_TOOL,
    ENV_VAR_TEST_TOOL,
    register_file_copy_test_tool,
    register_env_var_test_tool,
} from '../../helpers/stub_tool_provider.js';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initialize_repository_with_initial_commit } from '../../helpers/git_repository.js';
import type { Tool_State } from '../../../src/container_runtime.js';
import type { Tool_State_Mock_State, Create_Container_Call } from '../../helpers/podman_mock_tool_state.js';

const state = vi.hoisted((): Tool_State_Mock_State => ({
    mock_tool_state: 'absent',
    mock_is_patchlab_compatible: true,
    committed_tags: [] as string[],
    committed_labels: [] as Record<string, string>[],
    cached_images: new Set<string>(),
    create_container_calls: [] as Create_Container_Call[],
}));

vi.mock('../../../src/container_runtime.js', async (importOriginal) => {
    const { build_tool_state_podman_mock } = await import('../../helpers/podman_mock_tool_state.js');
    return build_tool_state_podman_mock(state, importOriginal);
});

import { get_image_tool_state } from '../../../src/container_runtime.js';
import { install_sandbox_cleanup_hooks } from '../../helpers/sandbox_cleanup.js';

const mock_get_image_tool_state = get_image_tool_state as ReturnType<typeof vi.fn>;

interface Tag_With_Label { tag: string; label: string | undefined }

function tags_with_their_labels(tool: string): Tag_With_Label[] {
    // Each commit pushes its tag at the same array index as its labels.
    // Pair them up; ignore commits that didn't carry the per-tool label.
    const label_key = `biz.ecartz.patchlab.tool.${tool}`;
    const pairs: Tag_With_Label[] = [];
    for (let i = 0; i < state.committed_tags.length; i++) {
        pairs.push({ tag: state.committed_tags[i], label: state.committed_labels[i]?.[label_key] });
    }

    return pairs;
}

describe('tag-form-must-match-label write invariants', () => {
    let temp_source: string;
    const { ids: sandbox_ids } = install_sandbox_cleanup_hooks();

    beforeAll(() => {
        temp_source = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-tag-invariants-test-'));
        initialize_repository_with_initial_commit(temp_source);
        register_file_copy_test_tool();
        register_env_var_test_tool();
    });

    afterAll(() => {
        fs.rmSync(temp_source, { recursive: true, force: true });
    });

    beforeEach(() => {
        delete process.env.TEST_API_KEY;
        state.committed_tags.length = 0;
        state.committed_labels.length = 0;
        state.cached_images.clear();
        state.mock_is_patchlab_compatible = true;
        state.mock_tool_state = 'absent';
        mock_get_image_tool_state.mockReset();
        mock_get_image_tool_state.mockImplementation((_image: string, _tool: string) => state.mock_tool_state);
    });

    it("env-var-method (vars set) commits 'ready' — NOT 'authenticated'", async () => {
        const original_env = { ...process.env };
        process.env.TEST_API_KEY = 'invariant-test-key';
        try {
            const manifest = await create_sandbox_from_directory(temp_source, {
                image: 'prebaked-sandbox:1.0',
                tool: 'patchlab-test-tool-env',
                no_install: true,
                allow_dirty_tree: true,
            });
            sandbox_ids.push(manifest.id);
        } finally {
            process.env = original_env;
        }

        const pairs = tags_with_their_labels('patchlab-test-tool-env');
        const tool_commit = pairs.find((p) => p.label !== undefined);
        expect(tool_commit?.label).toBe('ready');
        // The forbidden write: env-var provider must NOT emit 'authenticated'.
        expect(tool_commit?.label).not.toBe('authenticated');
    });

    it("file_copy-method commits 'authenticated' — NOT 'ready'", async () => {
        const manifest = await create_sandbox_from_directory(temp_source, {
            image: 'node:22-slim',
            tool: 'patchlab-test-tool-file-copy',
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_ids.push(manifest.id);

        const pairs = tags_with_their_labels('patchlab-test-tool-file-copy');
        const tool_commit = pairs.find((p) => p.label !== undefined);
        expect(tool_commit?.label).toBe('authenticated');
        // The forbidden write: file_copy provider must NOT emit 'ready'.
        expect(tool_commit?.label).not.toBe('ready');
    });

    it("none result (env-var with vars unset) commits 'installed' — never 'authenticated' or 'ready'", async () => {
        delete process.env.TEST_API_KEY;
        const manifest = await create_sandbox_from_directory(temp_source, {
            image: 'prebaked-sandbox:1.0',
            tool: 'patchlab-test-tool-env',
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_ids.push(manifest.id);

        const pairs = tags_with_their_labels('patchlab-test-tool-env');
        const tool_commit = pairs.find((p) => p.label !== undefined);
        expect(tool_commit?.label).toBe('installed');
        expect(tool_commit?.label).not.toBe('authenticated');
        expect(tool_commit?.label).not.toBe('ready');
    });

    it("'ready' is never written to a no-auth tag (env-var-method routes to -auth tag only)", async () => {
        const original_env = { ...process.env };
        process.env.TEST_API_KEY = 'invariant-test-key';
        try {
            const manifest = await create_sandbox_from_directory(temp_source, {
                image: 'prebaked-sandbox:1.0',
                tool: 'patchlab-test-tool-env',
                no_install: true,
                allow_dirty_tree: true,
            });
            sandbox_ids.push(manifest.id);
        } finally {
            process.env = original_env;
        }

        const pairs = tags_with_their_labels('patchlab-test-tool-env');
        // Find any 'ready' commit AND assert it's at the -auth tag form.
        const ready_pairs = pairs.filter((p) => p.label === 'ready');
        expect(ready_pairs.length).toBeGreaterThan(0);
        for (const { tag } of ready_pairs) {
            expect(tag.endsWith('-patchlab-test-tool-env-auth:latest')).toBe(true);
            // The no-auth tag form (no `-auth` suffix) must not receive 'ready'.
            expect(tag.endsWith('-patchlab-test-tool-env:latest') && !tag.endsWith('-auth:latest')).toBe(false);
        }
    });

    it("'authenticated' is never written to a no-auth tag (file_copy-method routes to -auth tag only)", async () => {
        const manifest = await create_sandbox_from_directory(temp_source, {
            image: 'node:22-slim',
            tool: 'patchlab-test-tool-file-copy',
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_ids.push(manifest.id);

        const pairs = tags_with_their_labels('patchlab-test-tool-file-copy');
        const authenticated_pairs = pairs.filter((p) => p.label === 'authenticated');
        expect(authenticated_pairs.length).toBeGreaterThan(0);
        for (const { tag } of authenticated_pairs) {
            expect(tag.endsWith('-patchlab-test-tool-file-copy-auth:latest')).toBe(true);
            expect(tag.endsWith('-patchlab-test-tool-file-copy:latest') && !tag.endsWith('-auth:latest')).toBe(false);
        }
    });
});

describe('auth-tag write-path overwrite on label-form change', () => {
    let temp_source: string;
    const { ids: sandbox_ids } = install_sandbox_cleanup_hooks();

    beforeAll(() => {
        temp_source = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-overwrite-test-'));
        initialize_repository_with_initial_commit(temp_source);
        register_env_var_test_tool();
    });

    afterAll(() => {
        fs.rmSync(temp_source, { recursive: true, force: true });
    });

    beforeEach(() => {
        state.committed_tags.length = 0;
        state.committed_labels.length = 0;
        state.cached_images.clear();
        state.mock_is_patchlab_compatible = true;
        mock_get_image_tool_state.mockReset();
    });

    it("auth-tag with legacy 'authenticated' label is overwritten by a fresh 'ready' commit on env-var rebuild", async () => {
        // The spec scenario "Auth-tag rebuild overwrites an existing
        // mismatched-form label." Simulate a pre-`separate-authenticated-state`
        // env-var build that wrote `'authenticated'` to the auth-tag.
        // Then `--force-rebuild` with the env var set produces a NEW commit
        // labeled `'ready'`, overwriting the legacy label at the same tag.
        const auth_tag = `patchlab/prebaked-sandbox-1.0-${ENV_VAR_TEST_TOOL}-auth:latest`;
        state.cached_images.add(auth_tag);
        mock_get_image_tool_state.mockImplementation((image: string, _tool: string): Tool_State => {
            return (image === auth_tag) ? 'authenticated' : 'absent';
        });

        const original_env = { ...process.env };
        process.env.TEST_API_KEY = 'fresh-key-for-overwrite-test';
        try {
            const manifest = await create_sandbox_from_directory(temp_source, {
                image: 'prebaked-sandbox:1.0',
                tool: 'patchlab-test-tool-env',
                no_install: true,
                allow_dirty_tree: true,
                force_rebuild: true,  // force the commit to actually run
            });
            sandbox_ids.push(manifest.id);
        } finally {
            process.env = original_env;
        }

        // A commit happened (force-rebuild bypasses the skip).
        const pairs = tags_with_their_labels('patchlab-test-tool-env');
        const overwrite = pairs.find((p) => p.tag === auth_tag && p.label !== undefined);
        expect(overwrite).toBeDefined();
        // The new commit at the SAME tag carries the new label form.
        expect(overwrite?.label).toBe('ready');
    });
});