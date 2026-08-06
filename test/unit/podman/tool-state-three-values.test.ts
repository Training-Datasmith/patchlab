/**
 * Lock the four-value Tool_State semantics that ship with
 * `separate-authenticated-state`. Three layers of assertions:
 *
 *   1. `was_authentication_attempted_at_build` truth table — the predicate
 *      collapses `'authenticated'` and `'ready'` into "auth ran at build,"
 *      leaving `'installed'` and `'absent'` as "no" answers.
 *   2. Each `authentication_result.type` value maps to the expected
 *      commit-site `Tool_State` label, and that label routes to the
 *      expected tag form (`-auth` for `'authenticated'`/`'ready'`, no-auth
 *      for `'installed'`).
 *   3. Orphan combinations (auth-tag with `'installed'`; no-auth-tag with
 *      `'authenticated'` or `'ready'`) are rejected as cache misses by the
 *      lookup chain.
 *
 * Test plumbing mirrors `effective-image.test.ts` (the established pattern
 * for mocking podman and tracking commits in unit space).
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
import type { Tool_State_Mock_State, Create_Container_Call } from '../../helpers/podman_mock_tool_state.js';

// `vi.hoisted` is required: the `vi.mock` factory below reads `state` to pass
// it to the helper's `build_tool_state_podman_mock`. See effective-image.test.ts
// for the same pattern.
const state = vi.hoisted((): Tool_State_Mock_State => ({
    mock_tool_state: 'absent',
    mock_is_patchlab_compatible: true,
    committed_tags: [] as string[],
    committed_labels: [] as Record<string, string>[],
    cached_images: new Set<string>(),
    create_container_calls: [] as Create_Container_Call[],
}));

vi.mock('../../../src/podman.js', async (importOriginal) => {
    const { build_tool_state_podman_mock } = await import('../../helpers/podman_mock_tool_state.js');
    return build_tool_state_podman_mock(state, importOriginal);
});

import { was_authentication_attempted_at_build, get_image_tool_state } from '../../../src/podman.js';
import { install_sandbox_cleanup_hooks } from '../../helpers/sandbox_cleanup.js';

const mock_get_image_tool_state = get_image_tool_state as ReturnType<typeof vi.fn>;

describe('was_authentication_attempted_at_build — truth table', () => {
    it('returns true for "authenticated" (credentials in image bytes)', () => {
        expect(was_authentication_attempted_at_build('authenticated')).toBe(true);
    });

    it('returns true for "ready" (auth ran at build, credentials supplied at runtime)', () => {
        expect(was_authentication_attempted_at_build('ready')).toBe(true);
    });

    it('returns false for "installed" (tool baked in, no auth at build time)', () => {
        expect(was_authentication_attempted_at_build('installed')).toBe(false);
    });

    it('returns false for "absent" (no per-tool label on the image)', () => {
        expect(was_authentication_attempted_at_build('absent')).toBe(false);
    });
});

describe('authentication_result.type → Tool_State label dispatch', () => {
    let temp_source: string;
    const { ids: sandbox_ids } = install_sandbox_cleanup_hooks();

    beforeAll(() => {
        temp_source = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-three-values-test-'));
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

    it("file_copy result → label 'authenticated' at -auth tag", async () => {
        // patchlab-test-tool-file-copy is the canonical file_copy provider.
        const manifest = await create_sandbox_from_directory(temp_source, {
            image: 'node:22-slim',
            tool: 'patchlab-test-tool-file-copy',
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_ids.push(manifest.id);

        const auth_tag_commit = state.committed_labels.find((labels) =>
            labels['biz.ecartz.patchlab.tool.patchlab-test-tool-file-copy'] !== undefined,
        );
        expect(auth_tag_commit?.['biz.ecartz.patchlab.tool.patchlab-test-tool-file-copy']).toBe('authenticated');
        expect(state.committed_tags.some((t) => t.endsWith('-patchlab-test-tool-file-copy-auth:latest'))).toBe(true);
        expect(state.committed_tags.some((t) => t.endsWith('-patchlab-test-tool-file-copy:latest') && !t.endsWith('-auth:latest'))).toBe(false);
    });

    it("environment_variables result → label 'ready' at -auth tag", async () => {
        // patchlab-test-tool-env is the canonical env-var provider. Set the var so
        // inject_authentication returns a non-empty result.
        const original_env = { ...process.env };
        process.env.TEST_API_KEY = 'test-key-from-three-values-test';
        let manifest;
        try {
            manifest = await create_sandbox_from_directory(temp_source, {
                image: 'prebaked-sandbox:1.0',
                tool: 'patchlab-test-tool-env',
                no_install: true,
                allow_dirty_tree: true,
            });
            sandbox_ids.push(manifest.id);
        } finally {
            process.env = original_env;
        }

        const auth_tag_commit = state.committed_labels.find((labels) =>
            labels['biz.ecartz.patchlab.tool.patchlab-test-tool-env'] !== undefined,
        );
        expect(auth_tag_commit?.['biz.ecartz.patchlab.tool.patchlab-test-tool-env']).toBe('ready');
        expect(state.committed_tags.some((t) => t.endsWith('-patchlab-test-tool-env-auth:latest'))).toBe(true);
        expect(state.committed_tags.some((t) => t.endsWith('-patchlab-test-tool-env:latest') && !t.endsWith('-auth:latest'))).toBe(false);
    });

    it("none result (env_var with var unset) → label 'installed' at no-auth tag", async () => {
        // patchlab-test-tool-env with TEST_API_KEY unset → inject_authentication
        // returns { type: 'none' } → label 'installed' at no-auth tag.
        delete process.env.TEST_API_KEY;
        const manifest = await create_sandbox_from_directory(temp_source, {
            image: 'prebaked-sandbox:1.0',
            tool: 'patchlab-test-tool-env',
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_ids.push(manifest.id);

        const installed_commit = state.committed_labels.find((labels) =>
            labels['biz.ecartz.patchlab.tool.patchlab-test-tool-env'] !== undefined,
        );
        expect(installed_commit?.['biz.ecartz.patchlab.tool.patchlab-test-tool-env']).toBe('installed');
        expect(state.committed_tags.some((t) => t.endsWith('-patchlab-test-tool-env:latest') && !t.endsWith('-auth:latest'))).toBe(true);
        expect(state.committed_tags.some((t) => t.endsWith('-patchlab-test-tool-env-auth:latest'))).toBe(false);
    });
});

describe('cache-lookup orphan-state rejection (lookup chain)', () => {
    let temp_source: string;
    const { ids: sandbox_ids } = install_sandbox_cleanup_hooks();

    beforeAll(() => {
        temp_source = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-orphan-test-'));
        initialize_repository_with_initial_commit(temp_source);
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

    it("rejects auth-tag image with 'installed' label as cache miss", async () => {
        const auth_tag = 'patchlab/node-22-slim-patchlab-test-tool-file-copy-auth:latest';
        state.cached_images.add(auth_tag);
        mock_get_image_tool_state.mockImplementation((image: string, _tool: string) => {
            // Auth-tag carries `'installed'` — an orphan from the pre-cleanup
            // misnomer era. Should be skipped.
            return (image === auth_tag) ? 'installed' : 'absent';
        });

        const manifest = await create_sandbox_from_directory(temp_source, {
            image: 'node:22-slim',
            tool: 'patchlab-test-tool-file-copy',
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_ids.push(manifest.id);

        // The orphan must be overwritten with a correct fresh commit; the
        // resulting tag carries 'authenticated' (file_copy provider).
        const final_commit = state.committed_labels.find((labels) =>
            labels['biz.ecartz.patchlab.tool.patchlab-test-tool-file-copy'] !== undefined,
        );
        expect(final_commit?.['biz.ecartz.patchlab.tool.patchlab-test-tool-file-copy']).toBe('authenticated');
    });

    it("rejects no-auth-tag image with 'authenticated' label as cache miss", async () => {
        const installed_tag = 'patchlab/node-22-slim-patchlab-test-tool-file-copy:latest';
        state.cached_images.add(installed_tag);
        mock_get_image_tool_state.mockImplementation((image: string, _tool: string) => {
            // No-auth-tag carries `'authenticated'` — wrong tag form for the label.
            return (image === installed_tag) ? 'authenticated' : 'absent';
        });

        const manifest = await create_sandbox_from_directory(temp_source, {
            image: 'node:22-slim',
            tool: 'patchlab-test-tool-file-copy',
            no_install: true,
            allow_dirty_tree: true,
        });
        sandbox_ids.push(manifest.id);

        // No-auth-tag with auth-attempted label is skipped — the lookup falls
        // through to a fresh commit.
        const final_commit = state.committed_labels.find((labels) =>
            labels['biz.ecartz.patchlab.tool.patchlab-test-tool-file-copy'] !== undefined,
        );
        expect(final_commit?.['biz.ecartz.patchlab.tool.patchlab-test-tool-file-copy']).toBe('authenticated');
    });

    it("rejects no-auth-tag image with 'ready' label as cache miss (new symmetric case)", async () => {
        // The new branch the spec's "Installed-tag image with authenticated
        // or ready label is treated as a cache miss" scenario adds.
        const installed_tag = `patchlab/prebaked-sandbox-1.0-${ENV_VAR_TEST_TOOL}:latest`;
        state.cached_images.add(installed_tag);
        mock_get_image_tool_state.mockImplementation((image: string, _tool: string) => {
            // No-auth-tag carries `'ready'` — also a wrong-tag-form orphan.
            return image === installed_tag ? 'ready' : 'absent';
        });

        const original_env = { ...process.env };
        process.env.TEST_API_KEY = 'test-key-orphan-ready';
        let manifest;
        try {
            manifest = await create_sandbox_from_directory(temp_source, {
                image: 'prebaked-sandbox:1.0',
                tool: 'patchlab-test-tool-env',
                no_install: true,
                allow_dirty_tree: true,
            });
            sandbox_ids.push(manifest.id);
        } finally {
            process.env = original_env;
        }

        // The orphan installed-tag-with-ready is skipped; fresh commit lands
        // at the auth-tag with the correct 'ready' label.
        const final_commit = state.committed_labels.find((labels) =>
            labels['biz.ecartz.patchlab.tool.patchlab-test-tool-env'] !== undefined,
        );
        expect(final_commit?.['biz.ecartz.patchlab.tool.patchlab-test-tool-env']).toBe('ready');
        const committed_to_authenticated_tag = state.committed_tags.some((t) =>
            t.endsWith('-patchlab-test-tool-env-auth:latest'),
        );
        expect(committed_to_authenticated_tag).toBe(true);
    });
});
