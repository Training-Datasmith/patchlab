/**
 * End-to-end integration test for sandbox resource limits.
 *
 * Creates a real podman container through `patchlab create --memory 1g --cpus 1.0 --pids-limit 256`
 * and asserts via `podman inspect` that the container's `HostConfig` reports
 * those exact limits. Then resumes the sandbox without flags and verifies
 * the persisted-manifest precedence layer carries the create-time values
 * through to the resume container.
 *
 * Skipping policy (task 7.4): on hosts where podman can't enforce the
 * resource flags, `podman create --memory 1g` records `HostConfig.Memory: 0`
 * (podman accepts the argv but the kernel cgroup state doesn't allow
 * enforcement, so podman zeroes the field and prints "Resource limits are
 * not supported and ignored ..."). This is independent of patchlab's
 * `probe_cgroup_capabilities` — which runs on the Node *host* kernel, not
 * the podman-machine VM kernel. Direct detection: create one probe
 * container with `--memory 1g` and check whether podman recorded the limit.
 * If not, skip the inspect-based assertions. The manifest-persistence
 * assertions still run because they exercise patchlab's own state
 * regardless of kernel enforcement.
 *
 * Sequential-only: per `feedback_test_running`, patchlab's integration tests
 * share a single podman runtime. Vitest's integration project runs them
 * sequentially. This test creates a single sandbox and tears it down in
 * `afterAll`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { create_sandbox_from_directory } from '../test_helpers.js';
import { make_fake_prompter } from '../helpers/fake_prompter.js';

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { destroy_sandbox, resume_sandbox } from '../../src/sandbox/index.js';
import { build_image, PATCHLAB_TEST_LABEL, remove_test_images } from '../../src/images.js';
import { image_exists } from '../../src/podman.js';
import { DEFAULT_TEST_TOOL } from '../helpers/stub_tool_provider.js';
import { next_session_number, read_session_metadata } from '../../src/archive.js';
/**
 * Detect whether THIS host actually enforces resource limits via podman.
 *
 * The check runs `podman create --memory 1g`, inspects `HostConfig.Memory`,
 * and removes the probe container. On hosts with cgroups V1 rootless (or
 * any other configuration where podman zeroes the recorded limit), Memory
 * reads back as 0 even though the argv carried `--memory 1g`.
 *
 * This is more reliable than `probe_cgroup_capabilities()` because the
 * probe runs on the Node host kernel, but on macOS/Windows podman runs in
 * a separate VM whose kernel state the probe can't see.
 */
function detect_podman_enforces_limits(): boolean {
    const probe_name = `patchlab-resource-limit-probe-${Date.now()}`;
    try {
        execFileSync('podman', [
            'create', '--name', probe_name, '--memory', '1g', 'node:22-slim', 'sleep', 'infinity',
        ], { stdio: 'pipe' });
    } catch {
        return false;
    }

    try {
        const output = execFileSync(
            'podman', ['inspect', '--format', '{{.HostConfig.Memory}}', probe_name],
            { encoding: 'utf-8' },
        );
        return Number(output.trim()) === 1024 * 1024 * 1024;
    } catch {
        return false;
    } finally {
        try {
            execFileSync('podman', ['rm', '-f', probe_name], { stdio: 'pipe' });
        } catch {
            /* best-effort */
        }
    }
}

const TEST_TAG = 'patchlab/sandbox-resource-limits-test:latest';
const TEST_LABEL = `${PATCHLAB_TEST_LABEL}=true`;

interface Host_Config {
    Memory: number;
    NanoCpus: number;
    PidsLimit: number;
    BlkioWeight: number;
}

function inspect_host_config(container_name: string): Host_Config {
    const output = execFileSync(
        'podman',
        ['inspect', '--format', '{{json .HostConfig}}', container_name],
        { encoding: 'utf-8' },
    );
    return JSON.parse(output) as Host_Config;
}

