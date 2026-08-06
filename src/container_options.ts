import { split_mount } from './overrides_merge.js';
import type { Detected_Requirements } from './detect/index.js';

export function build_volume_mounts(merged: Detected_Requirements, socket_approved: boolean): string[] {
    const mounts: string[] = [];
    for (const m of merged.volume_mounts) {
        const is_socket = m.host_path.includes('podman.sock') || m.host_path.includes('docker.sock');
        if (is_socket && !socket_approved) {
            continue;
        }

        mounts.push(`${m.host_path}:${m.container_path}`);
    }

    return mounts;
}

export function build_environment_variables(merged: Detected_Requirements, volume_mounts: string[], socket_approved: boolean): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const environment_variable of merged.environment_variables) {
        environment[environment_variable.key] = environment_variable.value;
    }

    if (socket_approved) {
        const podman_socket_mount = volume_mounts.find((m) => m.includes('podman.sock'));
        if (podman_socket_mount) {
            environment['CONTAINER_HOST'] = `unix://${split_mount(podman_socket_mount)[1]}`;
        }

        const docker_socket_mount = volume_mounts.find((m) => m.includes('docker.sock'));
        if (docker_socket_mount) {
            environment['DOCKER_HOST'] = `unix://${split_mount(docker_socket_mount)[1]}`;
        }
    }

    return environment;
}
