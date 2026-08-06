// Test seam for prompt-driven library code. Builds a `Prompter` from a
// queue of pre-canned answers OR a function that produces answers on
// demand. Tests pass the result into any library function that accepts
// `Prompter | null`, then assert on the policy function's return value
// and side effects.
//
// Exhaustion (queue runs dry) throws `Prompter_Exhausted` so the test
// fails with a clear "you expected N prompts but got N+1" signal instead
// of silently returning a wrong default. Policy functions do NOT catch
// the throw — the propagation IS the signal.

import type { Prompter } from '../../src/prompts.js';

export class Prompter_Exhausted extends Error {
    public constructor(method: 'confirm' | 'choose', call_index: number) {
        super(
            `Fake_Prompter ran out of answers: ${method} call #${call_index + 1} `
            + 'had no queued or computed answer. Either the test under-counted '
            + 'the expected prompts, or the policy function under test issued '
            + 'an extra prompt that signals a behavior change.',
        );
        this.name = 'Prompter_Exhausted';
    }
}

export interface Fake_Prompter_Answers {
    /**
     * Queue of booleans consumed in order, OR a function called with each
     * prompt's message. Exhaustion (queue empty / function absent for the
     * call) throws `Prompter_Exhausted`. If omitted entirely, every
     * `confirm` call is treated as exhaustion.
     */
    confirm?: boolean[] | ((message: string) => boolean);
    /**
     * Queue of indices (each value must be `null` or an integer in
     * `[0, options.length)`) consumed in order, OR a function called with
     * each prompt's `(message, options)`. Same exhaustion semantics as
     * `confirm`.
     */
    choose?: (number | null)[] | ((message: string, options: string[]) => number | null);
}

export function make_fake_prompter(answers: Fake_Prompter_Answers): Prompter {
    const confirm_source = answers.confirm;
    const choose_source = answers.choose;
    let confirm_index = 0;
    let choose_index = 0;

    // `async` rather than `(): Promise<…> => { throw … }` so exhaustion
    // surfaces as a rejected promise (not a synchronous throw). Library
    // policy functions `await` these calls, so a sync throw would surface
    // BEFORE the await point and behave differently from a real readline
    // I/O error — which is exactly the regression mode the propagation
    // policy is meant to catch.
    // The spec for `Prompter.choose` (interactive-prompter spec, "choose
    // implementations normalize out-of-range input") promises every
    // implementation either returns `null` or an integer in
    // `[0, options.length)`. `Readline_Prompter` enforces that at parse
    // time. The fake enforces it at consumption time — a test that queues
    // `99` is asserting a contract the production code would never
    // produce, so we surface that as a test bug rather than silently
    // letting `candidates[99]` flow into the policy function.
    function normalize_choose(raw: number | null, options: string[]): number | null {
        if (raw === null) {
            return null;
        }
        if (!Number.isInteger(raw) || raw < 0 || raw >= options.length) {
            throw new Error(
                `Fake_Prompter.choose violates spec contract: queued value ${raw} `
                + `is not null and not an integer in [0, ${options.length}). The spec `
                + 'requires every Prompter.choose implementation to normalize out-of-'
                + 'range input to null — use null in the queue to model that case.',
            );
        }
        return raw;
    }

    return {
        confirm: async (message: string): Promise<boolean> => {
            if (Array.isArray(confirm_source)) {
                if (confirm_index >= confirm_source.length) {
                    throw new Prompter_Exhausted('confirm', confirm_index);
                }
                const answer = confirm_source[confirm_index];
                confirm_index += 1;

                return answer;
            }
            if (typeof confirm_source === 'function') {
                const answer = confirm_source(message);
                confirm_index += 1;

                return answer;
            }
            throw new Prompter_Exhausted('confirm', confirm_index);
        },
        choose: async (message: string, options: string[]): Promise<number | null> => {
            if (Array.isArray(choose_source)) {
                if (choose_index >= choose_source.length) {
                    throw new Prompter_Exhausted('choose', choose_index);
                }
                const answer = choose_source[choose_index];
                choose_index += 1;

                return normalize_choose(answer, options);
            }
            if (typeof choose_source === 'function') {
                const answer = choose_source(message, options);
                choose_index += 1;

                return normalize_choose(answer, options);
            }
            throw new Prompter_Exhausted('choose', choose_index);
        },
    };
}
