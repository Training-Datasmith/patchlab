import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { create_sandbox_from_directory, ensure_integration_test_tool_registered } from '../../test_helpers.js';
import { DEFAULT_TEST_TOOL } from '../../helpers/stub_tool_provider.js';

import { exec_container, image_exists, DEFAULT_IMAGE } from '../../../src/container_runtime.js';
import { build_image, list_images, get_default_image, has_any_compatible_image, PATCHLAB_TEST_LABEL, remove_test_images } from '../../../src/images.js';
import { get_image_capabilities, check_stale_image } from '../../../src/stale.js';
import {
    create_integration_cleanup_registry,
    register_destroy_sandbox,
} from '../../helpers/integration_cleanup.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

const TEST_TAG = 'patchlab/sandbox-podman-test:latest';
const TEST_LABEL = `${PATCHLAB_TEST_LABEL}=true`;
const cleanup = create_integration_cleanup_registry();

beforeAll(async () => {
    ensure_integration_test_tool_registered();
    if (!image_exists(TEST_TAG)) {
        await build_image({ tag: TEST_TAG, tools: [DEFAULT_TEST_TOOL], capabilities: ['podman'], labels: [TEST_LABEL] });
    }
}, 600_000);

afterAll(async () => {
    await cleanup.run_all();
    remove_test_images();
});

// Image-label inspections stay in integration because the producer step
// (`build_image` in the file-scope `beforeAll`) crosses the host↔container
// boundary.
describe('podman-capable image labels', () => {
    // Task 6.7: build-image writes capabilities label to image
    it('image has capabilities label with expected value', () => {
        const caps = get_image_capabilities(TEST_TAG);
        expect(caps).not.toBeNull();
        expect(caps).toContain('podman');
    });

    // Task 6.9: stale image warning via capability label comparison
    it('stale check reports missing capability not in image', () => {
        const result = check_stale_image(TEST_TAG, ['podman', 'postgres-client']);
        expect(result.stale).toBe(true);
        expect(result.missing).toContain('postgres-client');
        expect(result.no_label).toBe(false);
    });

    it('stale check passes when all capabilities present', () => {
        const result = check_stale_image(TEST_TAG, ['podman']);
        expect(result.stale).toBe(false);
        expect(result.missing).toEqual([]);
    });
});

// list_images/get_default_image/has_any_compatible_image are tested here rather
// than in the unit suite because their producer step (podman images) crosses the
// host↔container boundary. The file-scope beforeAll already built TEST_TAG, so
// these tests are guaranteed to find at least one patchlab-compatible image.
describe('image listing functions', () => {
    it('list_images includes the test image built in beforeAll', () => {
        const images = list_images();
        const found = images.find((img) => `${img.repository}:${img.tag}` === TEST_TAG);
        expect(found).toBeDefined();
        expect(found?.tools).toContain(DEFAULT_TEST_TOOL);
        expect(found?.capabilities).toContain('podman');
    });

    it('has_any_compatible_image returns true when at least one image exists', () => {
        expect(has_any_compatible_image()).toBe(true);
    });

    it('get_default_image returns an image satisfying the tool and capability filter', () => {
        const default_image = get_default_image(DEFAULT_TEST_TOOL, ['podman']);
        expect(default_image).not.toBeNull();
        const images = list_images();
        const matched = images.find((img) => `${img.repository}:${img.tag}` === default_image);
        expect(matched?.tools).toContain(DEFAULT_TEST_TOOL);
        expect(matched?.capabilities).toContain('podman');
    });

    it('get_default_image returns null when a required capability is absent', () => {
        expect(get_default_image(DEFAULT_TEST_TOOL, ['postgres-client'])).toBeNull();
    });

    it('get_default_image returns null when no image has the required tool', () => {
        expect(get_default_image('unknown-tool')).toBeNull();
    });
});

// Locks the off-by-default contract: socket mounts and CONTAINER_HOST are not
// injected unless the caller explicitly approves socket access.
describe('sandbox WITHOUT podman socket access — off-by-default contract', () => {
    let source_directory: string;
    let no_socket_sandbox_id: string;
    let no_socket_container_name: string;

    beforeAll(async () => {
        source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-no-socket-'));
        execFileSync('git', ['init'], { cwd: source_directory });
        fs.writeFileSync(path.join(source_directory, 'placeholder.txt'), 'noop\n');
        execFileSync('git', ['add', '-A'], { cwd: source_directory });
        execFileSync('git', ['commit', '-m', 'init', '--allow-empty'], {
            cwd: source_directory,
            env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' },
        });
        cleanup.register(() => fs.rmSync(source_directory, { recursive: true, force: true }));

        // Critical: NO volume_mounts and NO environment_variables. We do not
        // pass the podman-capable TEST_TAG either — using the default test
        // image makes it impossible for the caller to accidentally inherit
        // anything socket-shaped from image-level capability metadata.
        const manifest = await create_sandbox_from_directory(source_directory, {
            image: DEFAULT_IMAGE,
            no_install: true,
        });
        no_socket_sandbox_id = manifest.id;
        no_socket_container_name = manifest.container_name;
        register_destroy_sandbox(cleanup, no_socket_sandbox_id);
    }, 120_000);

    it('CONTAINER_HOST is unset in the container environment', () => {
        // Use `printenv -0` style sentinel to distinguish "unset" from "empty"
        // — `echo $CONTAINER_HOST` would print a blank line in either case.
        const probe = exec_container(
            no_socket_container_name,
            ['sh', '-c', 'if [ -z "${CONTAINER_HOST+set}" ]; then echo UNSET; else echo "SET=$CONTAINER_HOST"; fi'],
        );
        expect(probe.trim()).toBe('UNSET');
    });

    it('the podman socket is NOT mounted inside the container', () => {
        const probe = exec_container(
            no_socket_container_name,
            ['sh', '-c', 'test -S /run/podman/podman.sock && echo MOUNTED || echo ABSENT'],
        );
        expect(probe.trim()).toBe('ABSENT');
    });
});
