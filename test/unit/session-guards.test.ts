import { describe, it, expect, vi } from 'vitest';

// Re-export `node:fs` as a plain namespace so its properties are configurable —
// the SUT does `import * as fs from 'node:fs'` and `mkdirSync` is
// non-configurable on Node 22, which makes `vi.spyOn` throw `Cannot redefine
// property`. Spreading `importActual` into a fresh object preserves runtime
// behavior while allowing the non-EEXIST-rethrow test to force a mkdir failure.
vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return { ...actual };
});

import * as fs from 'node:fs';
import {
    build_archive_path,
    build_session_path,
    next_session_number,
} from '../../src/archive.js';
import {
    claim_session_directory,
    claim_session_number_from,
} from '../../src/sandbox/index.js';
import { install_isolated_home_hooks } from '../helpers/home_directory.js';

describe('one-sandbox-per-session guard (6.5)', () => {
    install_isolated_home_hooks('patchlab-claim-home-');
    const patchlab_id = 'pl-claim';

    /**
     * `next_session_number` is the allocator that hands `claim_session_directory`
     * its starting candidate: it must return one past the highest existing
     * numbered directory so a fresh claim never starts on an occupied number.
     */
    it('next_session_number returns one past the highest existing session directory', () => {
        const archive_directory = build_archive_path(patchlab_id);
        fs.mkdirSync(archive_directory, { recursive: true });
        fs.mkdirSync(build_session_path(patchlab_id, 1), { recursive: true });
        expect(next_session_number(patchlab_id)).toBe(2);

        // A second pre-claimed directory bumps the allocation again.
        fs.mkdirSync(build_session_path(patchlab_id, 2), { recursive: true });
        expect(next_session_number(patchlab_id)).toBe(3);
    });

    /**
     * The public entry point composes `next_session_number` with the exclusive
     * mkdir: with session 1 already on disk it must claim and materialize
     * session 2.
     */
    it('claim_session_directory claims and creates the next free session number', () => {
        fs.mkdirSync(build_session_path(patchlab_id, 1), { recursive: true });

        const claimed = claim_session_directory(patchlab_id);

        expect(claimed).toBe(2);
        expect(fs.existsSync(build_session_path(patchlab_id, 2))).toBe(true);
    });

    /**
     * The race-resolution branch: a concurrent winner already holds sessions 2
     * and 3, but this caller read 2 as its starting candidate before the winner
     * committed. The exclusive mkdir must see EEXIST on 2 and 3 and advance to
     * the first genuinely free number (4) — not clobber a sibling session.
     *
     * Driven through `claim_session_number_from` with an injected starting
     * candidate because the public path derives the start from
     * `next_session_number`, which is free by construction, so the EEXIST
     * increment is otherwise unreachable from a single-threaded test.
     */
    it('claim_session_number_from advances past already-claimed numbers (EEXIST race resolution)', () => {
        fs.mkdirSync(build_session_path(patchlab_id, 2), { recursive: true });
        fs.mkdirSync(build_session_path(patchlab_id, 3), { recursive: true });

        const claimed = claim_session_number_from(patchlab_id, 2);

        expect(claimed).toBe(4);
        expect(fs.existsSync(build_session_path(patchlab_id, 4))).toBe(true);
    });

    /**
     * The exhaustion ceiling: when every candidate in the bounded window is
     * already claimed, the loop must give up with a diagnostic rather than spin
     * forever or return an occupied number. Exercised with a small injected
     * attempt limit so the test does not have to pre-create 1024 directories.
     */
    it('claim_session_number_from throws once its attempt limit is exhausted', () => {
        fs.mkdirSync(build_session_path(patchlab_id, 1), { recursive: true });
        fs.mkdirSync(build_session_path(patchlab_id, 2), { recursive: true });

        expect(() => claim_session_number_from(patchlab_id, 1, 2)).toThrow(
            /after 2 attempts \(starting from session 1\)/,
        );
    });

    /**
     * Only EEXIST is a race signal worth retrying; any other mkdir failure
     * (here EACCES) is fatal and must propagate unchanged rather than be
     * mistaken for an occupied number and silently incremented past.
     */
    it('claim_session_number_from rethrows a non-EEXIST mkdir failure unchanged', () => {
        const permission_error = new Error('EACCES: permission denied, mkdir') as NodeJS.ErrnoException;
        permission_error.code = 'EACCES';
        const mkdir_spy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
            throw permission_error;
        });
        try {
            expect(() => claim_session_number_from(patchlab_id, 1)).toThrow(/EACCES/);
        } finally {
            mkdir_spy.mockRestore();
        }
    });
});
