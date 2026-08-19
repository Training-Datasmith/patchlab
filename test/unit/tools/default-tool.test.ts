import { describe, it, expect } from 'vitest';
import { resolve_create_tool_name, DEFAULT_BUILTIN_TOOL } from '../../../src/tools/default_tool.js';
import { EMPTY_LOADED_CONFIGURATION } from '../../../src/sandbox/persisted_resource_limits.js';
import { loaded_configuration_with_resource_limits } from '../../../src/configuration.js';

describe('resolve_create_tool_name', () => {
    it('uses CLI --tool when provided', () => {
        expect(resolve_create_tool_name('aider', EMPTY_LOADED_CONFIGURATION)).toBe('aider');
    });

    it('uses user-global default_tool when CLI omits --tool', () => {
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            default_tool: 'shell',
        });
        expect(resolve_create_tool_name(undefined, loaded)).toBe('shell');
    });

    it('falls back to built-in OpenCode', () => {
        expect(resolve_create_tool_name(undefined, EMPTY_LOADED_CONFIGURATION)).toBe(DEFAULT_BUILTIN_TOOL);
    });

    it('prefers CLI over user-global default_tool', () => {
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            default_tool: 'shell',
        });
        expect(resolve_create_tool_name('aider', loaded)).toBe('aider');
    });

    it('uses per-source override string over user-global default_tool', () => {
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            default_tool: 'shell',
        });
        expect(resolve_create_tool_name(undefined, loaded, 'aider')).toBe('aider');
    });

    it('uses user-global when per-source override is null (host fallback)', () => {
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            default_tool: 'shell',
        });
        expect(resolve_create_tool_name(undefined, loaded, null)).toBe('shell');
    });

    it('uses built-in OpenCode when per-source override is null and no user-global', () => {
        expect(resolve_create_tool_name(undefined, EMPTY_LOADED_CONFIGURATION, null)).toBe(
            DEFAULT_BUILTIN_TOOL,
        );
    });

    it('prefers CLI over per-source override string', () => {
        const loaded = loaded_configuration_with_resource_limits(null, null, {
            default_tool: 'shell',
        });
        expect(resolve_create_tool_name('cursor', loaded, 'aider')).toBe('cursor');
    });
});