function make_source_directory(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-resource-limits-'));
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

const cleanup: (() => void)[] = [];

beforeAll(async () => {
    if (!image_exists(TEST_TAG)) {
        await build_image({ tag: TEST_TAG, tools: [DEFAULT_TEST_TOOL], capabilities: [], labels: [TEST_LABEL] });
    }
}, 600_000);

afterAll(() => {
    for (const fn of cleanup.toReversed()) {
        try {
            fn();
        } catch {
            // best-effort
        }
    }
    remove_test_images();
});

describe('sandbox resource limits applied to podman container', () => {
    let source_directory: string;
    let sandbox_id: string;
    let create_container_name: string;
    let limits_enforced: boolean;

    beforeAll(() => {
        limits_enforced = detect_podman_enforces_limits();
    });

    it('create applies --memory, --cpus, --pids-limit, --blkio-weight via podman flags', async () => {
        source_directory = make_source_directory();
        cleanup.push(() => fs.rmSync(source_directory, { recursive: true, force: true }));

        const manifest = await create_sandbox_from_directory(source_directory, {
            image: TEST_TAG,
            no_install: true,
            cli_resource_overrides: {
                memory_limit: '1g',
                cpu_limit: '1.0',
                pids_limit: 256,
                blkio_weight: 500,
            },
        });
        sandbox_id = manifest.id;
        create_container_name = manifest.container_name;
        cleanup.push(() => {
            (async () => {
                try {
                    await destroy_sandbox(sandbox_id, { force: true });
                } catch {
                    // ignore
                }
            })();
        });

        if (!limits_enforced) {
            // The kernel can't enforce the flags on this host (rootless cgroup
            // delegation missing). podman accepted the argv but HostConfig
            // reports the flags as 0. Skip the inspect-based assertions —
            // they'd be testing the host's cgroup config, not patchlab's code.
            // The manifest-persistence test below still exercises patchlab's
            // own state and is the real coverage for the resolver path.
            return;
        }

        const host = inspect_host_config(create_container_name);
        expect(host.Memory).toBe(1024 * 1024 * 1024);
        // podman converts --cpus to NanoCpus: cpus * 1e9.
        expect(host.NanoCpus).toBe(1_000_000_000);
        expect(host.PidsLimit).toBe(256);
        // blkio_weight reaches `HostConfig.BlkioWeight` from the CLI argv.
        // The other three fields are well-covered by the lines above; this
        // assertion locks the fourth so a regression dropping blkio from
        // the runtime argv does not silently pass.
        expect(host.BlkioWeight).toBe(500);
    }, 600_000);

    it('manifest persists resolved resource limits after create', () => {
        const session_number = next_session_number(sandbox_id) - 1;
        const metadata = read_session_metadata(sandbox_id, session_number);
        expect(metadata?.resource_limits).toEqual({
            memory: '1g',
            cpus: '1.0',
            pids: 256,
            blkio_weight: 500,
        });
    });

    it('resume without flags inherits persisted limits via the manifest layer', async () => {
        const resumed = await resume_sandbox(sandbox_id, {
            no_install: true,
            // The previous create's container is still running; explicitly opt
            // into replacing it for the resume.
            prompter: make_fake_prompter({ confirm: () => true }),
        });
        const resume_container = resumed.container_name;

        if (!limits_enforced) {
            return;
        }

        const host = inspect_host_config(resume_container);
        expect(host.Memory).toBe(1024 * 1024 * 1024);
        expect(host.NanoCpus).toBe(1_000_000_000);
        expect(host.PidsLimit).toBe(256);
        // blkio_weight inherits from the manifest layer too.
        expect(host.BlkioWeight).toBe(500);
    }, 600_000);

    it('resume writes resolved limits to the new session metadata', () => {
        const session_number = next_session_number(sandbox_id) - 1;
        const metadata = read_session_metadata(sandbox_id, session_number);
        expect(metadata?.resource_limits).toEqual({
            memory: '1g',
            cpus: '1.0',
            pids: 256,
            blkio_weight: 500,
        });
    });

    it('resume CLI overrides win over the manifest layer (precedence: CLI > manifest)', async () => {
        // The previous resume test proves manifest values flow through when
        // no CLI flag is supplied. The complement: when a CLI flag IS
        // supplied at resume, it MUST win — the documented precedence is
        // CLI > manifest > user-global > runtime defaults. A bug where
        // `resume_sandbox` ignored the CLI layer in favor of the manifest
        // (or vice-versa) would not be caught by the prior tests because
        // they don't put the two layers in conflict.
        const resumed_again = await resume_sandbox(sandbox_id, {
            no_install: true,
            prompter: make_fake_prompter({ confirm: () => true }),
            cli_resource_overrides: {
                memory_limit: '2g',  // conflicts with manifest's 1g
                pids_limit: 1024,     // conflicts with manifest's 256
            },
        });
        cleanup.push(() => {
            (async () => {
                try {
                    await destroy_sandbox(resumed_again.id, { force: true });
                } catch {
                    // ignore
                }
            })();
        });

        if (!limits_enforced) {
            return;
        }

        const host = inspect_host_config(resumed_again.container_name);
        // CLI-overridden fields take the CLI value, not the manifest's.
        expect(host.Memory).toBe(2 * 1024 * 1024 * 1024);
        expect(host.PidsLimit).toBe(1024);
        // Fields NOT supplied via CLI inherit from the manifest (1.0 cpus,
        // 500 blkio_weight). Locks the per-field precedence: the CLI layer
        // is partial; only the supplied fields override.
        expect(host.NanoCpus).toBe(1_000_000_000);
        expect(host.BlkioWeight).toBe(500);

        // The newly-resumed session's metadata records the resolved values
        // (per-field winners), not the raw manifest layer.
        const new_session_number = next_session_number(resumed_again.id) - 1;
        const new_metadata = read_session_metadata(resumed_again.id, new_session_number);
        expect(new_metadata?.resource_limits?.memory).toBe('2g');
        expect(new_metadata?.resource_limits?.pids).toBe(1024);
        expect(new_metadata?.resource_limits?.cpus).toBe('1.0');
        expect(new_metadata?.resource_limits?.blkio_weight).toBe(500);
    }, 600_000);
});
