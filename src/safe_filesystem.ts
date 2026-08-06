import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { logger } from './logger.js';

/**
 * Tolerate ENOENT (`already gone, fine`) silently while surfacing any other
 * filesystem error — EACCES, EBUSY (Windows file lock), EISDIR — via a
 * warning so a real problem is not hidden inside a "cleanup" catch. Always
 * returns normally; callers in `finally` blocks rely on this so the helper
 * cannot mask an outer exception by throwing.
 */
export function safe_unlink(file: string): void {
    try {
        fs.unlinkSync(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger().warn(error instanceof Error ? error : new Error(String(error)));
        }
    }
}

/**
 * Total rename attempts (including the first) before `atomic_write_file` gives
 * up and rethrows. Exported so the retry-loop test pins the exact count against
 * this single source of truth rather than a duplicated literal.
 */
export const ATOMIC_WRITE_RENAME_ATTEMPTS_LIMIT = 5;

/**
 * Sleep synchronously for the given milliseconds without a busy spin. Used to
 * back off between rename retries; `Atomics.wait` blocks the thread and returns
 * once the timeout elapses (the watched value never changes).
 */
function sleep_synchronously(milliseconds: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Write `contents` to `file_path` atomically: write a uniquely-named tempfile
 * in the same directory, then rename it onto the target. A reader therefore
 * never observes a partially-written file, and a process crash mid-write
 * leaves the previous file intact.
 *
 * The rename is retried with backoff on `EPERM`/`EACCES`/`EBUSY`: on Windows
 * the destination is briefly locked under concurrent same-target contention
 * (which otherwise drops ~33% of writes — see the windows-renameSync-race
 * note), and those codes clear within milliseconds. Any other error, or
 * exhausting the retries, removes the tempfile and rethrows. The tempfile name
 * carries both `<pid>` and a per-write random tag so two writes from the same
 * process OR two concurrent processes never collide on the tempfile path.
 */
export function atomic_write_file(file_path: string, contents: string | Uint8Array): void {
    const temporary_path = `${file_path}.tmp.${process.pid}.${crypto.randomUUID().slice(0, 8)}`;
    // No encoding argument: a string defaults to UTF-8 and a Uint8Array is
    // written as raw bytes, so one call serves both text and binary callers.
    // A write failure (ENOSPC, EACCES) can still leave a partial tempfile, so
    // clean it up before rethrowing rather than orphaning it.
    try {
        fs.writeFileSync(temporary_path, contents);
    } catch (write_error) {
        safe_unlink(temporary_path);
        throw write_error;
    }

    let last_error: unknown;
    for (let attempt = 0; attempt < ATOMIC_WRITE_RENAME_ATTEMPTS_LIMIT; attempt++) {
        if (attempt > 0) {
            // Every attempt after the first,
            // back off with an exponentially increasing delay before retrying.
            // On Windows the file lock is released within milliseconds,
            // so this is not a long wait even at the max attempt.
            sleep_synchronously(2 ** attempt);
        }

        try {
            fs.renameSync(temporary_path, file_path);
            return;
        } catch (error) {
            last_error = error;
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') {
                break;
            }
        }
    }

    safe_unlink(temporary_path);
    throw last_error instanceof Error ? last_error : new Error(String(last_error));
}
