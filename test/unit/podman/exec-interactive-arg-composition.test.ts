/**
 * Structural lock for `exec_interactive`. The function uses `stdio: 'inherit'`
 * to attach the user's real TTY to the container, which makes it intrinsically
 * resistant to both unit-level call assertions (would block on stdin) and
 * vitest-driven integration runs (vitest workers have no TTY, so `podman exec
 * -it` fails before the command runs). What we CAN lock down statically: the
 * argv composition. If a future refactor drops `-it`, changes the `-w` flag,
 * or swaps the stdio mode, the assertions below fail loudly.
 *
 * This is the same pattern `test/unit/non-gated-operations.test.ts` uses for
 * src/sandbox/ lifecycle functions whose behavior is hard to reach but whose
 * source-text invariants matter.
 */
import { describe, it, expect } from 'vitest';
import { exec_interactive } from '../../../src/container_runtime.js';

/**
 * Vitest runs sources through Vite's SSR transform, which normalizes single
 * quotes to double quotes in string literals. Match either form so the lock
 * survives an unrelated bundler change.
 */
function contains_quoted(source: string, literal: string): boolean {
    return source.includes(`'${literal}'`) || source.includes(`"${literal}"`);
}

describe('exec_interactive — structural lock on argv composition', () => {
    const source = exec_interactive.toString();

    it('composes `exec [-it] -u <user> -w <cwd> <name> <command...>` via exec_runtime', () => {
        expect(contains_quoted(source, 'exec')).toBe(true);
        expect(contains_quoted(source, '-it')).toBe(true);
        expect(source).toContain('isTTY');
        expect(contains_quoted(source, '-u')).toBe(true);
        expect(source).toContain('container_home_user');
        expect(contains_quoted(source, '-w')).toBe(true);
        expect(source).toContain('exec_runtime');
    });

    it('uses stdio: inherit so the parent TTY drives the container', () => {
        expect(contains_quoted(source, 'inherit')).toBe(true);
    });

    it('falls back to CONTAINER_WORKING_DIR when working_directory is not supplied', () => {
        expect(source).toContain('CONTAINER_WORKING_DIR');
    });
});
