import * as fs from 'node:fs';
import * as path from 'node:path';
import { container_home_user, copy_to_container, exec_container } from '../container_runtime.js';
import { logger } from '../logger.js';
import type { Host_Access_Plan } from '../tools/host_access.js';
import type { Loaded_Configuration } from '../configuration.js';
import type { Tool_Provider } from '../tools/types.js';

export interface Prepared_Host_Access {
    extra_hosts: string[];
    extra_environment_variables: Record<string, string>;
    file_copies: Host_Access_Plan['file_copies'];
    stop: () => Promise<void>;
}

const NOOP_PREPARED: Prepared_Host_Access = {
    extra_hosts: [],
    extra_environment_variables: {},
    file_copies: [],
    stop: async () => {},
};

/**
 * Run a provider's optional `prepare_host_access` hook before container create.
 * Starts host-side resources (proxy) and stages files for later injection.
 */
export async function prepare_provider_host_access(
    provider: Tool_Provider,
    context: {
        sandbox_id: string;
        sandbox_directory: string;
        loaded_configuration: Loaded_Configuration;
    },
): Promise<Prepared_Host_Access> {
    if (provider.prepare_host_access === undefined) {
        return NOOP_PREPARED;
    }

    const plan = await provider.prepare_host_access({
        sandbox_id: context.sandbox_id,
        sandbox_directory: context.sandbox_directory,
        loaded_configuration: context.loaded_configuration,
    });

    if (plan === null) {
        return NOOP_PREPARED;
    }

    return {
        extra_hosts: plan.extra_hosts,
        extra_environment_variables: plan.extra_environment_variables,
        file_copies: plan.file_copies,
        stop: plan.stop,
    };
}

/** Copy staged host-access files into a running container. */
export function inject_provider_host_files(
    container_name: string,
    file_copies: readonly Host_Access_Plan['file_copies'][number][],
    options?: { fail_on_error?: boolean },
): void {
    const successful_copies: Host_Access_Plan['file_copies'][number][] = [];

    for (const copy of file_copies) {
        try {
            exec_container(
                container_name,
                ['mkdir', '-p', path.posix.dirname(copy.container_path)],
                { user: 'root' },
            );

            const source = copy.host_path.endsWith(path.sep) || copy.host_path.endsWith('/')
                ? copy.host_path
                : (is_directory(copy.host_path) ? `${copy.host_path}/.` : copy.host_path);

            copy_to_container(container_name, source, copy.container_path);
            successful_copies.push(copy);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (options?.fail_on_error) {
                throw new Error(
                    `Failed to copy host file '${copy.host_path}' into sandbox: ${message}`,
                    { cause: error },
                );
            }
            logger().warn(
                `Warning: failed to copy host file '${copy.host_path}' into sandbox: ${message}`,
            );
        }
    }

    repair_injected_home_ownership(container_name, successful_copies);
}

/**
 * Root mkdir leaves ~/.config and ~/.local owned by root; restore the image
 * user so tools like OpenCode can write state under the injected tree.
 */
function repair_injected_home_ownership(
    container_name: string,
    file_copies: readonly Host_Access_Plan['file_copies'][number][],
): void {
    const ownership_targets = new Set<string>();

    for (const copy of file_copies) {
        const dotdir = injected_home_dotdir(copy.container_path);
        if (dotdir === null) {
            continue;
        }

        ownership_targets.add(`${dotdir.user}\0${dotdir.path}`);
    }

    for (const entry of ownership_targets) {
        const separator = entry.indexOf('\0');
        const user = entry.slice(0, separator);
        const target = entry.slice(separator + 1);
        exec_container(
            container_name,
            ['chown', '-R', `${user}:${user}`, target],
            { user: 'root' },
        );
    }
}

function injected_home_dotdir(container_path: string): { user: string; path: string } | null {
    const home_user = container_home_user(container_path);
    if (home_user === null) {
        return null;
    }

    const home_prefix = home_user === 'root' ? '/root' : `/home/${home_user}`;
    if (!container_path.startsWith(`${home_prefix}/.`)) {
        return null;
    }

    const remainder = container_path.slice(home_prefix.length + 1);
    const dot_segment = remainder.split('/')[0];
    if (dot_segment === '') {
        return null;
    }

    return {
        user: home_user,
        path: `${home_prefix}/${dot_segment}`,
    };
}

function is_directory(target: string): boolean {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}

export async function stop_prepared_host_access(prepared: Prepared_Host_Access | undefined): Promise<void> {
    if (prepared === undefined) {
        return;
    }

    try {
        await prepared.stop();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger().warn(`Warning: failed to stop host access resources: ${message}`);
    }
}
