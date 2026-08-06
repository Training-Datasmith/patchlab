/**
 * CLI-side readline implementation of the `Prompter` interface.
 *
 * This is the only `src/` module that imports `node:readline` — the
 * structural invariant tested by `test/unit/invariants/readline-import-
 * invariant.test.ts`. Library modules consume the `Prompter` interface
 * (defined in `src/prompts.ts`) and never touch readline directly.
 *
 * TTY detection lives in `resolve_runtime_prompter()` — the factory
 * returns `null` when `process.stdin.isTTY` is falsy and the policy
 * layer's non-interactive safe defaults take over. Centralizing the
 * check in the factory (rather than inside `Readline_Prompter`) is
 * load-bearing: a self-degrading prompter would cause the trust-
 * verification policy to ignore `--allow-untrusted-manifests` on
 * piped stdin. See `openspec/changes/isolate-cli-prompter/design.md`
 * Decision 2 for the reasoning.
 */
import * as readline from 'node:readline';
import type { Prompter } from './prompts.js';
import { logger } from './logger.js';

export class Readline_Prompter implements Prompter {
    public confirm(message: string, options?: { default_yes?: boolean }): Promise<boolean> {
        const default_yes = options?.default_yes ?? false;
        const readline_interface = readline.createInterface({ input: process.stdin, output: process.stderr });

        return new Promise((resolve) => {
            readline_interface.question(message, (answer) => {
                readline_interface.close();
                const trimmed = answer.trim().toLowerCase();
                if (trimmed === '') {
                    resolve(default_yes);
                    return;
                }
                resolve(trimmed === 'y' || trimmed === 'yes');
            });
        });
    }

    public choose(message: string, options: string[]): Promise<number | null> {
        const readline_interface = readline.createInterface({ input: process.stdin, output: process.stderr });

        return new Promise((resolve) => {
            for (let i = 0; i < options.length; i++) {
                logger().info(`  ${i + 1}. ${options[i]}`);
            }

            logger().info(`  ${options.length + 1}. None`);
            readline_interface.question(message, (answer) => {
                readline_interface.close();
                const parsed_number = Number.parseInt(answer.trim(), 10);
                if (Number.isNaN(parsed_number) || parsed_number < 1 || parsed_number > options.length) {
                    resolve(null);
                    return;
                }
                resolve(parsed_number - 1);
            });
        });
    }
}

/**
 * Single TTY-detection site in the project (aside from the pre-existing
 * gate in `cli.ts`'s `build_orphan_branch_confirm`). Returns a real
 * `Readline_Prompter` when stdin is a terminal, `null` otherwise. CLI
 * action handlers call this once and thread the result through every
 * downstream prompt site.
 */
export function resolve_runtime_prompter(): Prompter | null {
    return process.stdin.isTTY ? new Readline_Prompter() : null;
}
