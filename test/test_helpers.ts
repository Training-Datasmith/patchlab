import {
    create_sandbox,
    type Create_Sandbox_Options,
} from '../src/sandbox/index.js';
import { resolve_source_inputs } from '../src/sources.js';
import type { Sandbox_Manifest } from '../src/manifest.js';
import { get_provider_source } from '../src/tools/provider.js';
import { DEFAULT_TEST_TOOL, register_default_test_tool, TEST_CONTAINER_WORKING_DIR, TEST_IMAGE_HOME } from './helpers/stub_tool_provider.js';

export { TEST_CONTAINER_WORKING_DIR, TEST_IMAGE_HOME };

/**
 * Test convenience: call `create_sandbox` with a single positional source
 * directory (the legacy pre-multi-source shape). Resolves the string into a
 * one-entry `Source_Specification[]` via `resolve_source_inputs` and forwards
 * to the production entry point. Production callers (the CLI) construct the
 * array themselves; this helper exists ONLY to keep test call sites compact
 * during the multi-source migration.
 *
 * Registers a minimal stub tool provider and defaults `options.tool` when
 * omitted so integration tests do not depend on removed built-in providers.
 */
export function ensure_integration_test_tool_registered(): void {
    if (get_provider_source(DEFAULT_TEST_TOOL) === null) {
        register_default_test_tool();
    }
}

export async function create_sandbox_from_directory(
    source_path: string,
    options?: Create_Sandbox_Options,
): Promise<Sandbox_Manifest> {
    ensure_integration_test_tool_registered();
    const resolved_options: Create_Sandbox_Options = {
        ...options,
        tool: options?.tool ?? DEFAULT_TEST_TOOL,
    };
    // Marked `async` so synchronous validation throws inside
    // `resolve_source_inputs` (e.g. "source not in a git repository") surface
    // as promise rejections rather than as bare synchronous throws —
    // matching `.rejects.toThrow` expectations in existing tests.
    return create_sandbox(resolve_source_inputs(source_path, []), resolved_options);
}
