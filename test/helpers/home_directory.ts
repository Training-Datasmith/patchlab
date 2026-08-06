// Shared helpers for tests that need a fresh, isolated HOME (and Windows-side
// USERPROFILE) — typically so `~/.patchlab/` resolves into a tempdir rather
// than the developer's real installation. Without this isolation, tests that
// touch paths under `~/.patchlab/` see the developer's actual patchlab state
// and fail with stale archive or credential mismatches.

import { beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Isolated_Home_Handle {
    /**
     * Return the path of the temp HOME directory active for the current
     * test. For `scope: 'each'` this changes between tests; for
     * `scope: 'all'` it's constant for the whole describe block.
     */
    current: () => string;
}

/**
 * Register hooks that redirect `HOME` and `USERPROFILE` to a fresh tempdir,
 * then restore the previous values when the scope ends.
 *
 * - `scope: 'each'` (default): `beforeEach` + `afterEach`. New tempdir per
 *   test. Use this when tests mutate the home directory and need isolation.
 * - `scope: 'all'`: `beforeAll` + `afterAll`. One tempdir shared across the
 *   describe block. Use this when no test mutates the home directory state
 *   (or when the mutations are intentional and isolation-free).
 *
 * Call this at the top of a describe block to scope it to that block; call
 * it at module scope to apply to every test in the file.
 *
 * The returned handle's `current()` accessor yields the active tempdir path.
 * The tempdir path changes between tests under `scope: 'each'`, so callers
 * MUST go through `current()` rather than caching the returned string.
 */
export function install_isolated_home_hooks(
    prefix: string,
    options?: { scope?: 'each' | 'all' },
): Isolated_Home_Handle {
    const scope = options?.scope ?? 'each';
    let home_root = '';
    let original_home: string | undefined;
    let original_userprofile: string | undefined;

    function set_up(): void {
        home_root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
        original_home = process.env.HOME;
        original_userprofile = process.env.USERPROFILE;
        process.env.HOME = home_root;
        process.env.USERPROFILE = home_root;
    }

    function tear_down(): void {
        if (original_home === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = original_home;
        }

        if (original_userprofile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = original_userprofile;
        }

        fs.rmSync(home_root, { recursive: true, force: true });
    }

    if (scope === 'all') {
        beforeAll(set_up);
        afterAll(tear_down);
    } else {
        beforeEach(set_up);
        afterEach(tear_down);
    }

    return { current: () => home_root };
}
