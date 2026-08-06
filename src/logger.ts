/**
 * Project-level Logger interface and default ConsoleLogger implementation.
 *
 * All user-facing output from patchlab flows through `logger().<method>(...)`
 * — never through `console.*` directly. The migration-invariant test under
 * `test/unit/invariants/logger-migration.test.ts` enforces this.
 *
 * The interface partitions output by channel:
 *
 *   stdout  — `result` (the command's canonical answer; pipeable / capturable)
 *   stderr  — `info` (progress/status), `warn` (warnings), `error` (errors)
 *
 * Stdout is reserved for the command's "answer." Everything else — action
 * confirmations, progress chatter, warnings, errors — lands on stderr. This
 * matches the strict Unix convention (Docker, gh CLI). Commands that need a
 * machine-readable result for scripting use `result()`; everything else uses
 * `info()` (or `warn`/`error` for severity).
 *
 * A module-level singleton is exposed via `logger()`. The default implementation
 * is `ConsoleLogger`, which writes to `process.stdout`/`process.stderr` directly.
 * `set_logger(replacement)` swaps the active singleton; this is intended for
 * CLI bootstrap (e.g. a future GUI mode supplying its own implementation) and
 * for tests installing a `RecordingLogger` in `beforeEach`. Non-bootstrap
 * callers needing localized output capture should use the parameter-injection
 * seams in `list_tools.ts`, `tools/configured_provider/trust_verification.ts`,
 * and `tools/index.ts`, not swap the global logger.
 */

export interface Logger {
    /**
     * The command's canonical answer (stdout). Pipeable / capturable by scripts.
     * Used for list rows, JSON dumps, patch contents, diff file paths, image
     * listing rows — anything a user might pipe to `awk` or `jq`. Most commands
     * today don't emit a `result` line; action confirmations like "Sandbox
     * created: …" are routed through `info` so they don't clutter pipes.
     */
    result(message: string): void;

    /**
     * Progress, status, and human-readable confirmation diagnostic (stderr).
     * Anything the user should see in their terminal that is NOT the command's
     * pipeable answer. Examples: cache-hit notices, build progress, "Sandbox
     * created: …" action confirmations, "Shell exited.", "No active sandboxes.".
     */
    info(message: string): void;

    /**
     * Warning the user should see (stderr). Accepts an `Error` object as well
     * as a string; when an `Error` is passed, `ConsoleLogger.warn` preserves
     * the stack trace in the output (parallel to `console.warn(err)`).
     */
    warn(message: string | Error): void;

    /**
     * Error message (stderr). Accepts an `Error` object as well as a string;
     * when an `Error` is passed, `ConsoleLogger.error` preserves the stack
     * trace in the output (parallel to `console.error(err)`).
     */
    error(message: string | Error): void;

    /**
     * Opt-in diagnostic output (stderr). Gated by the `PATCHLAB_VERBOSE`
     * environment variable and the `--verbose` CLI flag (CLI wins); off by
     * default. `ConsoleLogger.verbose` strips trailing newlines, splits the
     * message on `\n`, and writes one `patchlab[verbose]: ${line}\n` line to
     * stderr per fragment so every emitted line is independently greppable.
     * No-op when verbose mode is inactive; no allocation beyond the gate check.
     */
    verbose(message: string): void;
}

export class ConsoleLogger implements Logger {
    result(message: string): void {
        this.write_with_trailing_newline(process.stdout, message);
    }

    info(message: string): void {
        this.write_with_trailing_newline(process.stderr, message);
    }

    warn(message: string | Error): void {
        if (message instanceof Error) {
            this.write_error_object(process.stderr, message);
            return;
        }

        this.write_with_trailing_newline(process.stderr, message);
    }

    error(message: string | Error): void {
        this.warn(message);
    }

    /**
     * Verbose emission. Bypasses `write_with_trailing_newline` because verbose
     * has stricter formatting than the other four channels: each emitted line
     * is independently prefixed with `patchlab[verbose]: ` so tooling can
     * `grep '^patchlab\[verbose\]:'` even continuation lines of a multi-line
     * message. Trailing newlines on the input are stripped (so a caller using
     * a template literal that ends in `\n` doesn't produce a spurious empty
     * prefixed line); embedded blank lines inside the message are preserved.
     * Empty messages (or messages that reduce to empty after trailing-newline
     * stripping) are a no-op — empty diagnostic lines are never useful.
     */
    verbose(message: string): void {
        if (!is_verbose_mode_active()) {
            return;
        }

        const stripped = message.replace(/\n+$/, '');
        if (stripped === '') {
            return;
        }

        for (const line of stripped.split('\n')) {
            process.stderr.write(`patchlab[verbose]: ${line}\n`);
        }
    }

