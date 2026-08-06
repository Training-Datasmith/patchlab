/**
 * Read-tolerance for legacy `'authenticated'` labels on env-var-method
 * images. Locks the spec scenarios:
 *   - "Legacy authenticated label on environment_variables-method image is
 *     read-tolerated"
 *   - "Container from legacy authenticated cache on environment_variables
 *     provider still needs env var"
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { create_sandbox_from_directory } from '../../test_helpers.js';
import { ENV_VAR_TEST_TOOL, register_env_var_test_tool } from '../../helpers/stub_tool_provider.js';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import type { Tool_State } from '../../../src/podman.js';
import type { Tool_State_Mock_State, Create_Container_Call } from '../../helpers/podman_mock_tool_state.js';

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

import { get_image_tool_state } from '../../../src/podman.js';
import { install_sandbox_cleanup_hooks } from '../../helpers/sandbox_cleanup.js';

const mock_get_image_tool_state = get_image_tool_state as ReturnType<typeof vi.fn>;

describe('legacy "authenticated" label on env-var-method auth-tag image', () => {
    let temp_source: string;
    const { ids: sandbox_ids } = install_sandbox_cleanup_hooks();

    beforeEach(() => {
        register_env_var_test_tool();
        temp_source = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-legacy-label-test-'));
        execFileSync('git', ['init'], { cwd: temp_source });
        fs.writeFileSync(path.join(temp_source, 'README.md'), '# test\n');
        execFileSync('git', ['add', '-A'], { cwd: temp_source });
        execFileSync('git', ['commit', '-m', 'init', '--allow-empty'], {
            cwd: temp_source,
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test',
                GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test',
            },
        });
        state.committed_labels.length = 0;
        state.cached_images.clear();
        state.create_container_calls.length = 0;
        state.mock_is_patchlab_compatible = true;
        mock_get_image_tool_state.mockReset();
    });

    afterEach(() => {
        fs.rmSync(temp_source, { recursive: true, force: true });
    });

    it('lookup accepts legacy-labeled image as auth-tag cache hit AND env var is still passed at create-time', async () => {
        const legacy_auth_tag = `patchlab/prebaked-sandbox-1.0-${ENV_VAR_TEST_TOOL}-auth:latest`;
        state.cached_images.add(legacy_auth_tag);
        mock_get_image_tool_state.mockImplementation((image: string, _tool: string): Tool_State => {
            return (image === legacy_auth_tag) ? 'authenticated' : 'absent';
        });

        const original_env = { ...process.env };
        process.env.TEST_API_KEY = 'fresh-host-key-for-legacy-test';
        let manifest;
        try {
            manifest = await create_sandbox_from_directory(temp_source, {
                image: 'prebaked-sandbox:1.0',
                tool: ENV_VAR_TEST_TOOL,
                no_install: true,
                allow_dirty_tree: true,
            });
            sandbox_ids.push(manifest.id);
        } finally {
            process.env = original_env;
        }

        const legacy_image_commit = state.committed_labels.find(
            (labels) => labels[`biz.ecartz.patchlab.tool.${ENV_VAR_TEST_TOOL}`] !== undefined,
        );
        expect(legacy_image_commit).toBeUndefined();

        expect(state.create_container_calls.length).toBe(1);
        const create_options = state.create_container_calls[0].options as
            | { extra_environment_variables?: Record<string, string> }
            | undefined;
        expect(create_options?.extra_environment_variables).toEqual({
            TEST_API_KEY: 'fresh-host-key-for-legacy-test',
        });
    });
});
