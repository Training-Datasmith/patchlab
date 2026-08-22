import * as fs from 'node:fs';
import * as path from 'node:path';
import { get_repository_root, get_source_prefix, canonical_host_path } from './archive.js';
import type { Source_Specification } from './manifest.js';
import type { Source_Entry } from './overrides.js';

/**
 * Input shape for `resolve_source_inputs`: the raw host path plus an optional
 * explicit `mount_name` from the CLI's `--mount` flag. When `mount_name` is
 * `undefined`, the resolver defaults `mount_name` to the source's
 * `source_prefix`; this default is allowed ONLY for single-repository source sets.
 * Multi-repository source sets require an explicit `mount_name` on every entry.
 */
export interface Source_Input {
    host_path: string;
    mount_name?: string;
}

/**
 * Resolve and validate a set of source-input paths into `Source_Specification` entries.
 *
 * For each input:
 *   - Resolve via `path.resolve` (absolute, normalized — NOT realpath).
 *   - Compute `repository_root` via `get_repository_root` (git rev-parse).
 *   - Compute `source_prefix` via `get_source_prefix` (forward-slash
 *     normalized, trailing slash stripped, `.` and `..` collapsed).
 *   - Set `mount_name` to the explicit override if supplied; otherwise
 *     default to `source_prefix` (single-repository case only).
 *
 * Enforces the source-set validation rules from `sandbox-lifecycle`'s
 * `Create sandbox from source directory` requirement:
 *
 *   1. Multi-repository mount explicitness — when the resolved sources span two or
 *      more distinct `repository_root` values, every source's `mount_name`
 *      MUST be supplied explicitly.
 *   2. Mount-name uniqueness — case-insensitive ASCII fold, GLOBAL across the
 *      patchlab regardless of repository.
 *   3. Empty-mount exclusivity — `""` mount may appear only when it is the
 *      only source.
 *   4. No nested-prefix overlap WITHIN a repository — path-component-aware
 *      and case-insensitive ASCII. `src` vs `src/ui` rejects when both share
 *      a repository; cross-repository nested prefixes are accepted because each repository has
 *      its own prefix namespace.
 *   5. Source-prefix uniqueness WITHIN a repository — case-insensitive ASCII
 *      fold. Sources in different repositories MAY share a `source_prefix`
 *      because the explicit mount-name requirement disambiguates their
 *      container paths.
 *
 * Throws with a clear error naming the offending source(s) on any failure.
 */
export function resolve_source_inputs(
    primary: Source_Input | string,
    additional: (Source_Input | string)[],
): Source_Specification[] {
    const all_inputs: Source_Input[] = [
        normalize_input(primary),
        ...additional.map(normalize_input),
    ];

    const resolved: Source_Specification[] = all_inputs.map((entry) => {
        const resolved_path = path.resolve(entry.host_path);
        if (!fs.existsSync(resolved_path)) {
            throw new Error(`Source directory not found: ${resolved_path}`);
        }
        const host_path = canonical_host_path(resolved_path);
        if (!fs.statSync(host_path).isDirectory()) {
            throw new Error(`Source path is not a directory: ${host_path}`);
        }
        const repository_root = get_repository_root(host_path);
        const source_prefix = get_source_prefix(repository_root, host_path);
        // Default mount_name to source_prefix for now; the multi-repository
        // explicitness check (below) rejects this default when the source set
        // spans more than one repository. Tracking the "was this an explicit
        // override?" decision via a parallel array makes the check trivial.
        const mount_name = entry.mount_name ?? source_prefix;
        return {
            host_path,
            repository_root,
            source_prefix,
            mount_name,
        };
    });
    const explicit_mount_flags = all_inputs.map((entry) => entry.mount_name !== undefined);

    const input_labels = all_inputs.map((entry) => entry.host_path);
    assert_multi_repository_mount_explicitness(resolved, explicit_mount_flags, input_labels);
    assert_unique_mount_name(resolved, input_labels);
    assert_empty_mount_exclusive(resolved, input_labels);
    assert_unique_source_prefix_within_repository(resolved, input_labels);
    assert_no_nested_prefix_overlap_within_repository(resolved, input_labels);

    return resolved;
}

function normalize_input(value: Source_Input | string): Source_Input {
    return typeof value === 'string' ? { host_path: value } : value;
}

/**
 * Multi-repository mount-name explicitness: when the resolved sources span two or
 * more distinct `repository_root` values, every source's `mount_name` MUST be
 * supplied explicitly (not defaulted from `source_prefix`). The default rule
 * applies ONLY when all sources share one `repository_root` (the single-repository
 * back-compat case).
 */
