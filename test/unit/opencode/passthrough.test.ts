import { describe, it, expect } from 'vitest';
import {
    validate_opencode_interactive_extra_argv,
    validate_opencode_prompt_extra_argv,
} from '../../../src/opencode/passthrough.js';

describe('OpenCode passthrough validation', () => {
    it('rejects passthrough with exec false', () => {
        expect(() => validate_opencode_interactive_extra_argv(['--model'], false))
            .toThrow(/--no-interactive/);
    });

    it('rejects --file in extra argv', () => {
        expect(() => validate_opencode_prompt_extra_argv(['--file', 'x'], true))
            .toThrow(/--prompt-file/);
    });

    it('rejects run in interactive extra argv', () => {
        expect(() => validate_opencode_interactive_extra_argv(['run'], true))
            .toThrow(/use -p/);
    });

    it('rejects duplicate patchlab-controlled flags on prompt launch', () => {
        expect(() => validate_opencode_prompt_extra_argv(['--auto'], true))
            .toThrow(/--auto/);
    });
});
