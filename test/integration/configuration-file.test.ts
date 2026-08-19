/**
 * End-to-end integration coverage for `<source>/.patchlab/configuration.yaml`
 * and `${PATCHLAB_HOME}/.patchlab/configuration.yaml` (the user-global file).
 *
 * Strategy: create one tempdir to host PATCHLAB_HOME, one to host the source
 * directory. Write the user-global configuration file under the redirected
 * PATCHLAB_HOME tree — never under the developer's real `~/.patchlab/` — and
 * the per-source file under the source tempdir. Call `create_sandbox`
 * directly (no CLI subprocess) so the resolver's verbose-log emissions can be
 * captured via a RecordingLogger if needed. Verify the resulting podman
 * container's `HostConfig` matches the resolved values via `podman inspect`.
 *
 * Skipping policy (consistent with sandbox-resource-limits.test.ts): when the
 * host's kernel can't enforce resource limits (Windows/macOS rootless WSL
 * cgroups v1, etc.), `podman create --memory <X>` accepts the argv but
 * records `HostConfig.Memory: 0`. Detect this by creating one probe container
 * with `--memory 1g` and inspecting HostConfig.Memory; skip the inspect-based
 * assertions when the host doesn't enforce. The manifest-persistence
 * assertion (Session_Metadata.resource_limits) still runs because it
 * exercises patchlab's own state and is independent of kernel enforcement.
 *
 * Sequential-only: per `feedback_test_running`, patchlab's integration tests
 * share a single podman runtime. Vitest's integration project runs them
 * sequentially. This test creates a single sandbox per scenario and tears
 * each down in `afterAll`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { create_sandbox_from_directory } from '../test_helpers.js';

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build_image, PATCHLAB_TEST_LABEL, remove_test_images } from '../../src/images.js';
import { image_exists } from '../../src/container_runtime.js';
import { DEFAULT_TEST_TOOL } from '../helpers/stub_tool_provider.js';
import { next_session_number, read_session_metadata } from '../../src/archive.js';
import {
    load_configuration,
    user_global_configuration_path,
    per_source_configuration_path,
} from '../../src/configuration.js';
import { detect_runtime_enforces_limits, inspect_host_config } from '../helpers/exec_runtime_cli.js';
import {
    create_integration_cleanup_registry,
    register_destroy_sandbox,
} from '../helpers/integration_cleanup.js';

const TEST_TAG = 'patchlab/configuration-file-test:latest';
const TEST_LABEL = `${PATCHLAB_TEST_LABEL}=true`;

interface Host_Config {
    Memory: number;
    NanoCpus: number | undefined;
    PidsLimit: number;
}

function read_host_config(container_name: string): Host_Config {
    return inspect_host_config(container_name);
}

function make_source_directory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-configuration-file-source-'));
    execFileSync('git', ['init'], { cwd: directory });
    fs.writeFileSync(path.join(directory, 'README.md'), '# test\n');
    execFileSync('git', ['add', '-A'], { cwd: directory });
    execFileSync('git', ['commit', '-m', 'initial', '--allow-empty'], {
        cwd: directory,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test',
            GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test',
        },
    });
    return directory;
}

function write_user_global_configuration(yaml: string): void {
    const file_path = user_global_configuration_path();
    fs.mkdirSync(path.dirname(file_path), { recursive: true });
    fs.writeFileSync(file_path, yaml);
}

function write_per_source_configuration(source_directory: string, yaml: string): void {
    const file_path = per_source_configuration_path(source_directory);
    fs.mkdirSync(path.dirname(file_path), { recursive: true });
    fs.writeFileSync(file_path, yaml);
}

let patchlab_home: string;
let original_patchlab_home: string | undefined;
let limits_enforced: boolean;
const cleanup = create_integration_cleanup_registry();

beforeAll(async () => {
    patchlab_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-configuration-file-home-'));
    original_patchlab_home = process.env.PATCHLAB_HOME;
    process.env.PATCHLAB_HOME = patchlab_home;
    limits_enforced = detect_runtime_enforces_limits();
    if (!image_exists(TEST_TAG)) {
        await build_image({ tag: TEST_TAG, tools: [DEFAULT_TEST_TOOL], capabilities: [], labels: [TEST_LABEL] });
    }
}, 600_000);

afterAll(async () => {
    await cleanup.run_all();
    if (original_patchlab_home === undefined) {
        delete process.env.PATCHLAB_HOME;
    } else {
        process.env.PATCHLAB_HOME = original_patchlab_home;
    }
    if (patchlab_home !== '') {
        fs.rmSync(patchlab_home, { recursive: true, force: true });
    }
    remove_test_images();
});

describe('user-global configuration applied to a real sandbox', () => {
    let source_directory: string;
    let sandbox_id: string;
    let container_name: string;

    it('user-global memory + cpus configuration produces matching podman flags', async () => {
        source_directory = make_source_directory();
        cleanup.register(() => fs.rmSync(source_directory, { recursive: true, force: true }));

        write_user_global_configuration(
            'resource_limits:\n'
            + '  memory: "1g"\n'
            + '  cpus: 1.0\n',
        );

        // create_sandbox does NOT load configuration itself — the CLI is
        // supposed to. Mirror cli.ts's wiring by calling load_configuration
        // here and passing the result through `loaded_configuration`.
        const loaded_configuration = load_configuration([source_directory]);
        const manifest = await create_sandbox_from_directory(source_directory, {
            image: TEST_TAG,
            no_install: true,
            loaded_configuration,
        });
        sandbox_id = manifest.id;
        container_name = manifest.container_name;
        register_destroy_sandbox(cleanup, sandbox_id);

        if (!limits_enforced) {
            return;
        }

        const host = read_host_config(container_name);
        expect(host.Memory).toBe(1024 * 1024 * 1024);
        expect(host.NanoCpus).toBe(1_000_000_000);
        // pids was not set anywhere; the resolver falls through to the
        // runtime default (1024).
        expect(host.PidsLimit).toBe(1024);
    }, 600_000);

    it('manifest persists the resolved user-global limits', () => {
        const session_number = next_session_number(sandbox_id) - 1;
        const metadata = read_session_metadata(sandbox_id, session_number);
        expect(metadata?.resource_limits?.memory).toBe('1g');
        expect(metadata?.resource_limits?.cpus).toBe('1.0');
        expect(metadata?.resource_limits?.blkio_weight).toBeNull();
    });

    it('user-global pids configuration reaches HostConfig.PidsLimit', async () => {
        // The two prior tests in this describe block prove memory and cpus
        // flow from the YAML through to podman's `HostConfig`. They do NOT
        // prove pids does — both default to a runtime-derived value (1024)
        // when the YAML omits it, so a regression where the resolver silently
        // drops the `pids` field for the YAML path would pass them both.
        // This test sets a non-default `pids` value in the YAML and asserts
        // HostConfig.PidsLimit matches.
        const local_source_directory = make_source_directory();
        cleanup.register(() => fs.rmSync(local_source_directory, { recursive: true, force: true }));

        write_user_global_configuration(
            'resource_limits:\n'
            + '  memory: "1g"\n'
            + '  cpus: 1.0\n'
            + '  pids: 512\n',
        );

        const loaded_configuration = load_configuration([local_source_directory]);
        const manifest = await create_sandbox_from_directory(local_source_directory, {
            image: TEST_TAG,
            no_install: true,
            loaded_configuration,
        });
        const local_sandbox_id = manifest.id;
        register_destroy_sandbox(cleanup, local_sandbox_id);

        if (!limits_enforced) {
            return;
        }

        const host = read_host_config(manifest.container_name);
        expect(host.PidsLimit).toBe(512);

        // Belt-and-suspenders: the manifest also records the pids value, so
        // the on-disk persistence path is verified alongside the runtime one.
        const session_number = next_session_number(local_sandbox_id) - 1;
        const metadata = read_session_metadata(local_sandbox_id, session_number);
        expect(metadata?.resource_limits?.pids).toBe(512);
    }, 600_000);
});

describe('per-source configuration is clamped against user-global', () => {
    let source_directory: string;
    let sandbox_id: string;
    let container_name: string;

    it('per-source memory: 8g vs user-global memory: 1g → effective 1g', async () => {
        source_directory = make_source_directory();
        cleanup.register(() => fs.rmSync(source_directory, { recursive: true, force: true }));

        // Re-write the user-global file (the previous suite shared this
        // tempdir but the values are the same — explicitly write here for
        // clarity).
        write_user_global_configuration('resource_limits:\n  memory: "1g"\n');

        write_per_source_configuration(
            source_directory,
            'resource_limits:\n  memory: "8g"\n',  // would raise; gets clamped
        );

        const loaded_configuration = load_configuration([source_directory]);
        const manifest = await create_sandbox_from_directory(source_directory, {
            image: TEST_TAG,
            no_install: true,
            // Writing `<source>/.patchlab/configuration.yaml` dirties the
            // working tree; the per-source file is a configuration artifact,
            // not source. Allow the baseline-commit path to capture it.
            allow_dirty_tree: true,
            loaded_configuration,
        });
        sandbox_id = manifest.id;
        container_name = manifest.container_name;
        register_destroy_sandbox(cleanup, sandbox_id);

        if (!limits_enforced) {
            return;
        }

        const host = read_host_config(container_name);
        // Per-source 8g was CLAMPED to the user-global 1g upper bound.
        expect(host.Memory).toBe(1024 * 1024 * 1024);
    }, 600_000);

    it('manifest persists the clamped (not raised) value', () => {
        const session_number = next_session_number(sandbox_id) - 1;
        const metadata = read_session_metadata(sandbox_id, session_number);
        // The persisted value is the CLAMPED 1g, not the per-source 8g.
        expect(metadata?.resource_limits?.memory).toBe('1g');
    });

    it('per-source memory LOWER than user-global is honored as-is (not raised to user-global)', async () => {
        // The clamping test above proves user-global is an upper bound. A
        // buggy "always pick user-global" resolver would also pass that
        // test. This test pins the other half of the precedence contract:
        // when per-source is BELOW user-global, the resolver SHALL keep the
        // per-source value, not raise it.
        const local_source_directory = make_source_directory();
        cleanup.register(() => fs.rmSync(local_source_directory, { recursive: true, force: true }));

        write_user_global_configuration('resource_limits:\n  memory: "1g"\n');
        write_per_source_configuration(
            local_source_directory,
            'resource_limits:\n  memory: "512m"\n',  // below user-global; must be honored
        );

        const loaded_configuration = load_configuration([local_source_directory]);
        const manifest = await create_sandbox_from_directory(local_source_directory, {
            image: TEST_TAG,
            no_install: true,
            allow_dirty_tree: true,
            loaded_configuration,
        });
        const local_sandbox_id = manifest.id;
        register_destroy_sandbox(cleanup, local_sandbox_id);

        if (!limits_enforced) {
            return;
        }

        const host = read_host_config(manifest.container_name);
        // 512 MiB, not raised to 1 GiB.
        expect(host.Memory).toBe(512 * 1024 * 1024);

        // Manifest also records the honored per-source value (512m), not 1g.
        const session_number = next_session_number(local_sandbox_id) - 1;
        const metadata = read_session_metadata(local_sandbox_id, session_number);
        expect(metadata?.resource_limits?.memory).toBe('512m');
    }, 600_000);
});
