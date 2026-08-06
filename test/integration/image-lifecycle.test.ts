import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build_image, PATCHLAB_TEST_LABEL, remove_test_images } from '../../src/images.js';
import { detect_package_manager } from '../../src/capabilities.js';
import {
    get_image_tool_state,
    is_patchlab_compatible_image,
    was_authentication_attempted_at_build,
    create_container,
    start_container,
    stop_container,
    remove_container,
    exec_container,
    commit_container,
    container_exists,
} from '../../src/podman.js';
import {
    FILE_COPY_TEST_TOOL,
    register_file_copy_test_tool,
} from '../helpers/stub_tool_provider.js';

const TEST_BASE_TAG = 'patchlab/test-lifecycle:base';
const TEST_AUTH_TAG = 'patchlab/test-lifecycle:auth';
const TEST_CONTAINER = 'patchlab-lifecycle-test';
const TEST_LABEL = `${PATCHLAB_TEST_LABEL}=true`;

const cleanup: (() => void)[] = [];

beforeAll(() => {
    register_file_copy_test_tool();
});

afterAll(() => {
    for (const fn of cleanup.toReversed()) {
        try {
            fn();
        } catch {
            // ignore
        }
    }
    remove_test_images();
});

describe('image lifecycle', () => {
    it('builds a base patchlab image with git and the stub file_copy provider', async () => {
        const tag = await build_image({
            tag: TEST_BASE_TAG,
            labels: [TEST_LABEL],
            tools: [FILE_COPY_TEST_TOOL],
        });
        expect(tag).toBe(TEST_BASE_TAG);
    }, 600_000);

    it('base image is patchlab-compatible without auth baked in', () => {
        expect(is_patchlab_compatible_image(TEST_BASE_TAG)).toBe(true);
        const state = get_image_tool_state(TEST_BASE_TAG, FILE_COPY_TEST_TOOL);
        expect(was_authentication_attempted_at_build(state)).toBe(false);
    });

    it('base image has git available', () => {
        const container = `${TEST_CONTAINER}-git-check`;
        try {
            execFileSync('podman', ['create', '--name', container, TEST_BASE_TAG, 'git', '--version'], { stdio: 'pipe' });
            execFileSync('podman', ['start', container], { stdio: 'pipe' });
            const output = execFileSync('podman', ['logs', container], { stdio: 'pipe' }).toString('utf-8');
            expect(output).toContain('git version');
        } finally {
            try {
                execFileSync('podman', ['rm', '-f', container], { stdio: 'pipe' });
            } catch {
                // ignore
            }
        }
    });

    it('commits container as authenticated image with every supplied label intact', () => {
        if (container_exists(TEST_CONTAINER)) {
            remove_container(TEST_CONTAINER);
        }
        cleanup.push(() => {
            try {
                remove_container(TEST_CONTAINER);
            } catch {
                // ignore
            }
        });

        create_container(TEST_CONTAINER, TEST_BASE_TAG);
        start_container(TEST_CONTAINER);
        stop_container(TEST_CONTAINER);
        commit_container(TEST_CONTAINER, TEST_AUTH_TAG, {
            'biz.ecartz.patchlab.compatible': 'true',
            [`biz.ecartz.patchlab.tool.${FILE_COPY_TEST_TOOL}`]: 'authenticated',
            'biz.ecartz.patchlab.tools': FILE_COPY_TEST_TOOL,
            [PATCHLAB_TEST_LABEL]: 'true',
        });

        const labels_raw = execFileSync(
            'podman',
            ['image', 'inspect', '--format', '{{json .Labels}}', TEST_AUTH_TAG],
            { stdio: 'pipe' },
        ).toString('utf-8').trim();
        const labels = JSON.parse(labels_raw) as Record<string, string>;
        expect(labels['biz.ecartz.patchlab.compatible']).toBe('true');
        expect(labels[`biz.ecartz.patchlab.tool.${FILE_COPY_TEST_TOOL}`]).toBe('authenticated');
        expect(labels['biz.ecartz.patchlab.tools']).toBe(FILE_COPY_TEST_TOOL);
        expect(labels[PATCHLAB_TEST_LABEL]).toBe('true');
    }, 120_000);

    it('authenticated image\'s per-tool state is "authenticated"', () => {
        expect(is_patchlab_compatible_image(TEST_AUTH_TAG)).toBe(true);
        expect(get_image_tool_state(TEST_AUTH_TAG, FILE_COPY_TEST_TOOL)).toBe('authenticated');
    });

    it('detects apt as the package manager for the base image', () => {
        const pm = detect_package_manager(TEST_BASE_TAG);
        expect(pm).toBe('apt');
    });

    it('authenticated image still has git available', () => {
        const container = `${TEST_CONTAINER}-no-setup`;
        try {
            execFileSync('podman', ['create', '--name', container, TEST_AUTH_TAG, 'sleep', 'infinity'], { stdio: 'pipe' });
            execFileSync('podman', ['start', container], { stdio: 'pipe' });

            const git_output = exec_container(container, ['git', '--version']);
            expect(git_output).toContain('git version');
        } finally {
            try {
                execFileSync('podman', ['rm', '-f', container], { stdio: 'pipe' });
            } catch {
                // ignore
            }
        }
    });
});
