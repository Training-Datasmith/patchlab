/**
 * Manifest discovery and read helpers for the configured tool-provider
 * subsystem.
 *
 * `discover_*_manifest_paths` enumerate manifest files under their respective
 * scope directories. `read_and_parse_manifest` and `parse_manifest_from_buffer`
 * combine the discovery output with `parse_manifest` to produce typed
 * manifests (or per-file `Manifest_Parse_Error`).
 *
 * The shared-buffer entry point (`parse_manifest_from_buffer` +
 * `read_per_source_manifest_buffers`) closes the TOCTOU gap between the trust
 * hash and the parsed manifest — both reads pin to the same bytes.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse_manifest, type Parse_Manifest_Options } from './parse.js';
import type {
    Configured_Tool_Provider_Manifest,
    Manifest_Parse_Error,
} from './types.js';

const MANIFEST_EXTENSIONS = new Set(['.yaml', '.yml']);

/**
 * List manifest paths under `~/.patchlab/tools/` (user-global scope). Returns
 * an empty array if the directory does not exist. Does NOT parse or load —
 * the caller pairs this with `parse_manifest` for each path.
 */
export function discover_user_global_manifest_paths(): string[] {
    const directory = path.join(os.homedir(), '.patchlab', 'tools');
    return discover_manifest_paths(directory);
}

/**
 * List manifest paths under `<repository_root>/.patchlab/tools/` (per-source
 * scope; semantically per-repository under the single-repository invariant).
 * Returns an empty array if the directory does not exist.
 */
export function discover_per_source_manifest_paths(repository_root: string): string[] {
    const directory = path.join(repository_root, '.patchlab', 'tools');
    return discover_manifest_paths(directory);
}

function discover_manifest_paths(directory: string): string[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }

    const paths: string[] = [];
    for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        // Symlinks to regular files are followed; directory and symlink-to-directory entries are skipped.
        const real_dirent = entry.isSymbolicLink() ? safe_stat_kind(candidate) : entry_kind(entry);
        if (real_dirent !== 'file') {
            continue;
        }

        // Editor-backup files (`.yaml.bak`, `.yaml~`, `.swp`, `.swo`) fail
        // this filter — `path.extname` on those returns `.bak`/`.yaml~`/
        // `.swp`/`.swo`, none of which are in the manifest-extension set.
        const extension = path.extname(entry.name);
        if (!MANIFEST_EXTENSIONS.has(extension)) {
            continue;
        }
        paths.push(candidate);
    }
    return paths;
}

function entry_kind(entry: fs.Dirent): 'file' | 'directory' | 'other' {
    if (entry.isFile()) {
        return 'file';
    }

    return entry.isDirectory() ? 'directory' : 'other';
}

function safe_stat_kind(target_path: string): 'file' | 'directory' | 'other' {
    try {
        const stats = fs.statSync(target_path);
        if (stats.isFile()) {
            return 'file';
        }
        if (stats.isDirectory()) {
            return 'directory';
        }
    } catch (_unreadable_or_broken_symlink) {
        // Broken symlink or unreadable target — skip.
    }

    return 'other';
}

/**
 * Read a manifest file from disk and parse it. Filesystem hazards (EACCES,
 * invalid UTF-8) produce per-file `Manifest_Parse_Error` rather than throwing,
 * so a bad file in a scope does not abort discovery for the rest.
 */
export function read_and_parse_manifest(
    manifest_path: string,
    options?: Parse_Manifest_Options
): Configured_Tool_Provider_Manifest | Manifest_Parse_Error {
    let buffer: Buffer;
    try {
        buffer = fs.readFileSync(manifest_path);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return (code === 'EACCES' || code === 'EPERM')
            ? {
                manifest_path,
                field_path: '',
                reason: `cannot read manifest: ${(error as Error).message}`,
            }
            : {
            manifest_path,
            field_path: '',
            reason: error instanceof Error ? error.message : String(error),
        };
    }

    return parse_manifest_from_buffer(buffer, manifest_path, options);
}

/**
 * Parse a manifest from a pre-read buffer. The shared-buffer entry point used
 * by per-source registration: the caller reads each manifest file ONCE into a
 * buffer, then passes the same buffer to this parser and to
 * `compute_trusted_manifests_hash` so the bytes the user trusts (via the hash)
 * are byte-identical to the bytes that get parsed and dispatched. Pinning
 * both reads to one filesystem call closes the time-of-check vs time-of-use
 * gap that would otherwise open between hash and parse.
 */
export function parse_manifest_from_buffer(
    buffer: Buffer,
    manifest_path: string,
    options?: Parse_Manifest_Options,
): Configured_Tool_Provider_Manifest | Manifest_Parse_Error {
    let yaml_text: string;
    try {
        // Strict UTF-8 decode — invalid bytes throw rather than silently substitute.
        yaml_text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch (error) {
        return (error instanceof TypeError)
            ? {
                manifest_path,
                field_path: '',
                reason: `manifest is not valid UTF-8: ${error.message}`,
            }
            : {
            manifest_path,
            field_path: '',
            reason: error instanceof Error ? error.message : String(error),
        };
    }

    return parse_manifest(yaml_text, manifest_path, options);
}

/**
 * Read every `*.yaml`/`*.yml` manifest under `<source>/.patchlab/tools/` into
 * an in-memory buffer map. The map is keyed by manifest path (sorted ASCII
 * ascending). Files that fail to open (EACCES, ENOENT, etc.) are omitted; the
 * caller's parser will produce a parse error from a missing entry, or it
 * simply won't see them. Used by per-source registration to pin hash and
 * parse to a single read per file.
 */
export function read_per_source_manifest_buffers(repository_root: string): Map<string, Buffer> {
    const buffers = new Map<string, Buffer>();
    for (const manifest_path of discover_per_source_manifest_paths(repository_root)) {
        try {
            buffers.set(manifest_path, fs.readFileSync(manifest_path));
        } catch (_manifest_read_failed) {
            // Skip unreadable files; the per-source registration's parse step will
            // emit a Manifest_Parse_Error for any path that the discovery layer
            // returned but we couldn't read.
        }
    }

    return buffers;
}
