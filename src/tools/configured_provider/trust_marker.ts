/**
 * Per-source trust marker persistence.
 *
 * Each marker file at `<patchlab-home>/.patchlab/trusted-sources/<sha>.json`
 * stores the manifest-set hash that the user last confirmed for one host
 * repository. `read_trust_marker` returns the stored hash (or null when the
 * marker is missing / unreadable / malformed), and `write_trust_marker`
 * persists a new hash atomically.
 *
 * The split between this module and `trust_verification.ts` is by concern:
 * THIS file is pure filesystem persistence (no prompts, no policy, no async).
 * The verify/prompt pipeline in the sibling module composes these primitives
 * with the TTY-mode gate and the multi-repository fan-out.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { is_plain_object } from '../../json_validators.js';
import { atomic_write_file } from '../../safe_filesystem.js';

/**
 * Base directory for per-source trust markers. Honours `PATCHLAB_HOME`
 * primarily so tests can isolate marker state.
 */
export function trust_marker_directory(): string {
    const override = process.env.PATCHLAB_HOME;
    const home = override === undefined || override === '' ? os.homedir() : override;
    return path.join(home, '.patchlab', 'trusted-sources');
}

function trust_marker_key(repository_root: string): string {
    let realpath_repository: string;
    try {
        realpath_repository = fs.realpathSync(repository_root);
    } catch (_realpath_failed) {
        realpath_repository = path.resolve(repository_root);
    }

    return crypto.createHash('sha256').update(realpath_repository).digest('hex');
}

export function trust_marker_path(repository_root: string): string {
    return path.join(trust_marker_directory(), `${trust_marker_key(repository_root)}.json`);
}

/**
 * Read the trust marker for `repository_root`. Returns the stored
 * `trusted_hash` on success, or `null` when the marker is missing,
 * unreadable, malformed JSON, or missing the required `trusted_hash` field.
 * A corrupt marker is treated as informationally equivalent to "no marker"
 * (per spec scenario "Marker file is invalid or corrupt").
 */
export function read_trust_marker(repository_root: string): string | null {
    const marker_path = trust_marker_path(repository_root);
    let raw: string;
    try {
        raw = fs.readFileSync(marker_path, 'utf-8');
    } catch (_marker_read_failed) {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (_marker_parse_failed) {
        return null;
    }

    if (!is_plain_object(parsed)) {
        return null;
    }

    const candidate = (parsed as { trusted_hash?: unknown }).trusted_hash;
    return typeof candidate === 'string' ? candidate : null;
}

/**
 * Write the trust marker for `repository_root` with the given
 * `trusted_hash`. Creates `~/.patchlab/trusted-sources/` recursively if
 * missing. Includes informational fields (`confirmed_at`, `repository_root`)
 * for diagnostics; only `trusted_hash` is consulted at verify time. Readers
 * accept the legacy `source_path` diagnostic field name for back-compat
 * (the field is purely informational; the load-bearing `trusted_hash` field
 * has not changed).
 */
export function write_trust_marker(repository_root: string, trusted_hash: string): void {
    const marker_directory = trust_marker_directory();
    fs.mkdirSync(marker_directory, { recursive: true });
    const marker_path = trust_marker_path(repository_root);
    let realpath_repository: string;
    try {
        realpath_repository = fs.realpathSync(repository_root);
    } catch (_realpath_failed) {
        realpath_repository = path.resolve(repository_root);
    }

    const body = {
        trusted_hash,
        confirmed_at: new Date().toISOString(),
        repository_root: realpath_repository,
    };
    // Atomic write (see atomic_write_file): a partial-write torn marker would
    // be read as "corrupt" — informationally equivalent to "no marker" — and
    // re-prompt the user, so the tempfile + rename keeps the canonical marker
    // always fully formed even if the host crashes mid-write.
    atomic_write_file(marker_path, JSON.stringify(body, null, 2) + '\n');
}
