import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    get_provider,
    list_providers,
    provider_supports_prompt_launch,
    provider_supports_prompt_passthrough,
    OPENCODE_TOOL_NAME,
} from '../../../src/tools/index.js';
import * as container_runtime from '../../../src/container_runtime.js';

describe('built-in provider registry at module load', () => {
    it('registers OpenCode as the built-in provider', () => {
        expect(list_providers()).toContain(OPENCODE_TOOL_NAME);
    });

    it('resolves the OpenCode built-in provider', () => {
        const provider = get_provider(OPENCODE_TOOL_NAME);
        expect(provider.display_name).toBe('OpenCode');
        expect(provider.get_launch_command()).toEqual(['opencode']);
    });

    it('declares prompt and passthrough capabilities on OpenCode', () => {
        const provider = get_provider(OPENCODE_TOOL_NAME);
        expect(provider_supports_prompt_launch(provider)).toBe(true);
        expect(provider_supports_prompt_passthrough(provider, 'passthrough')).toBe(true);
        expect(provider_supports_prompt_passthrough(provider, 'file')).toBe(true);
    });

    it('builds opencode run argv for prompt launch', () => {
        const provider = get_provider(OPENCODE_TOOL_NAME);
        expect(provider.get_prompt_launch_command?.('Add tests')).toEqual([
            'opencode', 'run', '--auto', '--', 'Add tests',
        ]);
    });

    it('adds --continue on resume prompt launch', () => {
        const provider = get_provider(OPENCODE_TOOL_NAME);
        expect(provider.get_prompt_launch_command?.('Fix bug', { resume: true })).toEqual([
            'opencode', 'run', '--auto', '--continue', '--', 'Fix bug',
        ]);
    });

    it('splices passthrough tokens before the prompt separator', () => {
        const provider = get_provider(OPENCODE_TOOL_NAME);
        expect(provider.get_prompt_launch_command?.('-fix bug', {
            extra_argv: ['--format', 'json'],
        })).toEqual([
            'opencode', 'run', '--auto', '--format', 'json', '--', '-fix bug',
        ]);
    });

    it('appends passthrough tokens to interactive launch argv', () => {
        const provider = get_provider(OPENCODE_TOOL_NAME);
        expect(provider.get_launch_command({
            extra_argv: ['--model', 'anthropic/claude-sonnet'],
        })).toEqual([
            'opencode', '--model', 'anthropic/claude-sonnet',
        ]);
    });

    it('rejects --file in extra argv', () => {
        const provider = get_provider(OPENCODE_TOOL_NAME);
        expect(() => provider.get_launch_command({
            extra_argv: ['--file', 'x'],
        })).toThrow(/--prompt-file/);
    });

    it('rejects lookup of removed built-ins', () => {
        expect(() => get_provider('gemini-cli-oauth')).toThrow(/gemini-cli-oauth/);
        expect(() => get_provider('gemini-cli-api')).toThrow(/gemini-cli-api/);
        expect(() => get_provider('claude-code')).toThrow(/claude-code/);
    });
});

describe('OpenCode prompt output follow-up hook', () => {
    const provider = get_provider(OPENCODE_TOOL_NAME);

    beforeEach(() => {
        vi.spyOn(container_runtime, 'exec_container');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns null when the latest user turn already has assistant text', () => {
        vi.mocked(container_runtime.exec_container)
            .mockReturnValueOnce(JSON.stringify([{ id: 'ses_123', directory: '/home/patchlab/workspace' }]))
            .mockReturnValueOnce(JSON.stringify({
                messages: [
                    {
                        info: { role: 'user' },
                        parts: [{ type: 'text', text: 'Review the codebase' }],
                    },
                    {
                        info: { role: 'assistant' },
                        parts: [{ type: 'text', text: 'Done.' }],
                    },
                ],
            }));

        expect(provider.maybe_prompt_output_followup?.(
            'container',
            '/home/patchlab/workspace',
            'Review the codebase',
        )).toBeNull();
    });

    it('returns synthesis argv when earlier assistant text exists but the latest turn is tool-only', () => {
        vi.mocked(container_runtime.exec_container)
            .mockReturnValueOnce(JSON.stringify([{ id: 'ses_123', directory: '/home/patchlab/workspace' }]))
            .mockReturnValueOnce(JSON.stringify({
                messages: [
                    {
                        info: { role: 'user' },
                        parts: [{ type: 'text', text: 'First question' }],
                    },
                    {
                        info: { role: 'assistant' },
                        parts: [{ type: 'text', text: 'Earlier answer.' }],
                    },
                    {
                        info: { role: 'user' },
                        parts: [{ type: 'text', text: 'Follow-up prompt' }],
                    },
                    {
                        info: { role: 'assistant' },
                        parts: [{ type: 'tool', input: {} }],
                    },
                ],
            }));

        expect(provider.maybe_prompt_output_followup?.(
            'container',
            '/home/patchlab/workspace',
            'Follow-up prompt',
        )).toEqual(expect.arrayContaining(['opencode', 'run', '--auto', '--continue']));
    });

    it('returns synthesis argv when exported session has no assistant text', () => {
        vi.mocked(container_runtime.exec_container)
            .mockReturnValueOnce(JSON.stringify([{ id: 'ses_123', directory: '/home/patchlab/workspace' }]))
            .mockReturnValueOnce(JSON.stringify({
                messages: [{
                    info: { role: 'assistant' },
                    parts: [{ type: 'tool', input: {} }],
                }],
            }));

        expect(provider.maybe_prompt_output_followup?.(
            'container',
            '/home/patchlab/workspace',
            'Review the codebase',
            { extra_argv: ['--model', 'anthropic/claude-sonnet'] },
        )).toEqual([
            'opencode',
            'run',
            '--auto',
            '--continue',
            '--model',
            'anthropic/claude-sonnet',
            '--',
            expect.stringContaining('Review the codebase'),
        ]);
    });
});
