/**
 * `.patchlab.json` read and write. The override file lets a project pin
 * sandbox requirements that detection can't or shouldn't infer: forcing
 * specific system packages, mount paths, environment variables, or npm
 * packages, and opting in to the host podman socket mount. This module
 * owns the on-disk shape — typing it (`Patchlab_Overrides`), parsing and
 * validating it (`load_overrides`), and writing it back atomically
 * (`save_overrides`, `update_overrides`). The combination of detected
 * requirements with the loaded overrides lives in `overrides_merge.ts`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from './logger.js';
import { assert_parsed_object_root, parse_file_as_json } from './json_validators.js';
import { atomic_write_file } from './safe_filesystem.js';
import { get_repository_root } from './archive.js';

/**
 * One entry in the `sources` array of `.patchlab.json`. Either a string path
 * (mount name derived from the path itself) or an explicit `{ path, mount }`
 * object matching the CLI `--source` / `--mount` pair.
 */
export type Source_Entry = string | { path: string; mount: string };

export interface Patchlab_Overrides {
    requirements?: {
        system_packages?: string[];
        volume_mounts?: string[];
        environment_variables?: Record<string, string>;
        npm_packages?: string[];
    };
    ignore_detected?: string[];
    allow_socket_mount?: boolean;
    sources?: Source_Entry[];
}

const KNOWN_FIELDS = new Set([
    'requirements',
    'ignore_detected',
    'allow_socket_mount',
    'sources',
]);

const KNOWN_SOURCE_ENTRY_FIELDS = new Set(['path', 'mount']);

const KNOWN_REQUIREMENT_FIELDS = new Set([
    'system_packages',
    'volume_mounts',
    'environment_variables',
    'npm_packages',
]);

