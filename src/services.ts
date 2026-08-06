/**
 * Service-to-environment-variable resolution. When detection finds a service
 * requirement (e.g. `postgres`), this module looks up the corresponding env
 * key + connection template (`SERVICE_MAP`), queries `podman ps` for running
 * candidate containers (`query_running_containers`), prompts the user to
 * pick one (or none), and produces the env-var selection that flows into
 * the sandbox.
 *
 * Selection precedence: interactive choice > `.patchlab.json` overrides >
 * detected defaults.
 */
import type { Detected_Requirements } from './detect/index.js';
import type { Prompter, Service_Selection } from './prompts.js';
import { prompt_service_selection } from './prompts.js';
import { query_running_containers, type Running_Container } from './podman.js';

export interface Service_Mapping {
    environment_key: string;
    connection_template: string;
}

export const SERVICE_MAP: Record<string, Service_Mapping> = {
    postgres: {
        environment_key: 'DATABASE_URL',
        connection_template: 'postgres://localhost:{port}/{dbname}',
    },
    redis: {
        environment_key: 'REDIS_URL',
        connection_template: 'redis://localhost:{port}',
    },
    mysql: {
        environment_key: 'DATABASE_URL',
        connection_template: 'mysql://localhost:{port}/{dbname}',
    },
    mongodb: {
        environment_key: 'MONGODB_URI',
        connection_template: 'mongodb://localhost:{port}',
    },
};

/**
 * Match running containers to a service name by checking the base image name.
 * Ignores the tag — e.g., `postgres:16-alpine` matches service `postgres`.
 */
export function match_containers_for_service(
    service_name: string,
    running: Running_Container[],
): Running_Container[] {
    return running.filter((c) => {
        const last_segment = c.image.split('/').pop() ?? ''; // remove registry prefix
        const image_name = last_segment.split(':')[0]; // remove tag
        return image_name === service_name;
    });
}

export interface Resolve_Services_Options {
    /**
     * Test seam: inject the running-containers list so the orchestration can be
     * unit-tested without shelling out to `podman ps`. Production callers omit
     * this; the function falls back to `query_running_containers()`.
     */
    running_containers?: Running_Container[];
}

/**
 * For each detected service requirement, query host containers, prompt user,
 * and return environment variable selections.
 *
 * Environment variable precedence: interactive selection > .patchlab.json > detection
 */
export async function resolve_services(
    project_directory: string,
    requirements: Detected_Requirements,
    prompter: Prompter | null,
    options: Resolve_Services_Options = {},
): Promise<Service_Selection[]> {
    const selections: Service_Selection[] = [];
    const running = options.running_containers ?? query_running_containers();

    for (const service of requirements.services) {
        const mapping = SERVICE_MAP[service.name];
        if (!mapping) {
            continue;
        }

        const candidates = match_containers_for_service(service.name, running);
        const selection = await prompt_service_selection(
            project_directory,
            service.name,
            mapping.environment_key,
            candidates,
            mapping.connection_template,
            prompter,
        );

        if (selection) {
            selections.push(selection);
        }
    }

    return selections;
}

/**
 * Merge service selections into requirements, respecting precedence:
 * interactive > .patchlab.json > detected
 */
export function merge_service_selections(
    requirements: Detected_Requirements,
    selections: Service_Selection[],
): Detected_Requirements {
    const environment_map = new Map(requirements.environment_variables.map((r) => [r.key, r]));

    for (const selection of selections) {
        environment_map.set(selection.environment_key, {
            type: 'environment_var',
            key: selection.environment_key,
            value: selection.environment_value,
            source: 'configuration_files', // treated as interactive override
        });
    }

    return {
        ...requirements,
        environment_variables: Array.from(environment_map.values()),
    };
}
