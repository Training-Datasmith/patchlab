import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as container_runtime from '../../../src/container_runtime.js';
import {
    build_prompt_synthesis_followup_argv,
    maybe_opencode_prompt_output_followup,
    parse_latest_session_id_from_list_json,
    parse_session_id_for_workspace,
    session_export_has_assistant_text,
} from '../../../src/opencode/prompt_output.js';

describe('parse_latest_session_id_from_list_json', () => {
    it('returns the first session id from JSON output', () => {
        const output = JSON.stringify([
            { id: 'ses_latest', title: 'Latest', updated: 2 },
            { id: 'ses_older', title: 'Older', updated: 1 },
        ]);
        expect(parse_latest_session_id_from_list_json(output)).toBe('ses_latest');
    });

    it('returns null for empty or invalid JSON', () => {
        expect(parse_latest_session_id_from_list_json('')).toBeNull();
        expect(parse_latest_session_id_from_list_json('not-json')).toBeNull();
        expect(parse_latest_session_id_from_list_json('[]')).toBeNull();
    });
});

describe('parse_session_id_for_workspace', () => {
    it('prefers the session whose directory matches the workspace cwd', () => {
        const output = JSON.stringify([
            { id: 'ses_other', directory: '/home/patchlab/other' },
            { id: 'ses_workspace', directory: '/home/patchlab/workspace' },
        ]);
        expect(parse_session_id_for_workspace(output, '/home/patchlab/workspace'))
            .toBe('ses_workspace');
    });

    it('falls back to the first session when no workspace metadata is present', () => {
        const output = JSON.stringify([
            { id: 'ses_latest', title: 'Latest' },
            { id: 'ses_older', title: 'Older' },
        ]);
        expect(parse_session_id_for_workspace(output, '/home/patchlab/workspace'))
            .toBe('ses_latest');
    });
});

describe('session_export_has_assistant_text', () => {
    it('detects assistant text parts after the latest user turn', () => {
        const export_data = {
            messages: [
                {
                    info: { role: 'user' },
                    parts: [{ type: 'text', text: 'Review the codebase' }],
                },
                {
                    info: { role: 'assistant' },
                    parts: [{ type: 'tool', input: {} }],
                },
                {
                    info: { role: 'assistant' },
                    parts: [{ type: 'text', text: 'Here is my review.' }],
                },
            ],
        };
        expect(session_export_has_assistant_text(export_data)).toBe(true);
    });

    it('ignores assistant text from earlier turns before the latest user message (R6 resume)', () => {
        const export_data = {
            messages: [
                {
                    info: { role: 'user' },
                    parts: [{ type: 'text', text: 'First question' }],
                },
                {
                    info: { role: 'assistant' },
                    parts: [{ type: 'text', text: 'Earlier written answer.' }],
                },
                {
                    info: { role: 'user' },
                    parts: [{ type: 'text', text: 'Follow-up prompt' }],
                },
                {
                    info: { role: 'assistant' },
                    parts: [{ type: 'tool', input: { command: 'ls' } }],
                },
            ],
        };
        expect(session_export_has_assistant_text(export_data)).toBe(false);
    });

    it('returns false for tool-only assistant turns', () => {
        const export_data = {
            messages: [
                {
                    info: { role: 'assistant' },
                    parts: [{ type: 'tool', input: { command: 'ls' } }],
                },
            ],
        };
        expect(session_export_has_assistant_text(export_data)).toBe(false);
    });

    it('detects assistant content field after the latest user turn', () => {
        const export_data = {
            messages: [
                {
                    info: { role: 'user' },
                    parts: [{ type: 'text', text: 'Prompt' }],
                },
                {
                    info: { role: 'assistant' },
                    content: '  Written answer  ',
                },
            ],
        };
        expect(session_export_has_assistant_text(export_data)).toBe(true);
    });

    it('ignores whitespace-only assistant text', () => {
        const export_data = {
            messages: [
                {
                    info: { role: 'assistant' },
                    parts: [{ type: 'text', text: '   \n  ' }],
                },
            ],
        };
        expect(session_export_has_assistant_text(export_data)).toBe(false);
    });
});

describe('maybe_opencode_prompt_output_followup', () => {
    beforeEach(() => {
        vi.spyOn(container_runtime, 'exec_container');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns synthesis argv when session export fails (inspection failure is not treated as text present)', () => {
        vi.mocked(container_runtime.exec_container)
            .mockReturnValueOnce(JSON.stringify([{ id: 'ses_123', directory: '/home/patchlab/workspace' }]))
            .mockImplementationOnce(() => {
                throw new Error('export truncated');
            });

        expect(maybe_opencode_prompt_output_followup(
            'container',
            '/home/patchlab/workspace',
            'Review the codebase',
        )).toEqual(expect.arrayContaining(['opencode', 'run', '--auto', '--continue']));
    });

    it('returns synthesis argv for resume when only the latest turn is tool-only', () => {
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
                        parts: [{ type: 'text', text: 'Earlier written answer.' }],
                    },
                    {
                        info: { role: 'user' },
                        parts: [{ type: 'text', text: 'Follow-up prompt' }],
                    },
                    {
                        info: { role: 'assistant' },
                        parts: [{ type: 'tool', input: { command: 'ls' } }],
                    },
                ],
            }));

        expect(maybe_opencode_prompt_output_followup(
            'container',
            '/home/patchlab/workspace',
            'Follow-up prompt',
        )).toEqual(expect.arrayContaining(['opencode', 'run', '--auto', '--continue']));
    });
});

describe('build_prompt_synthesis_followup_argv', () => {
    it('builds opencode run --auto --continue with synthesis prompt', () => {
        expect(build_prompt_synthesis_followup_argv('Review the codebase')).toEqual([
            'opencode',
            'run',
            '--auto',
            '--continue',
            '--',
            'Based on your work above, write your response for the user. No tools — plain text only.\n\nOriginal request:\nReview the codebase',
        ]);
    });

    it('preserves passthrough and prompt files', () => {
        expect(build_prompt_synthesis_followup_argv('Fix bug', {
            extra_argv: ['--model', 'anthropic/claude-sonnet'],
            files: ['/home/patchlab/context/README.md'],
        })).toEqual([
            'opencode',
            'run',
            '--auto',
            '--continue',
            '--model',
            'anthropic/claude-sonnet',
            '--file',
            '/home/patchlab/context/README.md',
            '--',
            'Based on your work above, write your response for the user. No tools — plain text only.\n\nOriginal request:\nFix bug',
        ]);
    });
});
