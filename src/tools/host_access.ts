/**
 * Optional host-side setup that a tool provider runs before container create.
 * Providers may start proxies, stage files, and inject extra container env vars.
 */
import type { Loaded_Configuration } from '../configuration.js';

/** Hostname containers use to reach loopback services on the host. */
export const HOST_PATCHLAB_INTERNAL = 'host.patchlab.internal';

export interface Host_File_Copy {
    host_path: string;
    container_path: string;
}

export interface Host_Access_Plan {
    /** Passed to `podman create --add-host` (e.g. host.patchlab.internal:host-gateway). */
    extra_hosts: string[];
    /** Host files to copy into the container after it starts. */
    file_copies: Host_File_Copy[];
    /** Extra container environment variables (merged after detected env). */
    extra_environment_variables: Record<string, string>;
    /** Stop host-side resources (proxy daemon) when the sandbox is destroyed. */
    stop(): Promise<void>;
}

export interface Prepare_Host_Access_Context {
    sandbox_id: string;
    sandbox_directory: string;
    loaded_configuration: Loaded_Configuration;
}