function assert_multi_repository_mount_explicitness(
    resolved: Source_Specification[],
    explicit_mount_flags: boolean[],
    inputs: string[],
): void {
    const distinct_repositories = new Set(resolved.map((entry) => entry.repository_root));
    if (distinct_repositories.size < 2) {
        return;
    }

    const missing: { source: string; repository: string }[] = [];
    for (let index = 0; index < resolved.length; index++) {
        if (!explicit_mount_flags[index]) {
            missing.push({
                source: inputs[index],
                repository: resolved[index].repository_root,
            });
        }
    }
    if (missing.length === 0) {
        return;
    }

    const repositories = [...distinct_repositories].join(', ');
    const sources_list = missing
        .map(({ source, repository }) => `  - source ${JSON.stringify(source)} (in ${repository})`)
        .join('\n');
    throw new Error(
        `Sources span multiple git repositories (${repositories}). `
        + `When a patchlab spans more than one repository, every source MUST be `
        + `supplied with an explicit --mount <name> flag. Sources missing --mount:\n`
        + sources_list,
    );
}

/**
 * Mount-name uniqueness: case-insensitive ASCII fold. Operates GLOBALLY across
 * the patchlab regardless of which repository each source belongs to — two
 * sources in different repositories with the same `mount_name` would land at
 * the same container path under `${HOME}/workspace/`.
 */
function assert_unique_mount_name(resolved: Source_Specification[], inputs: string[]): void {
    const seen = new Map<string, number>();
    for (let index = 0; index < resolved.length; index++) {
        const key = case_fold_ascii(resolved[index].mount_name);
        const earlier = seen.get(key);
        if (earlier !== undefined) {
            throw new Error(
                `Sources "${inputs[earlier]}" and "${inputs[index]}" both resolve to mount_name `
                + `${JSON.stringify(resolved[earlier].mount_name)}. Mount names must be unique `
                + `across the patchlab (case-insensitive ASCII), regardless of which repository `
                + `each source belongs to.`,
            );
        }
        seen.set(key, index);
    }
}

function assert_empty_mount_exclusive(resolved: Source_Specification[], inputs: string[]): void {
    const empty_indices: number[] = [];
    for (let index = 0; index < resolved.length; index++) {
        if (resolved[index].mount_name === '') {
            empty_indices.push(index);
        }
    }
    if (empty_indices.length === 0 || resolved.length === 1) {
        return;
    }

    const other = empty_indices[0] === 0 ? 1 : 0;
    throw new Error(
        `Source "${inputs[empty_indices[0]]}" has empty mount_name; `
        + `it cannot be combined with other sources because the empty mount would shadow every `
        + `sibling at \${HOME}/workspace/. (Conflicting source: "${inputs[other]}".)`,
    );
}

/**
 * Source-prefix uniqueness WITHIN a repository — case-insensitive ASCII fold.
 * Two sources in the SAME repository with the same `source_prefix` resolve to the
 * same host path and the same patchlab branch content; cross-repository same-prefix
 * is allowed because the explicit `mount_name` requirement keeps container
 * paths distinct.
 */
function assert_unique_source_prefix_within_repository(
    resolved: Source_Specification[],
    inputs: string[],
): void {
    const seen = new Map<string, number>();
    for (let index = 0; index < resolved.length; index++) {
        const key = resolved[index].repository_root + '\0' + case_fold_ascii(resolved[index].source_prefix);
        const earlier = seen.get(key);
        if (earlier !== undefined) {
            throw new Error(
                `Sources "${inputs[earlier]}" and "${inputs[index]}" both resolve to source_prefix `
                + `${JSON.stringify(resolved[earlier].source_prefix)} within repository `
                + `${resolved[earlier].repository_root}. Source prefixes must be unique within a `
                + `repository (case-insensitive ASCII).`,
            );
        }
        seen.set(key, index);
    }
}

function is_strict_prefix(shorter: string[], longer: string[]): boolean {
    for (let k = 0; k < shorter.length; k++) {
        if (shorter[k] !== longer[k]) {
            return false;
        }
    }

    return true;
}

/**
 * Nested-prefix overlap WITHIN a repository: path-component-aware AND
 * case-insensitive ASCII. Split each `source_prefix` by `/`, lowercase each
 * component, then reject if one's component list is a strict prefix of
 * another's WITHIN the same repository. Cross-repository nested prefixes are
 * accepted — different repos have independent prefix namespaces.
 */
