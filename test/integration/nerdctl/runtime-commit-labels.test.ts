/**
 * nerdctl-specific integration: `commit_container` must round-trip patchlab
 * labels through the staging-tag rebuild path (nerdctl commit does not
 * support `-c LABEL=…`). Complements the generic `image-lifecycle.test.ts`
 * suite by living under `integration-nerdctl` so it only runs when nerdctl
 * is the selected runtime.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    build_image,
    PATCHLAB_TEST_LABEL,
    remove_test_images,
} from '../../../src/images.js';
import {
    commit_container,
    container_exists,
    create_container,
    remove_container,
    start_container,
    stop_container,
} from '../../../src/container_runtime.js';
import {
    FILE_COPY_TEST_TOOL,
    register_file_copy_test_tool,
} from '../../helpers/stub_tool_provider.js';
import { inspect_image_labels } from '../../helpers/exec_runtime_cli.js';

const TEST_BASE_TAG = 'patchlab/nerdctl-commit-base:latest';
const TEST_COMMIT_TAG = 'patchlab/nerdctl-commit-auth:latest';
const TEST_CONTAINER = 'patchlab-nerdctl-commit-test';
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

describe('nerdctl commit label rebuild', () => {
    it('builds a base image for the commit exercise', async () => {
        await build_image({
            tag: TEST_BASE_TAG,
            labels: [TEST_LABEL],
            tools: [FILE_COPY_TEST_TOOL],
        });
    }, 600_000);

    it('preserves patchlab labels after commit_container rebuild', () => {
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
        commit_container(TEST_CONTAINER, TEST_COMMIT_TAG, {
            'biz.ecartz.patchlab.compatible': 'true',
            [`biz.ecartz.patchlab.tool.${FILE_COPY_TEST_TOOL}`]: 'authenticated',
            'biz.ecartz.patchlab.tools': FILE_COPY_TEST_TOOL,
            [PATCHLAB_TEST_LABEL]: 'true',
        });

        const labels = inspect_image_labels(TEST_COMMIT_TAG);
        expect(labels['biz.ecartz.patchlab.compatible']).toBe('true');
        expect(labels[`biz.ecartz.patchlab.tool.${FILE_COPY_TEST_TOOL}`]).toBe('authenticated');
        expect(labels['biz.ecartz.patchlab.tools']).toBe(FILE_COPY_TEST_TOOL);
        expect(labels[PATCHLAB_TEST_LABEL]).toBe('true');
    }, 120_000);
});
