/**
 * Policy/persistence orchestration for the interactive prompts the CLI
 * issues. Two independent flows:
 *
 *   - `resolve_socket_mount` — one-time consent for mounting the host
 *     podman socket, persisted into `.patchlab.json`.
 *   - `prompt_service_selection` — multi-choice picker for matching a
 *     detected service requirement to an actually-running container
 *     (see `Running_Container` in `podman.ts`).
 *
 * Library-side; this file does NOT import `node:readline`. The CLI
 * supplies a `Prompter` (or `null` for non-interactive context); each
 * policy function maps `null` to the function-specific safe default
 * below — the defaults are NOT uniform. The authoritative table:
 *
 *   | Function                | Safe default when `prompter: null`                                 |
 *   |-------------------------|--------------------------------------------------------------------|
 *   | resolve_socket_mount    | Returns `{ approved: false }` from the prompt branch.              |
 *   | prompt_service_selection| Returns `null` (selection declined).                               |
 *   | offer_save_service      | Skips the `.patchlab.json` write.                                  |
 *
 * Collapsing the table to a single "decline everything" rule would
 * change `offer_save_service`'s observable behavior — the table is
 * load-bearing.
 *
 * Errors from a `Prompter` (readline I/O failure, `Fake_Prompter`
 * exhaustion) propagate from these functions; the policy does NOT catch
 * and substitute a safe default. That propagation IS how a test signals
 * that the expected prompt count was wrong.
 */
import { load_overrides, update_overrides } from './overrides.js';
import type { Detected_Requirements } from './detect/index.js';
import { logger } from './logger.js';
import type { Running_Container } from './container_runtime.js';

export type { Running_Container };

/**
 * Two-method contract for interactive prompts. Library functions accept
 * `Prompter | null`; the CLI constructs a `Readline_Prompter` (in
 * `cli_prompter.ts`) via the `resolve_runtime_prompter()` factory and threads
 * it down. A `null` value signals non-interactive context and policy
 * functions short-circuit to function-specific safe defaults (see the
 * safe-defaults table in the file header).
 *
 * Non-CLI consumers (VS Code, GUI, AI-skill harnesses) implement this
 * interface to dispatch prompts through their own UI channel.
 */
export interface Prompter {
    confirm(message: string, options?: { default_yes?: boolean }): Promise<boolean>;
    choose(
        message: string,
        options: string[],
        choose_options?: { cancel_label?: string },
    ): Promise<number | null>;
}

export interface Socket_Mount_Resolution {
    approved: boolean;
}

/**
 * Resolve whether socket mounts should be applied.
 * Checks CLI flags first, then .patchlab.json, then prompts interactively.
 * A `null` prompter at the prompt branch returns `{ approved: false }`
 * (matching today's non-TTY behavior).
 */
export async function resolve_socket_mount(
    project_directory: string,
    requirements: Detected_Requirements,
    cli_flags: { allow_socket_mount?: boolean; deny_socket_mount?: boolean },
    prompter: Prompter | null,
): Promise<Socket_Mount_Resolution> {
    // No socket mounts detected — nothing to resolve
    if (requirements.volume_mounts.length === 0) {
        return { approved: false };
    }

    const has_socket = requirements.volume_mounts.some(
        (m) => m.host_path.includes('podman.sock')
            || m.host_path.includes('docker.sock')
            || m.host_path.includes('containerd.sock'),
    );
    if (!has_socket) {
        return { approved: true }; // non-socket mounts are fine
    }

    // CLI flags override everything
    if (cli_flags.deny_socket_mount) {
        return { approved: false };
    }
    if (cli_flags.allow_socket_mount) {
        return { approved: true };
    }

    // Check .patchlab.json
    const overrides = load_overrides(project_directory);
    if (overrides.allow_socket_mount === true) {
        return { approved: true };
    }
    if (overrides.allow_socket_mount === false) {
        return { approved: false };
    }

    // Non-interactive context — decline per the safe-defaults table.
    if (prompter === null) {
        return { approved: false };
    }

    const approved = await prompter.confirm(
        'This project needs access to the container runtime (Podman socket). Allow? [Y/n] ',
        { default_yes: true },
    );

    if (!approved) {
        return { approved: false };
    }

    // Offer to save
    const should_save = await prompter.confirm('Save to .patchlab.json? [Y/n] ', { default_yes: true });
    if (should_save) {
        update_overrides(project_directory, (current) => ({
            ...current,
            allow_socket_mount: true,
        }));
    }

    return { approved: true };
}

export interface Service_Selection {
    environment_key: string;
    environment_value: string;
}

/**
 * Prompt the user to select a running service container.
 * Returns the chosen environment variable, or null if declined/skipped.
 * A `null` prompter returns `null` immediately (matching today's non-TTY
 * behavior plus closing a latent EOF-hang bug in the multi-candidate
 * `choose` path — see the design doc).
 */
export async function prompt_service_selection(
    project_directory: string,
    service_name: string,
    environment_key: string,
    candidates: Running_Container[],
    connection_template: string,
    prompter: Prompter | null,
): Promise<Service_Selection | null> {
    // Skip if .patchlab.json already sets this environment variable
    const overrides = load_overrides(project_directory);
    const configured_value = overrides.requirements?.environment_variables?.[environment_key];
    if (configured_value !== undefined) {
        return null;
    }

    if (candidates.length === 0) {
        logger().warn(`No running ${service_name} containers found.`);
        return null;
    }

    // Non-interactive context — decline per the safe-defaults table.
    if (prompter === null) {
        return null;
    }

    if (candidates.length === 1) {
        const c = candidates[0];
        const approved = await prompter.confirm(
            `Found ${service_name} container: ${c.name} (${c.ports}). Use for this sandbox? [Y/n] `,
            { default_yes: true },
        );
        if (!approved) {
            return null;
        }

        const value = build_connection_string(connection_template, c);
        const selection: Service_Selection = { environment_key, environment_value: value };
        await offer_save_service(project_directory, selection, prompter);
        return selection;
    }

    // Multiple candidates. The "1. … 2. … N+1. None" numbered menu is
    // printed by the prompter implementation (Readline_Prompter.choose);
    // the policy function just announces the header.
    logger().info(`Found ${candidates.length} ${service_name} containers:`);
    const options = candidates.map((c) => `${c.name} (${c.image}, ${c.ports})`);
    const choice = await prompter.choose('Select a container: ', options);
    if (choice === null) {
        return null;
    }

    const selected = candidates[choice];
    const value = build_connection_string(connection_template, selected);
    const selection: Service_Selection = { environment_key, environment_value: value };
    await offer_save_service(project_directory, selection, prompter);
    return selection;
}

function build_connection_string(template: string, container: Running_Container): string {
    // Extract port number from ports string (e.g., "0.0.0.0:5432->5432/tcp" -> "5432")
    const port_match = new RegExp(/:(\d+)->/).exec(container.ports);
    const port = port_match ? port_match[1] : new RegExp(/(\d+)/).exec(container.ports)?.[1] ?? '0';
    return template.replace('{port}', port).replace('{dbname}', 'test');
}

async function offer_save_service(
    project_directory: string,
    selection: Service_Selection,
    prompter: Prompter | null,
): Promise<void> {
    if (prompter === null) {
        return;
    }

    const should_save = await prompter.confirm('Save to .patchlab.json? [Y/n] ', { default_yes: true });
    if (should_save) {
        update_overrides(project_directory, (current) => ({
            ...current,
            requirements: {
                ...current.requirements,
                environment_variables: {
                    ...current.requirements?.environment_variables,
                    [selection.environment_key]: selection.environment_value,
                },
            },
        }));
    }
}