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
import { ensure_host_podman_socket, HOST_PODMAN_SOCKET_SKIP_REASON } from '../../helpers/podman_socket.js';
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

// Tests 1-6 below all probe ONE shared socket-mounted sandbox: tests 2-5 are
// read-only inspections of `podman` running inside, and test 6 writes a tiny
// /tmp script that no sibling references. Per
// [documents/testing-strategy.md](../../../documents/testing-strategy.md)
// "Within an integration file: shared sandbox vs per-test", the sandbox
// creation lifts into `beforeAll` next to the image build at the file scope.
// Tests 7-9 (image-label inspections) sit in their own describe further down
// — they read labels from the host-built image TEST_TAG, not the sandbox,
// and stay in integration because the producer step (`build_image` in the
// file-scope `beforeAll`) crosses the host↔container boundary.
describe('sandbox with podman socket access', () => {
    let source_directory: string;
    let sandbox_id: string;
    let container_name: string;
    let host_podman_socket: string | null = null;

    beforeAll(async () => {
        const socket_handle = await ensure_host_podman_socket();
        if (!socket_handle) {
            return;
        }

        host_podman_socket = socket_handle.path;
        cleanup.register(() => socket_handle.stop());

        source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-podman-test-'));
        execFileSync('git', ['init'], { cwd: source_directory });
        fs.mkdirSync(path.join(source_directory, 'src'), { recursive: true });
        fs.writeFileSync(
            path.join(source_directory, 'src', 'runner.ts'),
            "import { execFileSync } from 'node:child_process';\nexecFileSync('podman', ['info']);\n"
        );
        execFileSync('git', ['add', '-A'], { cwd: source_directory });
        execFileSync('git', ['commit', '-m', 'init', '--allow-empty'], {
            cwd: source_directory,
            env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test' },
        });
        cleanup.register(() => fs.rmSync(source_directory, { recursive: true, force: true }));

        const socket_path = host_podman_socket;
        const manifest = await create_sandbox_from_directory(source_directory, {
            image: TEST_TAG,
            no_install: true,
            volume_mounts: [`${socket_path}:/run/podman/podman.sock`],
            environment_variables: {
                CONTAINER_HOST: 'unix:///run/podman/podman.sock',
            },
        });
        sandbox_id = manifest.id;
        container_name = manifest.container_name;
        register_destroy_sandbox(cleanup, sandbox_id);
    }, 120_000);

    it('creates a sandbox with socket mount and CONTAINER_HOST (beforeAll sanity check)', (context) => {
        if (!host_podman_socket) {
            context.skip(HOST_PODMAN_SOCKET_SKIP_REASON);
        }

        // Sanity-witness that the file-scope `beforeAll` produced a usable
        // sandbox. Without this, a regression in `create_sandbox_from_directory`
        // would surface as cryptic failures inside the read-only tests below
        // rather than a clear "the sandbox couldn't be built" message.
        expect(sandbox_id).toBeDefined();
        expect(container_name).toBeDefined();
    });

    it('podman is accessible inside the sandbox', (context) => {
        if (!host_podman_socket) {
            context.skip(HOST_PODMAN_SOCKET_SKIP_REASON);
        }

        const output = exec_container(container_name, ['podman', '--version']);
        expect(output).toContain('podman version');
    });

    it('podman can connect to the host runtime via socket', (context) => {
        if (!host_podman_socket) {
            context.skip(HOST_PODMAN_SOCKET_SKIP_REASON);
        }

        const output = exec_container(container_name, ['podman', 'info', '--format', '{{.Host.RemoteSocket.Exists}}']);
        expect(output.trim()).toBe('true');
    });

    it('podman can list images from inside the sandbox', (context) => {
        if (!host_podman_socket) {
            context.skip(HOST_PODMAN_SOCKET_SKIP_REASON);
        }

        const output = exec_container(container_name, ['podman', 'images', '--format', 'json']);
        const images = JSON.parse(output);
        expect(Array.isArray(images)).toBe(true);
    });

    it('podman can create and remove a container from inside the sandbox', (context) => {
        if (!host_podman_socket) {
            context.skip(HOST_PODMAN_SOCKET_SKIP_REASON);
        }

        const test_name = `patchlab-inner-test-${Date.now()}`;
        try {
            exec_container(container_name, ['podman', 'create', '--name', test_name, 'node:22-slim', 'true']);
            const exists_output = exec_container(container_name, [
                'sh', '-c', `podman container exists ${test_name} && echo yes || echo no`,
            ]);
            expect(exists_output.trim()).toBe('yes');
        } finally {
            try {
                exec_container(container_name, ['podman', 'rm', '-f', test_name]);
            } catch { /* ignore */ }
        }
    });

    it('tests requiring podman can run inside the sandbox', (context) => {
        if (!host_podman_socket) {
            context.skip(HOST_PODMAN_SOCKET_SKIP_REASON);
        }

        const result = exec_container(container_name, [
            'sh', '-c',
            'podman info > /dev/null 2>&1 && echo PODMAN_OK || echo PODMAN_FAIL',
        ]);
        expect(result.trim()).toBe('PODMAN_OK');
    });

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

// Negative complement to the positive suite above. The positive tests prove
// that WHEN the caller asks for socket access (via `volume_mounts` +
// `environment_variables`), the resulting container can reach the host
// runtime. They do NOT prove that the socket / `CONTAINER_HOST` are absent
// when the caller does NOT ask for them — a regression that unconditionally
// mounted `/run/podman/podman.sock` regardless of caller options would pass
// the positive suite. This describe locks the off-by-default contract.
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
