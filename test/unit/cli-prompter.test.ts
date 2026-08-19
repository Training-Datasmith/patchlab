// Unit tests for the CLI-side readline prompter and its factory. The
// factory is the project's single TTY-detection site for prompting; the
// trust-matrix preservation depends on it returning `null` (NOT a self-
// degrading prompter) when stdin isn't a TTY. These tests pin that
// behavior structurally.
//
// `node:readline` is mocked at the module level so the test doesn't try
// to consume real stdin (which would hang under vitest's child process).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mock state — vi.mock() factories cannot close over module-level
// `let`s declared after their hoisted position, so the test queue lives
// on a stable object the factory captures by reference.
const readline_mock_state = {
    next_answer: '',
    last_question_message: '',
    close_called: false,
};

vi.mock('node:readline', () => ({
    createInterface: () => ({
        question: (message: string, callback: (answer: string) => void) => {
            readline_mock_state.last_question_message = message;
            // Microtask defer so the caller awaits the resulting Promise
            // before the callback fires — matching real readline behavior.
            queueMicrotask(() => callback(readline_mock_state.next_answer));
        },
        close: () => {
            readline_mock_state.close_called = true;
        },
    }),
}));

import { Readline_Prompter, resolve_runtime_prompter } from '../../src/cli_prompter.js';

function set_stdin_tty(value: boolean): void {
    Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        get: () => value,
    });
}

describe('resolve_runtime_prompter — factory', () => {
    let original_descriptor: PropertyDescriptor | undefined;

    beforeEach(() => {
        original_descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    });

    afterEach(() => {
        if (original_descriptor === undefined) {
            // Best-effort restore — Node sets isTTY as a stream property at
            // socket-construction time; deleting our shim falls back to the
            // original getter chain.
            delete (process.stdin as { isTTY?: boolean }).isTTY;
        } else {
            Object.defineProperty(process.stdin, 'isTTY', original_descriptor);
        }
    });

    it('returns null when process.stdin.isTTY is false', () => {
        set_stdin_tty(false);
        expect(resolve_runtime_prompter()).toBeNull();
    });

    it('returns a Readline_Prompter instance when process.stdin.isTTY is true', () => {
        set_stdin_tty(true);
        const prompter = resolve_runtime_prompter();
        expect(prompter).toBeInstanceOf(Readline_Prompter);
    });
});

describe('Readline_Prompter.confirm — readline integration', () => {
    beforeEach(() => {
        readline_mock_state.next_answer = '';
        readline_mock_state.last_question_message = '';
        readline_mock_state.close_called = false;
    });

    it('resolves to true when the user answers "y"', async () => {
        readline_mock_state.next_answer = 'y';
        const prompter = new Readline_Prompter();
        expect(await prompter.confirm('proceed? ')).toBe(true);
        expect(readline_mock_state.last_question_message).toBe('proceed? ');
        expect(readline_mock_state.close_called).toBe(true);
    });

    it('resolves to true when the user answers "yes" (case-insensitive)', async () => {
        readline_mock_state.next_answer = 'YES';
        const prompter = new Readline_Prompter();
        expect(await prompter.confirm('go? ')).toBe(true);
    });

    it('resolves to false when the user answers "n"', async () => {
        readline_mock_state.next_answer = 'n';
        const prompter = new Readline_Prompter();
        expect(await prompter.confirm('proceed? ')).toBe(false);
    });

    it('resolves to default_yes when the user enters empty input', async () => {
        readline_mock_state.next_answer = '';
        const prompter = new Readline_Prompter();
        expect(await prompter.confirm('proceed? ', { default_yes: true })).toBe(true);
    });

    it('defaults to false when default_yes is unset and input is empty', async () => {
        readline_mock_state.next_answer = '';
        const prompter = new Readline_Prompter();
        expect(await prompter.confirm('proceed? ')).toBe(false);
    });
});

describe('Readline_Prompter.choose — readline integration', () => {
    beforeEach(() => {
        readline_mock_state.next_answer = '';
        readline_mock_state.close_called = false;
    });

    it('resolves to the zero-based index when the user picks a valid number', async () => {
        readline_mock_state.next_answer = '2';
        const prompter = new Readline_Prompter();
        expect(await prompter.choose('pick: ', ['a', 'b', 'c'])).toBe(1);
        expect(readline_mock_state.close_called).toBe(true);
    });

    it('resolves to null when the user picks an out-of-range number', async () => {
        readline_mock_state.next_answer = '99';
        const prompter = new Readline_Prompter();
        expect(await prompter.choose('pick: ', ['a', 'b'])).toBeNull();
    });

    it('resolves to null when the user picks 0 (1-based menu treats 0 as invalid)', async () => {
        readline_mock_state.next_answer = '0';
        const prompter = new Readline_Prompter();
        expect(await prompter.choose('pick: ', ['a', 'b'])).toBeNull();
    });

    it('resolves to null when the user enters a non-numeric value', async () => {
        readline_mock_state.next_answer = 'banana';
        const prompter = new Readline_Prompter();
        expect(await prompter.choose('pick: ', ['a', 'b'])).toBeNull();
    });

    it('resolves to null when the user enters empty input (EOF or just Enter)', async () => {
        readline_mock_state.next_answer = '';
        const prompter = new Readline_Prompter();
        expect(await prompter.choose('pick: ', ['a', 'b'])).toBeNull();
    });

    it('prints None by default and Abort when cancel_label is set', async () => {
        const log_lines: string[] = [];
        const { logger, set_logger } = await import('../../src/logger.js');
        const previous = logger();
        set_logger({
            result: (line: string) => previous.result(line),
            info: (line: string) => {
                log_lines.push(line);
                previous.info(line);
            },
            warn: (line: string) => previous.warn(line),
            error: (line: string) => previous.error(line),
            verbose: (line: string) => previous.verbose(line),
        });

        readline_mock_state.next_answer = '1';
        const prompter = new Readline_Prompter();
        await prompter.choose('pick: ', ['repo tool', 'host default']);
        expect(log_lines.some((line) => line.includes('3. None'))).toBe(true);

        log_lines.length = 0;
        await prompter.choose('pick: ', ['repo tool', 'host default'], { cancel_label: 'Abort' });
        expect(log_lines.some((line) => line.includes('3. Abort'))).toBe(true);
        expect(log_lines.some((line) => line.includes('3. None'))).toBe(false);

        set_logger(previous);
    });
});

describe('cli_prompter — structural invariant', () => {
    it('Readline_Prompter does not reference process.stdin.isTTY in its method bodies', async () => {
        // The TTY check lives in the factory, not the class — a regression
        // that pushed the check back into `confirm`/`choose` would re-open
        // the trust-matrix bug the factory pattern was created to close.
        // Read the source as text, strip comments, and assert that the
        // only `process.stdin.isTTY` reference left is the factory's.
        const { readFileSync } = await import('node:fs');
        const path = await import('node:path');
        const source = readFileSync(
            path.resolve(__dirname, '..', '..', 'src', 'cli_prompter.ts'),
            'utf-8',
        );
        // Strip `/* … */` blocks (covers the JSDoc header) and `// …` lines.
        const code_only = source
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n')
            .map((line) => line.replace(/\/\/.*$/, ''))
            .join('\n');
        const tty_occurrences = code_only.match(/process\.stdin\.isTTY/g) ?? [];
        // Exactly one reference — inside `resolve_runtime_prompter`.
        expect(tty_occurrences).toHaveLength(1);
    });
});
