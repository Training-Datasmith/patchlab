import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** XDG-aware host paths for OpenCode configuration and credentials. */
export function host_opencode_configuration_directory(): string {
    const xdg = process.env.XDG_CONFIG_HOME;

    return ((xdg === undefined) || (xdg === ''))
        ? path.join(os.homedir(), '.config', 'opencode')
        : path.join(xdg, 'opencode');
}

export function host_opencode_data_directory(): string {
    const xdg = process.env.XDG_DATA_HOME;

    return ((xdg === undefined) || (xdg === ''))
        ? path.join(os.homedir(), '.local', 'share', 'opencode')
        : path.join(xdg, 'opencode');
}

export function host_opencode_auth_path(): string {
    return path.join(host_opencode_data_directory(), 'auth.json');
}

export function container_opencode_configuration_directory(image_home: string): string {
    return path.join(image_home, '.config', 'opencode');
}

export function container_opencode_data_directory(image_home: string): string {
    return path.join(image_home, '.local', 'share', 'opencode');
}

export function container_opencode_project_directory(image_home: string): string {
    return path.join(container_opencode_data_directory(image_home), 'project');
}

export function path_exists_as_file_or_directory(target: string): boolean {
    try {
        fs.lstatSync(target);
        return true;
    } catch {
        return false;
    }
}
