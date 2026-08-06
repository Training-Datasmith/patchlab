import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';

// node:fs cannot be vi.spyOn'd (the namespace exports are non-configurable),
// so mock the module and keep every function real EXCEPT renameSync, which we
// drive per-test to exercise the Windows-contention retry loop in
// atomic_write_file. Real writeFileSync/unlinkSync/readFileSync let the test
// observe the tempfile and the published target on disk.
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        renameSync: vi.fn(actual.renameSync),
        writeFileSync: vi.fn(actual.writeFileSync),
    };
});

import * as fs from 'node:fs';
import {
    atomic_write_file,
    ATOMIC_WRITE_RENAME_ATTEMPTS_LIMIT,
} from '../../src/safe_filesystem.js';

const actual_fs = await vi.importActual<typeof import('node:fs')>('node:fs');
const actual_rename = actual_fs.renameSync;
const actual_write = actual_fs.writeFileSync;
const mocked_rename = vi.mocked(fs.renameSync);
const mocked_write = vi.mocked(fs.writeFileSync);

function errno(code: string): NodeJS.ErrnoException {
    const error = new Error(`${code}: synthetic`) as NodeJS.ErrnoException;
    error.code = code;
    return error;
}

function leftover_tempfiles(target: string): string[] {
    const base = path.basename(target);
    return fs.readdirSync(path.dirname(target)).filter(
        (entry) => entry.startsWith(`${base}.tmp.`),
    );
}

describe('atomic_write_file rename-retry loop', () => {
    let temporary_directory: string;

    beforeEach(() => {
        mocked_rename.mockReset();
        mocked_rename.mockImplementation(actual_rename);
        mocked_write.mockReset();
        mocked_write.mockImplementation(actual_write);
        temporary_directory = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-atomic-retry-')),
        );
    });

    afterEach(() => {
        fs.rmSync(temporary_directory, { recursive: true, force: true });
    });

    it('retries a transient EPERM/EBUSY rename, then succeeds', () => {
        const target = path.join(temporary_directory, 'contended.json');
        // Fail the first two attempts the way Windows does under concurrent
        // same-target contention, then fall through to the real rename.
        mocked_rename
            .mockImplementationOnce(() => { throw errno('EPERM'); })
            .mockImplementationOnce(() => { throw errno('EBUSY'); });

        atomic_write_file(target, 'ok');

        expect(mocked_rename).toHaveBeenCalledTimes(3);
        expect(fs.readFileSync(target, 'utf-8')).toBe('ok');
        expect(leftover_tempfiles(target)).toEqual([]);
    });

    it('rethrows and removes the tempfile after exhausting the retry budget', () => {
        const target = path.join(temporary_directory, 'doomed.json');
        mocked_rename.mockImplementation(() => { throw errno('EBUSY'); });

        expect(() => atomic_write_file(target, 'x')).toThrow(/EBUSY/);
        // Exactly the full budget of attempts — no more, no fewer.
        expect(mocked_rename).toHaveBeenCalledTimes(ATOMIC_WRITE_RENAME_ATTEMPTS_LIMIT);
        expect(leftover_tempfiles(target)).toEqual([]);
        expect(fs.existsSync(target)).toBe(false);
    });

    it('does NOT retry a non-contention error (ENOENT)', () => {
        const target = path.join(temporary_directory, 'enoent.json');
        mocked_rename.mockImplementation(() => { throw errno('ENOENT'); });

        expect(() => atomic_write_file(target, 'x')).toThrow(/ENOENT/);
        // One attempt only — a non-contention code breaks out of the loop.
        expect(mocked_rename).toHaveBeenCalledTimes(1);
        expect(leftover_tempfiles(target)).toEqual([]);
    });

    it('cleans up the tempfile and rethrows when the WRITE fails (does not rename)', () => {
        const target = path.join(temporary_directory, 'write-fails.json');
        // Mimic a write that fails partway (ENOSPC): some bytes land on disk
        // before the error, leaving a partial tempfile. If cleanup is skipped
        // the orphan survives, so this is what makes the leftover assertion
        // discriminate rather than pass vacuously on a zero-byte non-write.
        mocked_write.mockImplementation((file) => {
            actual_write(file, 'partial');
            throw errno('ENOSPC');
        });

        expect(() => atomic_write_file(target, 'x')).toThrow(/ENOSPC/);
        // Never reached the rename loop, and the partial tempfile was removed.
        expect(mocked_rename).not.toHaveBeenCalled();
        expect(leftover_tempfiles(target)).toEqual([]);
        expect(fs.existsSync(target)).toBe(false);
    });
});
