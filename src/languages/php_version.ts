import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { parse_file_as_json } from '../json_validators.js';

/** PHP versions searched from highest to lowest when resolving a Composer constraint. */
export const KNOWN_PHP_VERSIONS = ['8.4', '8.3', '8.2', '8.1', '8.0', '7.4'] as const;

const PHP_BINARY_VERSION_PATTERN = /^PHP (\d+)\.(\d+)\.\d+/;
const LOCK_VERSION_PATTERN = /^(\d+)\.(\d+)(\.\d+)?$/;

/**
 * Return `php:X.Y-cli` if `composer.lock` in `directory` contains a
 * `platform.php` string of the form `major.minor[.patch]`, or `null` when
 * the lock file is absent, malformed, or contains no usable version.
 */
export function resolve_php_version_from_lock(directory: string): string | null {
    const lock_path = path.join(directory, 'composer.lock');
    if (!fs.existsSync(lock_path)) {
        return null;
    }

    let lock: Record<string, unknown>;
    try {
        lock = parse_file_as_json(lock_path) as Record<string, unknown>;
    } catch (_malformed_lock_json) {
        return null;
    }

    const platform = lock.platform;
    if (!platform || typeof platform !== 'object' || Array.isArray(platform)) {
        return null;
    }

    const platform_php = (platform as Record<string, unknown>).php;
    if (typeof platform_php !== 'string') {
        return null;
    }

    const match = LOCK_VERSION_PATTERN.exec(platform_php);
    return match ? `php:${match[1]}.${match[2]}-cli` : null;
}

/**
 * Return `php:X.Y-cli` by shelling out to `php --version` and parsing its
 * output, or `null` when `php` is not on PATH, is not installed, or produces
 * unrecognisable output. Swallows all errors — MUST NOT throw.
 */
export function resolve_php_version_from_host(): string | null {
    try {
        const output = execSync('php --version', {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const match = PHP_BINARY_VERSION_PATTERN.exec(output);

        return match ? `php:${match[1]}.${match[2]}-cli` : null;
    } catch {
        return null;
    }
}

/**
 * Return `php:X.Y-cli` for the highest known PHP version satisfying the
 * `require.php` Composer constraint in `composer.json`, or `null` when the
 * file is absent, malformed, or no known version satisfies the constraint.
 */
function resolve_php_image_from_constraint(directory: string): string | null {
    const composer_path = path.join(directory, 'composer.json');
    if (!fs.existsSync(composer_path)) {
        return null;
    }

    let composer: Record<string, unknown>;
    try {
        composer = parse_file_as_json(composer_path) as Record<string, unknown>;
    } catch (_malformed_composer_json) {
        return null;
    }

    const require_section = composer.require;
    if (!require_section || typeof require_section !== 'object' || Array.isArray(require_section)) {
        return null;
    }

    const constraint = (require_section as Record<string, unknown>).php;
    if (!constraint || typeof constraint !== 'string') {
        return null;
    }

    for (const version of KNOWN_PHP_VERSIONS) {
        if (satisfies_php_constraint(version, constraint)) {
            return `php:${version}-cli`;
        }
    }

    return null;
}

/**
 * Return `php:X.Y-cli` using a four-level priority chain:
 *   1. `composer.lock` `platform.php` field (read from disk regardless of git status)
 *   2. Host `php --version` output
 *   3. `composer.json` `require.php` constraint (max satisfying known version)
 *   4. null (caller falls back to `default_image`)
 */
export function resolve_php_image(directory: string): string | null {
    return resolve_php_version_from_lock(directory)
        ?? resolve_php_version_from_host()
        ?? resolve_php_image_from_constraint(directory);
}

/**
 * Return true if `version` (e.g. `'8.3'`) satisfies `constraint` (e.g.
 * `'^8.2'`, `'>=8.1 <9.0'`, `'7.4 || ^8.0'`).
 *
 * Handles OR (`|`, `||`), AND (space or comma), caret (`^`), tilde (`~`),
 * comparison operators (`>=`, `>`, `<=`, `<`), wildcards (`8.2.*`), and
 * exact version strings. Unknown operators are treated as satisfied so an
 * unrecognised constraint never silently blocks detection.
 */
export function satisfies_php_constraint(version: string, constraint: string): boolean {
    if (constraint.includes('|')) {
        return constraint.split(/\|\|?/).some((part) => satisfies_group(version, part.trim()));
    }
    return satisfies_group(version, constraint.trim());
}

function satisfies_group(version: string, group: string): boolean {
    return group.split(/\s*,\s*|\s+/).filter(Boolean).every((part) => satisfies_part(version, part));
}

function same_major_at_least(major: number, minor: number, a: number, b: number): boolean {
    return major === a && minor >= b;
}

function same_major_and_minor(major: number, minor: number, a: number, b: number): boolean {
    return major === a && minor === b;
}

function version_gte(major: number, minor: number, a: number, b: number): boolean {
    return major > a || (major === a && minor >= b);
}

function version_gt(major: number, minor: number, a: number, b: number): boolean {
    return major > a || (major === a && minor > b);
}

function version_lte(major: number, minor: number, a: number, b: number): boolean {
    return major < a || (major === a && minor <= b);
}

function version_lt(major: number, minor: number, a: number, b: number): boolean {
    return major < a || (major === a && minor < b);
}

function satisfies_part(version: string, part: string): boolean {
    const [major, minor] = version.split('.').map(Number);
    let match: RegExpExecArray | null = null;

    if ((match = /^\^(\d+)\.(\d+)/.exec(part)) !== null) {
        return same_major_at_least(major, minor, Number(match[1]), Number(match[2]));
    }
    if ((match = /^\^(\d+)$/.exec(part)) !== null) {
        return major === Number(match[1]);
    }
    if ((match = /^~(\d+)\.(\d+)/.exec(part)) !== null) {
        return same_major_at_least(major, minor, Number(match[1]), Number(match[2]));
    }
    if ((match = /^~(\d+)$/.exec(part)) !== null) {
        return major === Number(match[1]);
    }
    if ((match = /^>=(\d+)\.(\d+)/.exec(part)) !== null) {
        return version_gte(major, minor, Number(match[1]), Number(match[2]));
    }
    if ((match = /^>=(\d+)$/.exec(part)) !== null) {
        return major >= Number(match[1]);
    }
    if ((match = /^>(\d+)\.(\d+)/.exec(part)) !== null) {
        return version_gt(major, minor, Number(match[1]), Number(match[2]));
    }
    if ((match = /^>(\d+)$/.exec(part)) !== null) {
        return major > Number(match[1]);
    }
    if ((match = /^<=(\d+)\.(\d+)/.exec(part)) !== null) {
        return version_lte(major, minor, Number(match[1]), Number(match[2]));
    }
    if ((match = /^<=(\d+)$/.exec(part)) !== null) {
        return major <= Number(match[1]);
    }
    if ((match = /^<(\d+)\.(\d+)/.exec(part)) !== null) {
        return version_lt(major, minor, Number(match[1]), Number(match[2]));
    }
    if ((match = /^<(\d+)$/.exec(part)) !== null) {
        return major < Number(match[1]);
    }
    if ((match = /^(\d+)\.(\d+)\.\*/.exec(part)) !== null) {
        return same_major_and_minor(major, minor, Number(match[1]), Number(match[2]));
    }
    if ((match = /^(\d+)\.(\d+)/.exec(part)) !== null) {
        return same_major_and_minor(major, minor, Number(match[1]), Number(match[2]));
    }

    return true;
}
