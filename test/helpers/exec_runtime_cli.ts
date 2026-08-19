import { execFileSync } from 'node:child_process';
import { get_runtime_binary, read_image_labels } from '../../src/container_runtime.js';

/** Run a host-side container-runtime CLI command (podman, nerdctl, etc.). */
export function exec_runtime_cli(
    args: string[],
    options?: Parameters<typeof execFileSync>[2],
): Buffer | string {
    return execFileSync(get_runtime_binary(), args, options);
}

/** Read labels from a local image via the active runtime's inspect format. */
export function inspect_image_labels(image: string): Record<string, string> {
    return read_image_labels(image);
}

interface Raw_Host_Config {
    Memory?: number;
    NanoCpus?: number;
    CpuQuota?: number;
    CpuPeriod?: number;
    PidsLimit?: number;
    BlkioWeight?: number;
}

/** Normalized inspect view shared by podman (NanoCpus) and nerdctl (CpuQuota/CpuPeriod). */
export interface Inspected_Host_Config {
    Memory: number;
    NanoCpus: number | undefined;
    PidsLimit: number;
    BlkioWeight: number;
}

export function normalize_host_config(raw: Raw_Host_Config): Inspected_Host_Config {
    let nano_cpus = raw.NanoCpus;
    if (nano_cpus === undefined && raw.CpuQuota !== undefined && raw.CpuPeriod) {
        nano_cpus = Math.round((raw.CpuQuota / raw.CpuPeriod) * 1_000_000_000);
    }

    return {
        Memory: raw.Memory ?? 0,
        NanoCpus: nano_cpus,
        PidsLimit: raw.PidsLimit ?? 0,
        BlkioWeight: raw.BlkioWeight ?? 0,
    };
}

export function inspect_host_config(container_name: string): Inspected_Host_Config {
    const output = exec_runtime_cli(
        ['inspect', '--format', '{{json .HostConfig}}', container_name],
        { encoding: 'utf-8' },
    );
    return normalize_host_config(JSON.parse(String(output)) as Raw_Host_Config);
}

/**
 * Probe whether the active container runtime records enforced memory limits
 * on THIS host. When the kernel cannot enforce cgroups, create accepts
 * `--memory 1g` but inspect reports `HostConfig.Memory: 0`.
 */
export function detect_runtime_enforces_limits(): boolean {
    const probe_name = `patchlab-resource-limit-probe-${Date.now()}`;
    try {
        exec_runtime_cli([
            'create', '--name', probe_name, '--memory', '1g', 'node:22-slim', 'sleep', 'infinity',
        ], { stdio: 'pipe' });
    } catch {
        return false;
    }

    try {
        const output = exec_runtime_cli(
            ['inspect', '--format', '{{.HostConfig.Memory}}', probe_name],
            { encoding: 'utf-8' },
        );
        return Number(String(output).trim()) === 1024 * 1024 * 1024;
    } catch {
        return false;
    } finally {
        try {
            exec_runtime_cli(['rm', '-f', probe_name], { stdio: 'pipe' });
        } catch {
            /* best-effort */
        }
    }
}
