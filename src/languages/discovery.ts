import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { logger } from '../logger.js';
import { register_language_detector } from './registry.js';
import { parse_language_manifest } from './manifest.js';

const MANIFEST_EXTENSIONS = new Set(['.yaml', '.yml']);

/** 64 KiB — same cap as configuration files; well above any realistic language manifest. */
const LANGUAGE_MANIFEST_SIZE_CAP_BYTES = 64 * 1024;

export interface Language_Discovery_Options {
    /** Override `os.homedir()` for tests. A null/empty result yields no manifests. */
    homedir_resolver?: () => string | null;
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

function compare_by_filename(a: fs.Dirent, b: fs.Dirent): number {
    if (a.name < b.name) {
        return -1;
    }

    return (a.name > b.name) ? 1 : 0;
}

/**
 * List language-manifest paths under `~/.patchlab/languages/`, sorted ascending
 * by filename so registration order is deterministic regardless of filesystem
 * enumeration order. Symbolic links to regular `*.yaml`/`*.yml` files are
 * followed; directories and symlinks-to-directories are skipped.
 *
 * Never throws: a missing directory (`ENOENT`) yields `[]` silently, and any
 * other read failure (`EACCES`, `ENOTDIR`, …) is warned and treated as empty —
 * an advisory feature must not break startup.
 */
export function discover_user_global_language_manifest_paths(
    options?: Language_Discovery_Options,
): string[] {
    const home = (options?.homedir_resolver ?? os.homedir)();
    if (!home) {
        return [];
    }
    const directory = path.join(home, '.patchlab', 'languages');

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        logger().warn(`Could not read language-manifest directory ${directory}: ${(error as Error).message}`);
        return [];
    }

    const manifests = entries.filter((entry) => {
        const candidate = path.join(directory, entry.name);
        const kind = entry.isSymbolicLink() ? safe_stat_kind(candidate) : entry_kind(entry);
        return kind === 'file' && MANIFEST_EXTENSIONS.has(path.extname(entry.name));
    });
    manifests.sort(compare_by_filename);
    return manifests.map((entry) => path.join(directory, entry.name));
}

/**
 * Discover, parse, and register user-global language detectors. Called at
 * module load AFTER the built-ins, so a manifest whose `marker` matches a
 * built-in overrides it (the registry keys on `marker`). Manifests register in
 * alphabetical filename order, so among two manifests sharing a marker the
 * lexicographically-last wins. Read failures and invalid manifests are warned
 * and skipped; neither aborts registration.
 */
export function register_user_global_language_detectors(options?: Language_Discovery_Options): void {
    for (const manifest_path of discover_user_global_language_manifest_paths(options)) {
        let stats: fs.Stats;
        try {
            stats = fs.statSync(manifest_path);
        } catch (error) {
            logger().warn(`Skipping language manifest ${manifest_path}: ${(error as Error).message}`);
            continue;
        }

        if (stats.size > LANGUAGE_MANIFEST_SIZE_CAP_BYTES) {
            logger().warn(
                `Skipping language manifest ${manifest_path}: `
                + `file is ${stats.size} bytes, which exceeds the ${LANGUAGE_MANIFEST_SIZE_CAP_BYTES}-byte cap`,
            );
            continue;
        }

        let yaml_text: string;
        try {
            yaml_text = fs.readFileSync(manifest_path, 'utf-8');
        } catch (error) {
            logger().warn(`Skipping language manifest ${manifest_path}: ${(error as Error).message}`);
            continue;
        }

        const result = parse_language_manifest(yaml_text, manifest_path);
        if ('reason' in result) {
            logger().warn(`Skipping invalid language manifest ${result.file_path}: ${result.reason}`);
            continue;
        }

        register_language_detector(result);
    }
}