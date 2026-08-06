/**
 * Low-level field validators for the configured tool-provider manifest parser.
 *
 * `fail()` throws `Manifest_Validation_Error` which the parser converts into a
 * `Manifest_Parse_Error` (with the manifest path injected at catch time, so
 * individual validators only need the field path).
 */
import type { Base_Family } from './types.js';

export const NAME_REGEX = /^[a-z0-9-]+$/;
export const SINGLE_PATH_COMPONENT_DISALLOWED = /[/\\\0]/;
export const POSIX_RESERVED_CHAR_REGEX = /[\x00-\x1f]/;
export const WINDOWS_DRIVE_LETTER_REGEX = /^[A-Za-z]:[\\/]/;

/**
 * Explicit string comparator matching the default `Array.prototype.sort()`
 * UTF-16 code-unit order. Used wherever a sort feeds a hash computation —
 * `compute_trusted_manifests_hash` and `canonical_stringify` — so the
 * ordering stays byte-exact and existing hashes (trust markers, manifest
 * hashes) remain valid.
 */
export function compare_by_code_unit_order(a: string, b: string): number {
    if (a < b) {
        return -1;
    }

    return (a > b) ? 1 : 0;
}

export class Manifest_Validation_Error extends Error {
    field_path: string;
    constructor(field_path: string, reason: string) {
        super(reason);
        this.field_path = field_path;
        this.name = 'Manifest_Validation_Error';
    }
}

export function fail(field_path: string, reason: string): never {
    throw new Manifest_Validation_Error(field_path, reason);
}

// --- Field validators ------------------------------------------------------

export function validate_string_non_empty(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        fail(field, `must be a string; got ${typeof value}`);
    }

    if (value.trim() === '') {
        fail(field, 'must contain at least one non-whitespace character');
    }

    return value;
}

/**
 * Validate `base_image` — a Docker image reference rendered as `FROM ${value}`.
 * A reference legitimately contains `:`, `/`, `@`, `.`, `-` (registry, tag,
 * digest), so an allowlist would over-reject; instead reject only newlines and
 * ASCII control characters, which a real reference never contains and which
 * would otherwise terminate the `FROM` line and inject a further Dockerfile
 * instruction during `podman build`. Mirrors the ENV-value guard.
 */
export function validate_base_image(value: unknown, field: string = 'base_image'): string {
    const non_empty = validate_string_non_empty(value, field);
    if (POSIX_RESERVED_CHAR_REGEX.test(non_empty)) {
        fail(field, 'must not contain newlines or ASCII control characters');
    }

    return non_empty;
}

export function validate_name(value: unknown, field: string = 'name'): string {
    if (typeof value !== 'string' || !NAME_REGEX.test(value)) {
        fail(field, `must match ${NAME_REGEX.source} (lowercase letters, digits, hyphens); got ${JSON.stringify(value)}`);
    }

    return value;
}

export function validate_simple_path_component(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        fail(field, `must be a string; got ${typeof value}`);
    }

    if (value === '') {
        fail(field, 'must not be empty');
    }

    if (value === '.' || value === '..') {
        fail(field, `must not be a navigation token (${value})`);
    }

    if (value.startsWith('/')) {
        fail(field, 'must not start with /');
    }

    if (SINGLE_PATH_COMPONENT_DISALLOWED.test(value)) {
        fail(field, String.raw`must not contain path separators (/ or \) or null bytes`);
    }

    // A path component is never legitimately a control character, and this value
    // (e.g. image_user) is interpolated into a Dockerfile line; a newline would
    // terminate that directive and inject a further instruction. Mirror the ENV
    // guard. Belt-and-suspenders with the separator check above for null bytes.
    if (POSIX_RESERVED_CHAR_REGEX.test(value)) {
        fail(field, 'must not contain newlines or ASCII control characters');
    }

    if (value.includes('..')) {
        fail(field, 'must not contain ".." segments');
    }

    return value;
}

export function validate_absolute_linux_path(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        fail(field, `must be a string; got ${typeof value}`);
    }

    if (!value.startsWith('/')) {
        fail(field, 'must be an absolute Linux path (start with /)');
    }

    if (POSIX_RESERVED_CHAR_REGEX.test(value)) {
        fail(field, 'must not contain null bytes or ASCII control characters');
    }

    if (value.includes('..')) {
        fail(field, 'must not contain ".." segments');
    }

    return value;
}

export function validate_artifact_name(value: unknown, field: string): string {
    if (typeof value !== 'string') {
        fail(field, `must be a string; got ${typeof value}`);
    }

    if (value === '' || value !== value.trim()) {
        fail(field, 'must be non-empty with no leading/trailing whitespace');
    }

    if (POSIX_RESERVED_CHAR_REGEX.test(value)) {
        fail(field, 'must not contain ASCII control characters');
    }

    return value;
}

export function validate_artifact_type(value: unknown, field: string): 'file' | 'directory' {
    if (value !== 'file' && value !== 'directory') {
        fail(field, `must be exactly 'file' or 'directory'; got ${JSON.stringify(value)}`);
    }
    return value;
}

/**
 * Validate `base_family` from manifest YAML. Returns `'debian'` when absent.
 * Rejects any other value (including coerced types like `1`/`true`).
 */
export function validate_base_family(value: unknown): Base_Family {
    if (value === undefined) {
        return 'debian';
    }

    if (value !== 'debian' && value !== 'alpine' && value !== 'prebuilt') {
        fail('base_family', `must be exactly 'debian', 'alpine', or 'prebuilt'; got ${JSON.stringify(value)}`);
    }

    return value;
}

/**
 * Validate `package_manager` from manifest YAML. When absent, derives the
 * default from `base_family`: `'debian'` → `'apt'`, `'alpine'` → `'apk'`,
 * `'prebuilt'` → `undefined`. When explicit, accepts only `'apt'` or `'apk'`.
 * Rejects `'unknown'`, capitalized variants, and non-string values
 * with a message noting that `'dnf'`/`'unknown'` are deferred pending
 * `src/capabilities.ts` support.
 */
export function validate_package_manager(
    value: unknown,
    base_family: Base_Family
): 'apt' | 'apk' | undefined {
    if (value === undefined) {
        if (base_family === 'debian') {
            return 'apt';
        }

        return (base_family === 'alpine') ? 'apk' : undefined;
    }

    if (value !== 'apt' && value !== 'apk') {
        fail(
            'package_manager',
            `must be exactly 'apt' or 'apk'; got ${JSON.stringify(value)}`
            + ` ('dnf' and 'unknown' are deferred pending src/capabilities.ts support)`,
        );
    }

    return value;
}

export function validate_strict_boolean(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') {
        fail(field, `must be a YAML boolean (true/false); got ${JSON.stringify(value)}`);
    }
    return value;
}

export function reject_null_bytes(value: string, field: string): void {
    if (value.includes('\0')) {
        fail(field, 'resolved value must not contain null bytes');
    }
}
