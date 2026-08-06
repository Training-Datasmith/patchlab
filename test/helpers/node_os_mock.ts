import type * as node_os from 'node:os';

/**
 * Shared host-state shape for the `node:os` mocks installed by
 * resource-limit-defaults / resource-limit-resolution /
 * resource-limit-resolution-five-layer / per-source-clamp. Each consumer
 * file owns one state object, declares it via `vi.hoisted` so the factory
 * can reach it, and mutates the two fields in `beforeEach` to vary the
 * simulated host capacity.
 */
export interface Host_State {
    total_memory_bytes: number;
    cpu_count: number;
}

/**
 * Reset `host_state` to the canonical 16 GiB / 4 CPU defaults. Call from
 * `beforeEach` so each test starts from the same baseline before mutating
 * the fields to vary capacity.
 */
export function reset_host_state(host_state: Host_State): void {
    host_state.total_memory_bytes = 16 * 1024 * 1024 * 1024;
    host_state.cpu_count = 4;
}

/**
 * Build the object returned by a `vi.mock('node:os', ...)` factory. The
 * factory closes over `host_state`, so mutating its fields between tests
 * changes the values that `totalmem()` / `cpus()` report.
 */
export async function build_node_os_mock(
    host_state: Host_State,
    importOriginal: () => Promise<typeof node_os>,
): Promise<Record<string, unknown>> {
    const original = await importOriginal();
    return {
        ...original,
        totalmem: () => host_state.total_memory_bytes,
        cpus: () => new Array(host_state.cpu_count).fill({}) as ReturnType<typeof original.cpus>,
    };
}
