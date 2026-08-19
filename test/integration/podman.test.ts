import { describe, it, expect, afterEach } from 'vitest';
import { TEST_CONTAINER_WORKING_DIR } from '../test_helpers.js';
import {
    create_container,
    start_container,
    stop_container,
    remove_container,
    exec_container,
    copy_to_container,
    container_exists,
    container_running,
    image_exists,
    install_package,
    DEFAULT_IMAGE,
    query_running_containers,
} from '../../src/container_runtime.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { exec_runtime_cli } from '../helpers/exec_runtime_cli.js';

describe('podman wrapper', () => {
    const containers: string[] = [];

    function test_name(): string {
        const name = `patchlab-test-${crypto.randomUUID().slice(0, 8)}`;
        containers.push(name);
        return name;
    }

    afterEach(() => {
        for (const name of containers) {
            try {
                remove_container(name);
            } catch {
                // ignore
            }
        }
        containers.length = 0;
    });

    it('creates and starts a container', () => {
        const name = test_name();
        create_container(name, DEFAULT_IMAGE);
        expect(container_exists(name)).toBe(true);
        expect(container_running(name)).toBe(false);

        start_container(name);
        expect(container_running(name)).toBe(true);
    });

    it('executes commands inside a container', () => {
        const name = test_name();
        create_container(name, DEFAULT_IMAGE);
        start_container(name);

        const output = exec_container(name, ['echo', 'hello']);
        expect(output.trim()).toBe('hello');
    });

    it('executes commands with working directory', () => {
        const name = test_name();
        create_container(name, DEFAULT_IMAGE);
        start_container(name);

        exec_container(name, ['mkdir', '-p', '/testdir']);
        const output = exec_container(name, ['pwd'], { cwd: '/testdir' });
        expect(output.trim()).toBe('/testdir');
    });

    it('copies files to container', () => {
        const name = test_name();
        create_container(name, DEFAULT_IMAGE);
        start_container(name);

        const temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cp-'));
        try {
            fs.writeFileSync(path.join(temp_dir, 'test.txt'), 'hello from host\n');
            exec_container(name, ['mkdir', '-p', TEST_CONTAINER_WORKING_DIR]);
            copy_to_container(name, temp_dir + '/.', TEST_CONTAINER_WORKING_DIR);

            const content = exec_container(name, ['cat', `${TEST_CONTAINER_WORKING_DIR}/test.txt`]);
            expect(content.trim()).toBe('hello from host');
        } finally {
            fs.rmSync(temp_dir, { recursive: true, force: true });
        }
    });

    it('copy_to_container forwards a host file path unchanged (no trailing slash, no dot)', () => {
        // The trailing-`.` form above tests the "copy directory contents
        // into existing target" semantics. Multiple production callers in
        // gemini_cli_oauth.ts uses the file-to-file form (single host file → specific container
        // destination, no trailing slash, no dot). Lock the contract: the
        // wrapper passes the host_path BYTE-FOR-BYTE to `podman cp`. A
        // regression that normalized or reinterpreted the argument shape
        // would break those callers without surfacing here previously.
        const name = test_name();
        create_container(name, DEFAULT_IMAGE);
        start_container(name);

        const temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cp-file-'));
        try {
            const host_file = path.join(temp_dir, 'single.txt');
            fs.writeFileSync(host_file, 'single file payload\n');
            exec_container(name, ['mkdir', '-p', TEST_CONTAINER_WORKING_DIR]);
            // File-to-file form: no trailing slash, no `/.`.
            copy_to_container(name, host_file, `${TEST_CONTAINER_WORKING_DIR}/destination.txt`);

            const content = exec_container(name, ['cat', `${TEST_CONTAINER_WORKING_DIR}/destination.txt`]);
            expect(content.trim()).toBe('single file payload');
        } finally {
            fs.rmSync(temp_dir, { recursive: true, force: true });
        }
    });

    it('stops and removes containers', () => {
        const name = test_name();
        create_container(name, DEFAULT_IMAGE);
        start_container(name);
        expect(container_running(name)).toBe(true);

        stop_container(name);
        expect(container_running(name)).toBe(false);
        expect(container_exists(name)).toBe(true);

        remove_container(name);
        expect(container_exists(name)).toBe(false);
    });

    it('create_container honors its image argument (not just DEFAULT_IMAGE)', () => {
        // All other tests in this file pass DEFAULT_IMAGE — a regression that
        // made create_container ignore its `image` argument and always reach
        // for the default would leave the rest of the suite green. Tag the
        // default image under a deliberately-different name so we can prove
        // the argument actually reaches `podman create`.
        const probe_tag = 'patchlab/image-arg-test:probe';
        exec_runtime_cli(['tag', DEFAULT_IMAGE, probe_tag], { stdio: 'pipe' });
        try {
            const name = test_name();
            create_container(name, probe_tag);
            const config_image = exec_runtime_cli(
                ['inspect', name, '--format', '{{.Config.Image}}'],
                { stdio: 'pipe' },
            ).toString('utf-8').trim();
            expect(config_image).toContain('image-arg-test');
        } finally {
            try {
                exec_runtime_cli(['rmi', probe_tag], { stdio: 'pipe' });
            } catch {
                // ignore
            }
        }
    });

    it('installs packages inside container', () => {
        const name = test_name();
        create_container(name, DEFAULT_IMAGE);
        start_container(name);

        install_package(name, 'git');
        const output = exec_container(name, ['git', '--version']);
        expect(output).toContain('git version');
    });

    it('install_package short-circuits via dpkg -s when the package is already present (fast-path)', () => {
        // `install_package` runs `dpkg -s <name> || (apt-get update && apt-get install ...)`.
        // A regression that dropped the short-circuit (so `apt-get update`
        // ran every time) would silently bloat every repeat-install path
        // by ~5 seconds and re-fetch apt indexes the user didn't ask for.
        // We catch that here by comparing the mtime of
        // `/var/lib/apt/lists/lock` (created on first `apt-get update` and
        // re-touched on every subsequent update; verified unchanged by
        // `apt-get install` in this image) before and after a redundant
        // install_package call: if the short-circuit fired, the lock's
        // mtime is unchanged.
        //
        // Notes on sentinel choice: `/var/cache/apt/pkgcache.bin` (an older
        // sentinel) is NOT created on Debian Bookworm Slim (`node:22-slim`)
        // even after `apt-get update`. `/var/lib/apt/lists/lock` is the
        // current canonical signal — created by `apt-get update`, untouched
        // by `apt-get install -y --no-install-recommends <pkg>`.
        const name = test_name();
        create_container(name, DEFAULT_IMAGE);
        start_container(name);

        install_package(name, 'git');

        const apt_update_marker = '/var/lib/apt/lists/lock';
        const mtime_before = exec_container(
            name,
            ['stat', '-c', '%Y', apt_update_marker],
        ).trim();

        // Second call: git is already installed, so `dpkg -s git` exits 0
        // and the right-hand side of the `||` is skipped entirely.
        install_package(name, 'git');

        const mtime_after = exec_container(
            name,
            ['stat', '-c', '%Y', apt_update_marker],
        ).trim();
        expect(mtime_after).toBe(mtime_before);
    });

    it('query_running_containers reports a running container by name', () => {
        const name = test_name();
        create_container(name, DEFAULT_IMAGE);
        start_container(name);

        const running = query_running_containers();
        const found = running.find((entry) => entry.name === name);
        expect(found).toBeDefined();
        // Image string varies (registry prefix / digest); just assert it's non-empty.
        expect(found?.image).toBeTruthy();
    });

    it('query_running_containers omits stopped containers', () => {
        const name = test_name();
        create_container(name, DEFAULT_IMAGE);
        start_container(name);
        stop_container(name);

        const running = query_running_containers();
        expect(running.some((entry) => entry.name === name)).toBe(false);
    });
});

// Pure-query negative probes — these need podman on PATH and ensure_podman()
// to have run, but they create no containers and don't conflict with each
// other. Grouped here to document that intent and keep the lifecycle-mutating
// suite above focused.
describe('podman wrapper: pure-query negative probes', () => {
    it('container_exists and container_running return false for a name that does not exist', () => {
        expect(container_exists('nonexistent-container-xyz')).toBe(false);
        expect(container_running('nonexistent-container-xyz')).toBe(false);
    });

    it('image_exists returns true for the default image and false for a tag that does not exist', () => {
        expect(image_exists(DEFAULT_IMAGE)).toBe(true);
        expect(image_exists('nonexistent-image:xyz')).toBe(false);
    });
});
