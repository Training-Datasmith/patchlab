const PROMPT_CONTROLLED_FLAGS = new Set(['--auto', '--continue']);
const FILE_FLAGS = new Set(['--file', '-f']);

/**
 * Validate `extra_argv` tokens for OpenCode interactive (`opencode …`) launch.
 */
export function validate_opencode_interactive_extra_argv(
    extra_argv: string[] | undefined,
    exec: boolean | undefined,
): void {
    if (extra_argv === undefined || extra_argv.length === 0) {
        return;
    }
    if (exec === false) {
        throw new Error(
            '--passthrough has no effect with --no-interactive; omit --no-interactive or use -p.',
        );
    }
    reject_common_extra_argv_violations(extra_argv);
    if (extra_argv.includes('run')) {
        throw new Error(
            '--passthrough cannot include "run"; use -p for one-shot prompt launch.',
        );
    }
}

/**
 * Validate `extra_argv` for OpenCode `opencode run …` prompt launch.
 */
export function validate_opencode_prompt_extra_argv(
    extra_argv: string[] | undefined,
    exec: boolean | undefined,
): void {
    if (extra_argv === undefined || extra_argv.length === 0) {
        return;
    }
    if (exec === false) {
        throw new Error(
            '--passthrough has no effect with --no-interactive; omit --no-interactive or use -p.',
        );
    }
    reject_common_extra_argv_violations(extra_argv);
    for (const token of extra_argv) {
        if (token === 'run') {
            throw new Error('--passthrough cannot include "run"; patchlab supplies opencode run.');
        }
        if (PROMPT_CONTROLLED_FLAGS.has(token)) {
            throw new Error(`--passthrough cannot include ${token}; patchlab supplies it for prompt launch.`);
        }
    }
}

function reject_common_extra_argv_violations(extra_argv: string[]): void {
    for (const token of extra_argv) {
        if (token === '--') {
            throw new Error('--passthrough cannot include "--"; the prompt is supplied via -p.');
        }
        if (FILE_FLAGS.has(token)) {
            throw new Error('--passthrough cannot include --file; use --prompt-file with -p.');
        }
    }
}
