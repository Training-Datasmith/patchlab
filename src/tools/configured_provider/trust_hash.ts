/**
 * Hashing, name-conflict, and warning-formatting helpers shared across the
 * configured-provider trust / dispatch / build pipelines.
 *
 * Three concerns intentionally co-located:
 *   - `compute_trusted_manifests_hash` — SHA-256 over the on-disk bytes of a
 *     per-source `*.yaml`/`*.yml` set, used as the trust marker key.
 *   - `compute_manifest_hash` — 8-char canonical-form hash over a parsed
 *     manifest's image-affecting fields, embedded in derived image tags.
 *   - `format_warning` and `assert_no_within_scope_name_conflicts` — output
 *     and structural checks consumed by registration, parse, and inject paths.
 *
 * All three depend on `compare_by_code_unit_order` for deterministic sort
 * order, so they share a module rather than being pulled apart.
 */
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { compare_by_code_unit_order } from './validators.js';
import type { Configured_Tool_Provider_Manifest } from './types.js';

/**
 * SHA-256 fingerprint of every `*.yaml`/`*.yml` manifest under
 * `<source>/.patchlab/tools/`, sorted by filename ASCII ascending. Each entry
 * contributes its basename, its byte length, and its raw bytes, every field
 * NUL-separated, so the digest binds file BOUNDARIES, not just a concatenated
 * stream. When the buffer map is empty (directory absent / empty), the hash is
 * the SHA-256 of zero bytes — callers treat this case as "no manifests to
 * trust" and skip the trust check entirely.
 *
 * Binding the filename and length closes a same-digest-different-layout gap: a
 * bare `\n`-join (the previous form) let content be shuffled across files, or a
 * file renamed, while producing the same byte stream and reusing a prior "yes".
 * The disclosure the user approves enumerates per-manifest fields, so trust must
 * bind which bytes came from which file. (Changing the hash shape invalidates
 * existing trust markers once: the next interactive run re-prompts, then the new
 * marker sticks.)
 *
 * The hash fingerprints the on-disk bytes, NOT the parsed state. A file that
 * fails to parse, or that parses but fails registration (containment / name
 * collision), STILL participates in the hash so a user's "yes" commits to
 * every byte they were shown — including malformed manifests they may later
 * fix without re-prompting (the hash stays the same when the bytes do).
 *
 * `buffers` MUST be produced by `read_per_source_manifest_buffers` (or an
 * equivalent test stub) and MUST be the same map the registration parser
 * consumes — sharing the buffer is what closes the TOCTOU gap between hash
 * and parse.
 */
export function compute_trusted_manifests_hash(buffers: Map<string, Buffer>): string {
    const sorted_paths = [...buffers.keys()].sort(compare_by_code_unit_order);
    const hash = crypto.createHash('sha256');
    for (const manifest_path of sorted_paths) {
        const buffer = buffers.get(manifest_path) ?? Buffer.alloc(0);
        hash.update(path.basename(manifest_path));
        hash.update('\0');
        hash.update(String(buffer.length));
        hash.update('\0');
        hash.update(buffer);
        hash.update('\0');
    }

    return hash.digest('hex');
}

/**
 * Throws when two parsed manifests in the same scope share a `name`. Caller
 * applies this per-scope after parsing all manifests in a directory.
 */
export function assert_no_within_scope_name_conflicts(
    parsed_manifests: readonly { manifest: Configured_Tool_Provider_Manifest; manifest_path: string }[]
): void {
    const seen = new Map<string, string[]>();
    for (const entry of parsed_manifests) {
        const collisions = seen.get(entry.manifest.name);
        if (collisions) {
            collisions.push(entry.manifest_path);
        } else {
            seen.set(entry.manifest.name, [entry.manifest_path]);
        }
    }

    for (const [name, paths] of seen.entries()) {
        if (paths.length > 1) {
            throw new Error(
                `Manifest name conflict at scope: name "${name}" declared by ${paths.length} manifests: `
                + `${paths.join(', ')}. Rename or remove one to resolve.`
            );
        }
    }
}

/**
 * Compose a standardized warning string. The shared template:
 *
 *   `Warning: <operation> for <provider-name>: <action> <target>: <reason>`
 *
 * Used by parse rejections, escape-symlink rejections, missing-variable
 * warnings, file-copy errors — every configured-provider warning follows the
 * same scaffold so log scrapers and humans can parse them uniformly.
 */
export function format_warning(parameters: {
    operation: string;
    provider_name: string;
    action: string;
    target: string;
    reason: string;
}): string {
    return `Warning: ${parameters.operation} for ${parameters.provider_name}: `
        + `${parameters.action} ${parameters.target}: ${parameters.reason}`;
}

/**
 * Deterministic canonical serialization for the manifest hash. Recursively
 * emits object keys in sorted ASCII order at every nesting level. Arrays
 * preserve their element order (significant for `dockerfile.install`).
 * Output is a single line — no whitespace between tokens, no trailing newline.
 *
 * Does NOT use `JSON.stringify` with a replacer — replacers cannot reorder
 * keys (V8/SpiderMonkey emit them in insertion order regardless of the
 * replacer's return value).
 */
function canonical_stringify(value: unknown): string {
    if (value === null) {
        return 'null';
    }

    if (typeof value === 'string') {
        return JSON.stringify(value);
    }

    if (typeof value === 'number') {
        return JSON.stringify(value);
    }

    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }

    if (Array.isArray(value)) {
        return '[' + value.map(canonical_stringify).join(',') + ']';
    }

    if (typeof value === 'object') {
        const keys = Object.keys(value).sort(compare_by_code_unit_order);
        const parts = keys.map((key) => {
            const inner = (value as Record<string, unknown>)[key];
            return `${JSON.stringify(key)}:${canonical_stringify(inner)}`;
        });
        return '{' + parts.join(',') + '}';
    }

    // undefined / symbol / function — not expected in canonical hash inputs;
    // surface as null so the canonical form is well-formed and the hash is
    // stable across "undefined" and "explicitly null" representations.
    return 'null';
}

/**
 * Compute the 8-char hex content hash for a configured-provider manifest.
 *
 * Participating fields: `base_family`, `base_image`, `configuration_directory_name`,
 * `dockerfile` (both `install` and `environment`), `image_home`, `image_user`,
 * `package_manager`. Other fields (`name`, `display_name`, `authentication`,
 * `launch_command`, `validation`, `extractable_artifacts`, `overrides_builtin`)
 * do not participate — they affect runtime behavior, not the built image.
 *
 * `dockerfile` and `package_manager` are coerced to JSON `null` when absent so
 * an absent field and a literal-null field produce the same hash.
 */
export function compute_manifest_hash(manifest: Configured_Tool_Provider_Manifest): string {
    const input = {
        base_family: manifest.base_family,
        base_image: manifest.base_image,
        configuration_directory_name: manifest.configuration_directory_name,
        dockerfile: manifest.dockerfile ?? null,
        image_home: manifest.image_home,
        image_user: manifest.image_user,
        package_manager: manifest.package_manager ?? null,
    };
    return crypto.createHash('sha256')
        .update(canonical_stringify(input), 'utf8')
        .digest('hex')
        .slice(0, 8);
}
