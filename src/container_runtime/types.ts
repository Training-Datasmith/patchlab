import type { execFileSync } from 'node:child_process';
import type { Prompter } from '../prompts.js';

export type Container_Runtime_Kind = 'podman' | 'nerdctl';

export type Runtime_Exec_Options = Parameters<typeof execFileSync>[2];

/** Adapter for a container CLI (podman, nerdctl, docker, …). */
export interface Container_Runtime {
    kind: Container_Runtime_Kind;
    display_name: string;
    get_binary(): string;
    /** Whether this runtime should be considered during auto-detection. */
    is_available(): boolean;
    ensure(prompter: Prompter | null): Promise<void>;
    exec(args: string[], options?: Runtime_Exec_Options): Buffer | string;
    resolve_socket_path(): string;
    image_exists(tag: string): boolean;
    container_exists(name: string): boolean;
    reset_verified(): void;
}
