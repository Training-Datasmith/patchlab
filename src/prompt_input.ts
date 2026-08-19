import * as fs from 'node:fs';

export interface Resolve_Prompt_Text_Options {
    read_stdin?: () => string;
    is_tty?: () => boolean;
}

/**
 * Resolve `-p` / `--prompt` from Commander into prompt text.
 *
 * - Omitted → undefined (not prompt mode)
 * - Non-empty string other than `'-'` → returned unchanged
 * - `true` or `'-'` → read all of stdin (bytes preserved)
 */
export function resolve_prompt_text(
    raw: string | boolean | undefined,
    options?: Resolve_Prompt_Text_Options,
): string | undefined {
    if (raw === undefined) {
        return undefined;
    }
    if (typeof raw === 'string' && raw !== '-') {
        return raw;
    }

    const is_tty = options?.is_tty ?? (() => process.stdin.isTTY === true);
    if (is_tty()) {
        throw new Prompt_Input_Error(
            'patchlab: --prompt requires prompt text, a piped stdin stream, or `-p -` with a pipe.',
        );
    }

    const read_stdin = options?.read_stdin ?? (() => fs.readFileSync(0, 'utf8'));
    return read_stdin();
}

export class Prompt_Input_Error extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'Prompt_Input_Error';
    }
}
