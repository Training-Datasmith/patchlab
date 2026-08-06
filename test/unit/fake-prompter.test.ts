// Unit tests for the `Fake_Prompter` test helper itself. The helper is the
// foundation for every prompt-driven library test, so its queue/function/
// exhaustion semantics need their own focused coverage — a regression here
// would silently re-shape every downstream test's behavior.

import { describe, it, expect } from 'vitest';
import { make_fake_prompter, Prompter_Exhausted } from '../helpers/fake_prompter.js';

describe('make_fake_prompter — queue mode', () => {
    it('consumes confirm answers in order', async () => {
        const prompter = make_fake_prompter({ confirm: [true, false, true] });
        expect(await prompter.confirm('first?')).toBe(true);
        expect(await prompter.confirm('second?')).toBe(false);
        expect(await prompter.confirm('third?')).toBe(true);
    });

    it('consumes choose answers in order', async () => {
        const prompter = make_fake_prompter({ choose: [1, null, 0] });
        expect(await prompter.choose('first?', ['a', 'b'])).toBe(1);
        expect(await prompter.choose('second?', ['x', 'y'])).toBeNull();
        expect(await prompter.choose('third?', ['p', 'q'])).toBe(0);
    });

    it('keeps confirm and choose queues independent', async () => {
        const prompter = make_fake_prompter({
            confirm: [true],
            choose: [0],
        });
        // Order doesn't matter — each queue advances on its own.
        expect(await prompter.choose('pick', ['only'])).toBe(0);
        expect(await prompter.confirm('go?')).toBe(true);
    });
});

describe('make_fake_prompter — function mode', () => {
    it('confirms via a content-dependent function', async () => {
        const prompter = make_fake_prompter({
            confirm: (message: string) => message.includes('safe'),
        });
        expect(await prompter.confirm('safe operation?')).toBe(true);
        expect(await prompter.confirm('destructive operation?')).toBe(false);
    });

    it('chooses via a content-dependent function', async () => {
        // Real-world `choose` callers either pick a valid index OR signal
        // "no match" with null — the spec forbids out-of-range values
        // leaking through (enforced by `normalize_choose` in the helper).
        // The function-mode wrapper here mirrors that: collapse
        // `indexOf === -1` to `null` before returning.
        const prompter = make_fake_prompter({
            choose: (_message: string, options: string[]) => {
                const index = options.indexOf('target');
                return index === -1 ? null : index;
            },
        });
        expect(await prompter.choose('pick', ['noise', 'target', 'other'])).toBe(1);
        expect(await prompter.choose('pick', ['only-noise'])).toBeNull();
    });
});

describe('make_fake_prompter — choose normalization (spec contract)', () => {
    // The interactive-prompter spec requires every `Prompter.choose`
    // implementation to return either `null` or an integer in
    // `[0, options.length)`. `Readline_Prompter` enforces this at parse
    // time; the fake enforces it on the way out so a test that queues an
    // out-of-range value surfaces as a clear failure instead of letting
    // `candidates[bad_index]` flow into the policy function under test.

    it('throws when a queued value is negative', async () => {
        const prompter = make_fake_prompter({ choose: [-1] });
        await expect(prompter.choose('pick', ['a', 'b'])).rejects.toThrow(/spec contract/);
    });

    it('throws when a queued value equals options.length (off-by-one)', async () => {
        const prompter = make_fake_prompter({ choose: [2] });
        await expect(prompter.choose('pick', ['a', 'b'])).rejects.toThrow(/spec contract/);
    });

    it('throws when a queued value exceeds options.length', async () => {
        const prompter = make_fake_prompter({ choose: [99] });
        await expect(prompter.choose('pick', ['a', 'b'])).rejects.toThrow(/spec contract/);
    });

    it('throws when function-mode returns an out-of-range index', async () => {
        const prompter = make_fake_prompter({
            choose: () => 5,
        });
        await expect(prompter.choose('pick', ['a', 'b'])).rejects.toThrow(/spec contract/);
    });

    it('allows null through (the documented "no selection" signal)', async () => {
        const prompter = make_fake_prompter({ choose: [null] });
        expect(await prompter.choose('pick', ['a', 'b'])).toBeNull();
    });

    it('allows valid in-range indices through', async () => {
        const prompter = make_fake_prompter({ choose: [0, 1, 2] });
        expect(await prompter.choose('pick', ['a', 'b', 'c'])).toBe(0);
        expect(await prompter.choose('pick', ['a', 'b', 'c'])).toBe(1);
        expect(await prompter.choose('pick', ['a', 'b', 'c'])).toBe(2);
    });
});

describe('make_fake_prompter — exhaustion', () => {
    it('throws Prompter_Exhausted when the confirm queue runs dry', async () => {
        const prompter = make_fake_prompter({ confirm: [true] });
        await prompter.confirm('first?');
        await expect(prompter.confirm('second?')).rejects.toThrow(Prompter_Exhausted);
    });

    it('throws Prompter_Exhausted when the choose queue runs dry', async () => {
        const prompter = make_fake_prompter({ choose: [0] });
        await prompter.choose('first', ['a']);
        await expect(prompter.choose('second', ['b'])).rejects.toThrow(Prompter_Exhausted);
    });

    it('exhaustion message names the confirm method and 1-based call index', async () => {
        const prompter = make_fake_prompter({ confirm: [true] });
        await prompter.confirm('first?');
        await expect(prompter.confirm('second?')).rejects.toThrow(/confirm call #2/);
    });

    it('exhaustion message names the choose method and 1-based call index', async () => {
        const prompter = make_fake_prompter({ choose: [0, 1] });
        await prompter.choose('first', ['a', 'b']);
        await prompter.choose('second', ['a', 'b']);
        await expect(prompter.choose('third', ['a', 'b'])).rejects.toThrow(/choose call #3/);
    });

    it('throws Prompter_Exhausted when no confirm answers were supplied at all', async () => {
        const prompter = make_fake_prompter({});
        await expect(prompter.confirm('any?')).rejects.toThrow(Prompter_Exhausted);
    });

    it('throws Prompter_Exhausted when no choose answers were supplied at all', async () => {
        const prompter = make_fake_prompter({});
        await expect(prompter.choose('any?', ['a'])).rejects.toThrow(Prompter_Exhausted);
    });
});
