import { destroy_sandbox } from '../../src/sandbox/index.js';

export type Integration_Cleanup_Handler = () => void | Promise<void>;

export interface Integration_Cleanup_Registry {
    register: (handler: Integration_Cleanup_Handler) => void;
    run_all: () => Promise<void>;
}

/** Best-effort teardown registry for integration suites. Handlers run in reverse order. */
export function create_integration_cleanup_registry(): Integration_Cleanup_Registry {
    const handlers: Integration_Cleanup_Handler[] = [];

    return {
        register(handler: Integration_Cleanup_Handler): void {
            handlers.push(handler);
        },
        async run_all(): Promise<void> {
            for (const handler of handlers.toReversed()) {
                try {
                    await handler();
                } catch {
                    // Intentional: integration cleanup is best-effort. A teardown
                    // failure must not prevent the remaining callbacks from running.
                }
            }
        },
    };
}

export function register_destroy_sandbox(
    registry: Integration_Cleanup_Registry,
    sandbox_id: string,
): void {
    registry.register(async () => {
        await destroy_sandbox(sandbox_id, { force: true });
    });
}
