/**
 * End-to-end coverage for detect → resolve_socket_mount → build_volume_mounts /
 * build_environment_variables → podman create. Unlike sandbox-podman.test.ts,
 * this file does NOT pre-supply volume_mounts or CONTAINER_HOST — the
 * production detection and approval pipeline must produce them.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { create_sandbox_from_directory } from '../test_helpers.js';
import { DEFAULT_IMAGE } from '../../src/container_runtime.js';
import { resolve_podman_socket_path } from '../../src/detect/index.js';
import { exec_runtime_cli } from '../helpers/exec_runtime_cli.js';
import {
    create_integration_cleanup_registry,
    register_destroy_sandbox,
} from '../helpers/integration_cleanup.js';

const GIT_ENVIRONMENT = {
    ...process.env,
    GIT_AUTHOR_NAME: 'patchlab-test',
    GIT_AUTHOR_EMAIL: 'test@patchlab.local',
    GIT_COMMITTER_NAME: 'patchlab-test',
    GIT_COMMITTER_EMAIL: 'test@patchlab.local',
};

interface Container_Mount {
    Source: string;
    Destination: string;
}

function inspect_mounts(container_name: string): Container_Mount[] {
    const output = exec_runtime_cli(
        ['inspect', '--format', '{{json .Mounts}}', container_name],
        { encoding: 'utf-8' },
    );
    return JSON.parse(String(output).trim()) as Container_Mount[];
}

function inspect_environment(container_name: string): string[] {
    const output = exec_runtime_cli(
        ['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', container_name],
        { encoding: 'utf-8' },
    );
    return String(output).trim().split('\n').filter((line) => line.length > 0);
}

function build_podman_detecting_repository(): string {
    const source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-detect-socket-src-'));
    execFileSync('git', ['init'], { cwd: source_directory, env: GIT_ENVIRONMENT });
    fs.mkdirSync(path.join(source_directory, 'src'), { recursive: true });
    fs.writeFileSync(
        path.join(source_directory, 'src', 'runner.ts'),
        "import { execFileSync } from 'node:child_process';\nexecFileSync('podman', ['info']);\n",
    );
    execFileSync('git', ['add', '-A'], { cwd: source_directory, env: GIT_ENVIRONMENT });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: source_directory, env: GIT_ENVIRONMENT });
    return source_directory;
}

describe('detect → provisioning socket pipeline', () => {
    const cleanup = create_integration_cleanup_registry();

    afterAll(async () => {
        await cleanup.run_all();
    });

    it('mounts the detected podman socket and sets CONTAINER_HOST when allow_socket_mount is true', async () => {
        const source_directory = build_podman_detecting_repository();
        cleanup.register(() => fs.rmSync(source_directory, { recursive: true, force: true }));

        const expected_socket = resolve_podman_socket_path();
        const manifest = await create_sandbox_from_directory(source_directory, {
            // Non-patchlab base: set_up_image_tier installs git before baseline init.
            image: DEFAULT_IMAGE,
            no_install: true,
            allow_socket_mount: true,
        });
        register_destroy_sandbox(cleanup, manifest.id);

        const mounts = inspect_mounts(manifest.container_name);
        const socket_mount = mounts.find((mount) => mount.Destination === '/run/podman/podman.sock');
        expect(socket_mount).toBeDefined();
        expect(socket_mount?.Source.replaceAll('\\', '/')).toBe(expected_socket.replaceAll('\\', '/'));

        const environment = inspect_environment(manifest.container_name);
        expect(environment).toContain('CONTAINER_HOST=unix:///run/podman/podman.sock');
    });

    it('omits the socket mount when socket approval is not granted', async () => {
        const source_directory = build_podman_detecting_repository();
        cleanup.register(() => fs.rmSync(source_directory, { recursive: true, force: true }));

        const manifest = await create_sandbox_from_directory(source_directory, {
            image: DEFAULT_IMAGE,
            no_install: true,
            deny_socket_mount: true,
        });
        register_destroy_sandbox(cleanup, manifest.id);

        const mounts = inspect_mounts(manifest.container_name);
        expect(mounts.some((mount) => mount.Destination === '/run/podman/podman.sock')).toBe(false);

        const environment = inspect_environment(manifest.container_name);
        expect(environment.some((entry) => entry.startsWith('CONTAINER_HOST='))).toBe(false);
    });
});
