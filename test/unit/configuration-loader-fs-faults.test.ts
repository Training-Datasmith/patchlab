/**
 * Filesystem-fault paths in `load_configuration_file` that the main
 * `configuration-loader.test.ts` cannot reach without mocking. Two sites:
 *
 *   1. `failed to stat ${file_path}` — when `fs.statSync` throws an errno
 *      OTHER than `ENOENT`. ENOENT is the "absent file" happy path; every
 *      other errno (EACCES, EIO, ENOTDIR, …) is a real I/O failure that
 *      must surface as a thrown `Error` so the caller can report it.
 *   2. `failed to read configuration file ${file_path}` — when `statSync`
 *      succeeds (regular file, within the size cap) but `readFileSync`
 *      throws. The race-window is narrow in practice (file deleted or
 *      permission revoked between the two syscalls); a mock is the only
 *      way to drive it reproducibly.
 *
 * Mock pattern mirrors `cgroup-warn-once.test.ts`: `vi.mock('node:fs', ...)`
 * with a mutable handler state. The configuration loader is the only
 * consumer in this file, so the mock doesn't risk affecting unrelated code.
 */
import { describe, it, expect, vi } from 'vitest';

const fs_state: {
    statSync_handler: ((file_path: string) => unknown) | null;
    readFileSync_handler: ((file_path: string) => string) | null;
} = { statSync_handler: null, readFileSync_handler: null };

vi.mock('node:fs', async (importOriginal) => {
    const original = await importOriginal<typeof import('node:fs')>();
    return {
        ...original,
        statSync: (...args: Parameters<typeof original.statSync>) => {
            if (fs_state.statSync_handler !== null) {
                return fs_state.statSync_handler(String(args[0])) as ReturnType<typeof original.statSync>;
            }
            return original.statSync(...args);
        },
        readFileSync: (...args: Parameters<typeof original.readFileSync>) => {
            if (fs_state.readFileSync_handler !== null) {
                return fs_state.readFileSync_handler(String(args[0])) as ReturnType<typeof original.readFileSync>;
            }
            return original.readFileSync(...args);
        },
    };
});

import { load_configuration_file } from '../../src/configuration.js';

function make_errno(code: string, message: string): NodeJS.ErrnoException {
    const error = new Error(message) as NodeJS.ErrnoException;
    error.code = code;
    return error;
}

describe('load_configuration_file — non-ENOENT statSync errno surfaces as "failed to stat"', () => {
    it('EACCES (permission denied) throws a wrapped error naming the file path', () => {
        fs_state.statSync_handler = () => {
            throw make_errno('EACCES', 'permission denied');
        };
        try {
            expect(() => load_configuration_file('/restricted/configuration.yaml')).toThrow(
                /failed to stat \/restricted\/configuration\.yaml/,
            );
        } finally {
            fs_state.statSync_handler = null;
        }
    });

    it('EIO (I/O error) throws a wrapped error preserving the underlying message', () => {
        fs_state.statSync_handler = () => {
            throw make_errno('EIO', 'input/output error');
        };
        try {
            expect(() => load_configuration_file('/some/file.yaml')).toThrow(/input\/output error/);
        } finally {
            fs_state.statSync_handler = null;
        }
    });

    it('non-Error throw value still surfaces via String(error) (defensive fallback)', () => {
        fs_state.statSync_handler = () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw 'unexpected primitive failure';
        };
        try {
            expect(() => load_configuration_file('/file.yaml')).toThrow(/unexpected primitive failure/);
        } finally {
            fs_state.statSync_handler = null;
        }
    });
});

describe('load_configuration_file — readFileSync failure after stat succeeds', () => {
    it('readFileSync throws after a successful stat → "failed to read configuration file"', () => {
        // statSync reports a small regular file so the loader proceeds to read.
        fs_state.statSync_handler = () => ({
            isFile: () => true,
            size: 64,
        });
        // readFileSync then throws — the race-window scenario the wrapper guards.
        fs_state.readFileSync_handler = () => {
            throw make_errno('EACCES', 'permission revoked after stat');
        };
        try {
            expect(() => load_configuration_file('/some/file.yaml')).toThrow(
                /failed to read configuration file \/some\/file\.yaml: permission revoked after stat/,
            );
        } finally {
            fs_state.statSync_handler = null;
            fs_state.readFileSync_handler = null;
        }
    });

    it('readFileSync non-Error throw value still surfaces via String(error)', () => {
        fs_state.statSync_handler = () => ({
            isFile: () => true,
            size: 64,
        });
        fs_state.readFileSync_handler = () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw 12345;
        };
        try {
            expect(() => load_configuration_file('/file.yaml')).toThrow(/failed to read configuration file .*12345/);
        } finally {
            fs_state.statSync_handler = null;
            fs_state.readFileSync_handler = null;
        }
    });
});
