import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const NERDCTL_CANDIDATES = ['nerdctl.lima', 'nerdctl'] as const;

/**
 * The home directory Lima virtiofs mounts into the VM. Tests redirect
 * `process.env.HOME` to a tempdir under `/var/folders` for archive
 * isolation, but Lima always mounts the real `/Users/<user>` — staging
 * paths for nerdctl cp must live there, not under the redirected HOME.
 */
export function real_user_home(): string {
    if (process.platform === 'darwin') {
        const user = process.env.USER ?? process.env.LOGNAME;
        if (user) {
            return `/Users/${user}`;
        }
    }

    return os.homedir();
}

function find_executable_on_path(name: string): boolean {
    const path_directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    for (const directory of path_directories) {
        try {
            fs.accessSync(path.join(directory, name), fs.constants.X_OK);
            return true;
        } catch (_not_executable) {
            /* try next PATH entry */
        }
    }

    return false;
}

function nerdctl_binary_available(): boolean {
    return NERDCTL_CANDIDATES.some((candidate) => find_executable_on_path(candidate));
}

function nerdctl_would_be_selected_on_darwin(): boolean {
    if (process.platform !== 'darwin') {
        return false;
    }

    const runtime_from_env = process.env.PATCHLAB_CONTAINER_RUNTIME?.toLowerCase();
    if (runtime_from_env === 'podman') {
        return false;
    }
    if (runtime_from_env === 'nerdctl') {
        return true;
    }

    return nerdctl_binary_available();
}

export function nerdctl_active_on_darwin(): boolean {
    return nerdctl_would_be_selected_on_darwin();
}

/**
 * Host temp directory for files the container runtime reads from the host
 * (env files, staging trees, build contexts, archive tarballs). Lima mounts
 * only the user's home directory into the VM; macOS `os.tmpdir()` under
 * `/var/folders` is invisible to nerdctl.
 */
export function runtime_host_tmpdir(): string {
    if (nerdctl_would_be_selected_on_darwin()) {
        const directory = path.join(real_user_home(), '.patchlab', 'tmp');
        fs.mkdirSync(directory, { recursive: true });
        return directory;
    }

    return os.tmpdir();
}

/** Whether a host path is readable inside the Lima VM (virtiofs home mount). */
export function is_lima_mounted_host_path(host_path: string): boolean {
    const resolved = path.resolve(host_path);
    const home = path.resolve(real_user_home());
    const relative = path.relative(home, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
