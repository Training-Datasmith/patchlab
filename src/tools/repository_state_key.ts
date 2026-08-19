/**
 * Stable per-repository keys for host-side state stored outside the repository
 * tree (trust markers, default-tool preferences). Both use
 * `sha256(realpath(repository_root))` with `path.resolve` fallback when
 * realpath fails.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * Resolve `repository_root` to the canonical host path used for marker keys.
 */
export function repository_realpath(repository_root: string): string {
    try {
        return fs.realpathSync(repository_root);
    } catch (_realpath_failed) {
        return path.resolve(repository_root);
    }
}

/**
 * SHA-256 hex digest of `repository_realpath(repository_root)`.
 */
export function repository_state_key(repository_root: string): string {
    return crypto.createHash('sha256').update(repository_realpath(repository_root)).digest('hex');
}
