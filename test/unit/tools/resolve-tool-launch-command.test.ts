import { describe, it, expect } from 'vitest';
import { resolve_tool_launch_command } from '../../../src/tools/index.js';
import type { Launch_Context, Tool_Provider } from '../../../src/tools/types.js';

function make_provider(overrides: Partial<Tool_Provider> = {}): Tool_Provider {
    return {
        name: 'stub',
        display_name: 'Stub',
        image_specification: {
            base_image: 'node:22-slim',
            image_user: 'node',
            image_home: '/home/node',
            configuration_directory_name: '.stub',
            async prepare_build_assets() { return new Map(); },
            get_dockerfile_lines() { return []; },
            get_dockerfile_environment() { return {}; },
            get_base_preparation_lines() { return { lines: [] }; },
        },
        inject_authentication: () => ({ type: 'none' }),
        get_launch_command: (_context?: Launch_Context) => ['stub-tool'],
        validate_image: () => ({ valid: true, reasons: [] }),
        get_cached_version: () => null,
        get_openspec_tool_name: () => 'stub',
        get_authentication_method: () => 'none',
        get_extractable_artifacts: () => [],
        inject_session_state: async () => { /* no-op */ },
        ...overrides,
    };
}

describe('resolve_tool_launch_command', () => {
    it('delegates to get_launch_command when no prompt is given', () => {
        const provider = make_provider();
        expect(resolve_tool_launch_command(provider, undefined)).toEqual(['stub-tool']);
    });

    it('throws when prompt is given but the provider does not implement prompt launch', () => {
        const provider = make_provider();
        expect(() => resolve_tool_launch_command(provider, 'hello'))
            .toThrow("tool 'stub' does not support --prompt");
    });

    it('throws when extra_argv is given but passthrough is unsupported', () => {
        const provider = make_provider();
        expect(() => resolve_tool_launch_command(provider, undefined, {
            extra_argv: ['--model'],
        })).toThrow("tool 'stub' does not support --passthrough");
    });

    it('calls get_prompt_launch_command on the provider object (preserves this)', () => {
        let received_context: Launch_Context | undefined;
        const provider = make_provider({
            get_prompt_launch_command(prompt, context) {
                received_context = context;
                return ['prompt-tool', prompt];
            },
        });

        expect(resolve_tool_launch_command(provider, 'fix tests', { resume: true }))
            .toEqual(['prompt-tool', 'fix tests']);
        expect(received_context).toEqual({ resume: true });
    });
});
