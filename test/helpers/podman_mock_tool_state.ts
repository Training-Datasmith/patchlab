import { vi } from 'vitest';
import type { Tool_State } from '../../src/container_runtime.js';

/**
 * Shared mock state for the four-value `Tool_State` test surface
 * (effective-image / tool-state-three-values / tool-state-tag-form-invariants /
 * legacy-authenticated-label). Each consumer file owns one state object,
 * mutates `mock_tool_state` / `mock_is_patchlab_compatible` / `cached_images`
 * before driving `create_sandbox`, and reads `committed_tags` /
 * `committed_labels` / `create_container_calls` afterward.
 *
 * The factory built by `build_tool_state_podman_mock` closes over the state
 * object — the `vi.fn(...)` lambdas read each field at call time, not at
 * factory-construction time, so test bodies can rewrite the state between
 * tests without re-declaring the mock.
 */

export interface Create_Container_Call {
    name: string;
    image: string;
    options?: unknown;
}

export interface Tool_State_Mock_State {
    mock_tool_state: Tool_State;
    mock_is_patchlab_compatible: boolean;
    committed_tags: string[];
    committed_labels: Record<string, string>[];
    cached_images: Set<string>;
    create_container_calls: Create_Container_Call[];
}

/**
 * Construct a fresh mock-state object. Pass `initial` to seed the two
 * scalar fields; the arrays/sets are always empty on a fresh state.
 */
export function create_tool_state_mock_state(
    initial?: { mock_tool_state?: Tool_State; mock_is_patchlab_compatible?: boolean },
): Tool_State_Mock_State {
    return {
        mock_tool_state: initial?.mock_tool_state ?? 'absent',
        mock_is_patchlab_compatible: initial?.mock_is_patchlab_compatible ?? true,
        committed_tags: [],
        committed_labels: [],
        cached_images: new Set<string>(),
        create_container_calls: [],
    };
}

/**
 * Reset the collection fields in-place and optionally reseed the scalars.
 * Call from `beforeEach` so each test starts with a clean slate without
 * losing the closure reference inside the `vi.mock` factory.
 */
export function reset_tool_state_mock_state(
    state: Tool_State_Mock_State,
    overrides?: { mock_tool_state?: Tool_State; mock_is_patchlab_compatible?: boolean },
): void {
    state.committed_tags.length = 0;
    state.committed_labels.length = 0;
    state.cached_images.clear();
    state.create_container_calls.length = 0;
    if (overrides?.mock_tool_state !== undefined) {
        state.mock_tool_state = overrides.mock_tool_state;
    }
    if (overrides?.mock_is_patchlab_compatible !== undefined) {
        state.mock_is_patchlab_compatible = overrides.mock_is_patchlab_compatible;
    }
}

/**
 * Build the object returned by a `vi.mock('../../src/container_runtime.js', ...)` factory.
 * Awaits `importOriginal()` to grab the real module, then overrides the nine
 * functions the tool-state surface needs (`create_container`,
 * `is_patchlab_compatible_image`, `get_image_tool_state`, `image_exists`,
 * `commit_container`, plus the lifecycle stubs). All mocks close over `state`
 * so consumers can mutate the state object between tests.
 *
 * The legacy-authenticated-label test additionally records every
 * `create_container` invocation; the helper always records, so that consumer
 * just reads `state.create_container_calls` while the other three ignore it.
 */
export async function build_tool_state_podman_mock(
    state: Tool_State_Mock_State,
    importOriginal: () => Promise<typeof import('../../src/container_runtime.js')>,
): Promise<Record<string, unknown>> {
    const original = await importOriginal();
    return {
        ...original,
        create_container: vi.fn((name: string, image: string, container_options?: unknown) => {
            state.create_container_calls.push({ name, image, options: container_options });
        }),
        start_container: vi.fn(),
        stop_container: vi.fn(),
        remove_container: vi.fn(),
        exec_container: vi.fn(() => ''),
        copy_to_container: vi.fn(),
        container_exists: vi.fn(() => true),
        container_running: vi.fn(() => true),
        install_package: vi.fn(),
        is_patchlab_compatible_image: vi.fn(() => state.mock_is_patchlab_compatible),
        get_image_tool_state: vi.fn((_image: string, _tool: string) => state.mock_tool_state),
        image_exists: vi.fn((tag: string) => state.cached_images.has(tag)),
        commit_container: vi.fn((_name: string, tag: string, labels?: Record<string, string>) => {
            state.committed_tags.push(tag);
            if (labels) {
                state.committed_labels.push(labels);
            }
        }),
    };
}