    protected write_with_trailing_newline(stream: NodeJS.WriteStream, message: string): void {
        if (message.endsWith('\n')) {
            stream.write(message);
        } else {
            stream.write(message + '\n');
        }
    }

    protected write_error_object(stream: NodeJS.WriteStream, error: Error): void {
        const stack = error.stack;
        const rendered = stack === undefined
            ? `${String(error)}\n`
            : `${stack}\n`;
        stream.write(rendered);
    }
}

let active_logger: Logger = new ConsoleLogger();

/**
 * Return the active `Logger` singleton. Call this on every emission rather
 * than caching the result, so that `set_logger` swaps are visible everywhere.
 */
export function logger(): Logger {
    return active_logger;
}

/**
 * Replace the active `Logger` singleton.
 *
 * Bootstrap-time only. Intended uses:
 *   - CLI startup (e.g. a future GUI swapping in its own implementation).
 *   - Tests installing a `RecordingLogger` in `beforeEach` and restoring
 *     a fresh `ConsoleLogger` in `afterEach`.
 *
 * Non-bootstrap callers needing localized output capture should use the
 * parameter-injection seams in `list_tools.ts`, `tools/configured_provider/trust_verification.ts`,
 * and `tools/index.ts`, not swap the global logger.
 */
export function set_logger(replacement: Logger): void {
    active_logger = replacement;
}

// CLI-side override for verbose mode. Set by `set_cli_verbose_override` from
// the argv pre-scan in `src/cli.ts`, which runs BEFORE Commander parses argv.
// Tests reset this between cases by calling `set_cli_verbose_override(false)`.
let cli_override_active = false;

/**
 * Toggle the CLI-side verbose override. Called by the argv pre-scan in
 * `src/cli.ts` before Commander's `parseAsync` runs. The pre-scan timing is
 * load-bearing: Commander's subcommand action handlers execute *during*
 * `parseAsync`, so any `logger().verbose(...)` call inside an action handler
 * needs to see the correct override state before the parser runs.
 */
export function set_cli_verbose_override(active: boolean): void {
    cli_override_active = active;
}

/**
 * Return `true` when verbose mode is active for the current invocation.
 *
 * Precedence:
 *   1. CLI override (set by `set_cli_verbose_override`) — wins when `true`.
 *   2. `PATCHLAB_VERBOSE` environment variable, decoded as follows.
 *
 * Recognized OFF values for `PATCHLAB_VERBOSE` (the off-set is closed):
 *   - unset
 *   - empty string
 *   - the literal `'0'`
 *   - case-insensitive `'false'` (`'FALSE'`, `'False'`, ...)
 *   - case-insensitive `'off'` (`'OFF'`, `'Off'`, ...)
 *
 * Any other non-empty value activates verbose mode. The off-set is
 * deliberately small (numeric zero, the boolean word, the toggle word) so the
 * rule stays memorable; values like `'no'` are NOT in the off-set and so
 * activate verbose mode. This is the project-wide rule; do not add ad-hoc
 * env-var decoders elsewhere.
 *
 * The env var is re-read on every call (no module-load caching) so tests and
 * tools can toggle the mode between calls without reloading the module.
 *
 * Exported primarily for testability; production code calls
 * `logger().verbose(...)` which delegates to this function internally.
 */
export function is_verbose_mode_active(): boolean {
    if (cli_override_active) {
        return true;
    }

    const value = process.env.PATCHLAB_VERBOSE;
    if (value === undefined || value === '' || value === '0') {
        return false;
    }

    const lowered = value.toLowerCase();
    if ((lowered === 'false') || (lowered === 'off')) {
        return false;
    }

    return true;
}

/**
 * Argv pre-scan: returns `true` when `--verbose` appears in `argv` before any
 * `--` end-of-options separator. Run by `src/cli.ts` at startup, BEFORE
 * Commander's `parseAsync` is called, to feed `set_cli_verbose_override`.
 *
 * Rationale: Commander's subcommand action handlers execute *during*
 * `parseAsync`. If the override were set only after `parseAsync` returned,
 * any `logger().verbose(...)` call inside an action handler would see the
 * stale `false` value even when the user passed `--verbose`. The pre-scan
 * eliminates this race.
 *
 * The scan stops at the first `--` token (Commander's end-of-options
 * separator), so `--verbose` appearing as a positional argument after `--`
 * does not activate the override. Only the exact bare token `--verbose` is
 * matched — value-forms like `--verbose=true` are not accepted by Commander's
 * standard boolean-option parsing either.
 */
export function argv_contains_verbose_flag(argv: readonly string[]): boolean {
    for (const token of argv) {
        if (token === '--') {
            return false;
        }
        if (token === '--verbose') {
            return true;
        }
    }
    return false;
}