export function load_overrides(project_directory: string): Patchlab_Overrides {
    const file_path = path.join(project_directory, '.patchlab.json');
    if (!fs.existsSync(file_path)) {
        return {};
    }

    let parsed: unknown;
    try {
        parsed = parse_file_as_json(file_path);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${file_path}: ${message}`);
    }

    const raw = assert_parsed_object_root(parsed, file_path);
    warn_on_unknown_top_level_fields(raw);
    validate_requirements_block(raw.requirements);

    if (raw.ignore_detected !== undefined && !Array.isArray(raw.ignore_detected)) {
        throw new Error('.patchlab.json "ignore_detected" must be an array');
    }

    if (raw.allow_socket_mount !== undefined && typeof raw.allow_socket_mount !== 'boolean') {
        throw new Error('.patchlab.json "allow_socket_mount" must be a boolean');
    }

    validate_sources_field(raw.sources, file_path);

    return raw;
}

/**
 * Validate the `sources` field in `.patchlab.json`. Each element must be
 * either a non-empty string or an object with non-empty string `path` and
 * `mount` fields.
 */
function validate_sources_field(value: unknown, file_path: string): void {
    if (value === undefined) {
        return;
    }
    if (!Array.isArray(value)) {
        throw new TypeError(`${file_path} "sources" must be an array`);
    }
    for (let index = 0; index < value.length; index++) {
        validate_source_entry(value[index], index, file_path);
    }
}

function validate_source_entry(entry: unknown, index: number, file_path: string): void {
    if (typeof entry === 'string') {
        if (entry.length === 0) {
            throw new TypeError(
                `${file_path} "sources[${index}]" must be a non-empty string`,
            );
        }
        return;
    }
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
        validate_source_entry_object(entry as Record<string, unknown>, index, file_path);
        return;
    }
    throw new TypeError(
        `${file_path} "sources[${index}]" must be a string or { path, mount } object; `
        + `got ${Array.isArray(entry) ? 'array' : typeof entry}`,
    );
}

function validate_source_entry_object(
    entry: Record<string, unknown>,
    index: number,
    file_path: string,
): void {
    if (typeof entry['path'] !== 'string' || entry['path'].length === 0) {
        throw new TypeError(
            `${file_path} "sources[${index}].path" must be a non-empty string`,
        );
    }
    if (typeof entry['mount'] !== 'string' || entry['mount'].length === 0) {
        throw new TypeError(
            `${file_path} "sources[${index}].mount" must be a non-empty string`,
        );
    }
    for (const key of Object.keys(entry)) {
        if (!KNOWN_SOURCE_ENTRY_FIELDS.has(key)) {
            logger().warn(`Warning: unknown field '${key}' in ${file_path} sources[${index}] entry`);
        }
    }
}

function warn_on_unknown_top_level_fields(raw: Record<string, unknown>): void {
    for (const key of Object.keys(raw)) {
        if (!KNOWN_FIELDS.has(key)) {
            logger().warn(`Warning: unknown field '${key}' in .patchlab.json`);
        }
    }
}

function validate_requirements_block(value: unknown): void {
    if (value === undefined) {
        return;
    }

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('.patchlab.json "requirements" must be an object');
    }

    const requirements = value as Record<string, unknown>;
    for (const key of Object.keys(requirements)) {
        if (!KNOWN_REQUIREMENT_FIELDS.has(key)) {
            logger().warn(`Warning: unknown field 'requirements.${key}' in .patchlab.json`);
        }
    }

    assert_string_array_field(requirements.system_packages, 'requirements.system_packages');
    assert_string_array_field(requirements.volume_mounts, 'requirements.volume_mounts');
    assert_string_array_field(requirements.npm_packages, 'requirements.npm_packages');

    const environment_variables = requirements.environment_variables;
    if (environment_variables !== undefined
        && (typeof environment_variables !== 'object'
            || environment_variables === null
            || Array.isArray(environment_variables))) {
        throw new Error('.patchlab.json "requirements.environment_variables" must be an object');
    }

    if (typeof environment_variables === 'object' && environment_variables !== null && !Array.isArray(environment_variables)) {
        for (const [key, value] of Object.entries(environment_variables)) {
            if (typeof value !== 'string') {
                throw new TypeError(
                    `.patchlab.json "requirements.environment_variables.${key}" must be a string; got ${typeof value}`,
                );
            }
        }
    }
}

function assert_string_array_field(value: unknown, field_path: string): void {
    if (value === undefined) {
        return;
    }

    if (!Array.isArray(value)) {
        throw new TypeError(`.patchlab.json "${field_path}" must be an array`);
    }

    for (const element of value) {
        if (typeof element !== 'string') {
            throw new TypeError(`.patchlab.json "${field_path}" elements must be strings; got ${typeof element}`);
        }
    }
}

export function save_overrides(project_directory: string, overrides: Patchlab_Overrides): void {
    const file_path = path.join(project_directory, '.patchlab.json');
    atomic_write_file(file_path, JSON.stringify(overrides, null, 4));
}

/**
 * Read existing overrides (or empty), apply a mutation, and save atomically.
 */
export function update_overrides(
    project_directory: string,
    updater: (current: Patchlab_Overrides) => Patchlab_Overrides,
): void {
    const current = load_overrides(project_directory);
    const updated = updater(current);
    save_overrides(project_directory, updated);
}

/**
 * The result of a successful `.patchlab.json` sources discovery: the entries
 * from the `sources` array and the directory the file was found in, which
 * is the base directory against which relative entry paths are resolved.
 */
export interface Discovered_Sources {
    entries: Source_Entry[];
    base_directory: string;
}

/**
 * Search for a `.patchlab.json` with a `sources` array, starting from
 * `working_directory`.
 *
 * Search order:
 *  1. `<working_directory>/.patchlab.json` — if present and has `sources`, return it.
 *  2. If `working_directory` is inside a git repository whose root differs
 *     from `working_directory`, check `<git-root>/.patchlab.json`.
 *
 * Returns `undefined` when neither location yields a `sources` array.
 * Never throws for a non-git working directory; the git-root probe is
 * silently skipped.
 */
export function load_sources_from_manifest(working_directory: string): Discovered_Sources | undefined {
    const cwd_overrides = load_overrides(working_directory);
    if (cwd_overrides.sources !== undefined && cwd_overrides.sources.length > 0) {
        return { entries: cwd_overrides.sources, base_directory: working_directory };
    }

    let git_root: string;
    try {
        git_root = get_repository_root(working_directory);
    } catch {
        return undefined;
    }

    const resolved_working = path.resolve(working_directory);
    if (path.resolve(git_root) === resolved_working) {
        return undefined;
    }

    const git_root_overrides = load_overrides(git_root);
    if (git_root_overrides.sources !== undefined && git_root_overrides.sources.length > 0) {
        return { entries: git_root_overrides.sources, base_directory: git_root };
    }

    return undefined;
}