function assert_no_nested_prefix_overlap_within_repository(
    resolved: Source_Specification[],
    inputs: string[],
): void {
    const components: string[][] = resolved.map((entry) =>
        entry.source_prefix === ''
            ? []
            : entry.source_prefix.split('/').map(case_fold_ascii),
    );
    for (let i = 0; i < components.length; i++) {
        for (let j = i + 1; j < components.length; j++) {
            assert_prefix_pair_no_overlap(resolved, inputs, components, i, j);
        }
    }
}

/**
 * Reject a single source pair when one's path-component prefix list is a strict
 * prefix of the other's WITHIN the same repository — including the empty-prefix
 * "root shadows every sibling" special case. Cross-repository pairs are skipped
 * (independent prefix namespaces). Extracted from
 * `assert_no_nested_prefix_overlap_within_repository` to keep that orchestrator's
 * double loop inside the cognitive-complexity threshold.
 */
function assert_prefix_pair_no_overlap(
    resolved: Source_Specification[],
    inputs: string[],
    components: string[][],
    first_index: number,
    second_index: number,
): void {
    if (resolved[first_index].repository_root !== resolved[second_index].repository_root) {
        return;
    }

    const left = components[first_index];
    const right = components[second_index];
    if (left.length === right.length) {
        return;
    }

    const [shorter_index, longer_index, shorter, longer] = left.length < right.length
        ? [first_index, second_index, left, right]
        : [second_index, first_index, right, left];
    if (shorter.length === 0) {
        // Empty-prefix case: a source at the repository root cannot coexist
        // with other sources in the SAME repository (would shadow every
        // sibling). Mount-name uniqueness is the cross-repository lattice;
        // this is the within-repository special case.
        throw new Error(
            `Source "${inputs[shorter_index]}" IS the root of ${resolved[shorter_index].repository_root} `
            + `(source_prefix === ""); it cannot be combined with other sources in the same repository `
            + `because the empty prefix would shadow every sibling. `
            + `(Conflicting source: "${inputs[longer_index]}".)`,
        );
    }
    if (is_strict_prefix(shorter, longer)) {
        throw new Error(
            `Source "${inputs[shorter_index]}" (source_prefix ${JSON.stringify(resolved[shorter_index].source_prefix)}) `
            + `is a path-component prefix of source "${inputs[longer_index]}" (source_prefix ${JSON.stringify(resolved[longer_index].source_prefix)}) `
            + `within repository ${resolved[shorter_index].repository_root}. `
            + `Nested-prefix overlap is not supported within a repository — one source would shadow the other.`,
        );
    }
}

/**
 * Expand the `sources` array from `.patchlab.json` into `Source_Input[]`
 * ready to pass directly to `resolve_source_inputs`.
 *
 * - **String entries**: `host_path` is resolved relative to `base_directory`
 *   (the directory containing the `.patchlab.json`); `mount_name` is the
 *   entry string itself, normalized to forward slashes and stripped of any
 *   trailing slash. This makes the mount name explicit (not `undefined`), so
 *   string entries satisfy the multi-repository mount-determinacy rule without
 *   requiring a `--mount` flag.
 *
 * - **Object entries** `{ path, mount }`: `host_path` resolves `path` relative
 *   to `base_directory`; `mount_name` is `mount` verbatim.
 *
 * All returned entries have `mount_name` set (never `undefined`).
 */
export function expand_manifest_sources(
    entries: Source_Entry[],
    base_directory: string,
): Source_Input[] {
    return entries.map((entry) => {
        if (typeof entry === 'string') {
            return {
                host_path: path.resolve(base_directory, entry),
                mount_name: normalize_manifest_mount_name(entry),
            };
        }
        return {
            host_path: path.resolve(base_directory, entry.path),
            mount_name: entry.mount,
        };
    });
}

/**
 * Convert a manifest source string to a mount name: replace any backslashes
 * with forward slashes (consistent with `source_prefix` format) and strip any
 * trailing slash.
 */
function normalize_manifest_mount_name(entry: string): string {
    return entry.replaceAll('\\', '/').replace(/\/$/, '');
}

function case_fold_ascii(value: string): string {
    let result = '';
    for (let index = 0; index < value.length; index++) {
        const code = value.codePointAt(index);
        if (code === undefined || code < 0x41 || code > 0x5a) {
            result += value[index];
        } else {
            result += String.fromCodePoint(code + 0x20);
        }
    }

    return result;
}
