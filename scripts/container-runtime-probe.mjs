import { spawnSync } from 'node:child_process';

function binary_responds(binary) {
    const result = spawnSync(binary, ['--version'], { stdio: 'pipe' });
    return result.status === 0;
}

/** True when `podman --version` succeeds on the host. */
export function is_podman_available() {
    return binary_responds('podman');
}

/** True on macOS when nerdctl.lima or nerdctl responds — matches `nerdctl_runtime.is_available()`. */
export function is_nerdctl_available() {
    if (process.platform !== 'darwin') {
        return false;
    }

    return binary_responds('nerdctl.lima') || binary_responds('nerdctl');
}

/** Primary runtime for runtime-agnostic integration tests (nerdctl before podman on macOS). */
export function pick_integration_runtime() {
    if (is_nerdctl_available()) {
        return 'nerdctl';
    }

    if (is_podman_available()) {
        return 'podman';
    }

    return null;
}
