/**
 * JSON parsing from files and field-level validators. `parse_file_as_json`
 * is the single entry point for reading any on-disk JSON file: it strips a
 * leading UTF-8 BOM before parsing so Windows-editor-saved files do not cause
 * a spurious SyntaxError. The field validators then operate on the parsed
 * result, replacing unchecked `as string` / `as number` casts that silently
 * let `undefined` propagate into downstream code.
 *
 * Each validator throws a plain `Error` that names the file path and the
 * offending field, mirroring the existing `validate_source_specification`
 * style in `manifest.ts`.
 */
import * as fs from 'node:fs';

/**
 * Read a file, strip a leading UTF-8 BOM if present, and parse the result as
 * JSON. Returns `unknown` so the caller must validate the shape before use.
 * Throws on read failure or malformed JSON — callers that need resilience
 * should wrap in try/catch.
 */
export function parse_file_as_json(file_path: string): unknown {
    const content = fs.readFileSync(file_path, 'utf-8');
    return JSON.parse(content.replace(/^\uFEFF/, ''));
}

/**
 * Assert that the result of `JSON.parse` is a plain object (not an array,
 * `null`, or a primitive). Returns the value typed as `Record<string, unknown>`
 * so callers can safely read fields. Throws otherwise.
 */
export function assert_parsed_object_root(value: unknown, file_path: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(
            `${file_path}: expected the parsed JSON to be an object; got ${describe_type(value)}.`,
        );
    }

    return value as Record<string, unknown>;
}

/**
 * Read a required string field from a parsed-and-validated object root.
 * Throws when the field is absent or its value is not a string.
 */
export function require_string_field(
    raw: Record<string, unknown>,
    field_name: string,
    file_path: string,
): string {
    const value = raw[field_name];
    if (typeof value !== 'string') {
        throw new TypeError(
            `${file_path}: required field "${field_name}" must be a string; got ${describe_type(value)}.`,
        );
    }

    return value;
}

/**
 * Read a required finite-number field from a parsed-and-validated object root.
 * `NaN` and `±Infinity` are rejected — the on-disk schemas only encode
 * finite numeric values.
 */
export function require_number_field(
    raw: Record<string, unknown>,
    field_name: string,
    file_path: string,
): number {
    const value = raw[field_name];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(
            `${file_path}: required field "${field_name}" must be a finite number; got ${describe_type(value)}.`,
        );
    }

    return value;
}

/**
 * Validate that `value` is a `Record<string, string | null>`. Used for the
 * per-repository SHA maps in manifest and session metadata files. Returns
 * `undefined` when the field is absent so the caller's legacy-synthesis
 * path can run; returns the value (untouched) when present and well-shaped;
 * throws when present with the wrong shape.
 */
export function validate_string_or_null_map(
    value: unknown,
    field_name: string,
    file_path: string,
): Record<string, string | null> | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(
            `${file_path}: field "${field_name}" must be an object mapping repository roots to strings or null; got ${describe_type(value)}.`,
        );
    }

    const map = value as Record<string, unknown>;
    for (const key of Object.keys(map)) {
        const entry = map[key];
        if (entry !== null && typeof entry !== 'string') {
            throw new TypeError(
                `${file_path}: field "${field_name}"["${key}"] must be a string or null; got ${describe_type(entry)}.`,
            );
        }
    }

    return map as Record<string, string | null>;
}

/**
 * Read an optional string field from a parsed-and-validated object root.
 * Returns `undefined` when the field is absent; throws when present but not a string.
 */
export function validate_optional_string_field(
    raw: Record<string, unknown>,
    field_name: string,
    file_path: string,
): string | undefined {
    const value = raw[field_name];
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== 'string') {
        throw new TypeError(
            `${file_path}: optional field "${field_name}" must be a string; got ${describe_type(value)}.`,
        );
    }

    return value;
}

/**
 * Read an optional string-array field from a parsed-and-validated object root.
 * Returns `undefined` when the field is absent; throws when present but not an
 * array of strings.
 */
export function validate_optional_string_array_field(
    raw: Record<string, unknown>,
    field_name: string,
    file_path: string,
): string[] | undefined {
    const value = raw[field_name];
    if (value === undefined) {
        return undefined;
    }

    if (!Array.isArray(value)) {
        throw new TypeError(
            `${file_path}: optional field "${field_name}" must be an array; got ${describe_type(value)}.`,
        );
    }

    for (const element of value) {
        if (typeof element !== 'string') {
            throw new TypeError(
                `${file_path}: optional field "${field_name}" elements must be strings; got ${describe_type(element)}.`,
            );
        }
    }

    return value as string[];
}

function describe_type(value: unknown): string {
    if (value === null) {
        return 'null';
    }

    return Array.isArray(value) ? 'array' : typeof value;
}

export function validate_optional_string_record_field(
    raw: Record<string, unknown>,
    field_name: string,
    file_path: string,
): Record<string, string> | undefined {
    const value = raw[field_name];
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError(
            `${file_path}: optional field "${field_name}" must be an object; got ${describe_type(value)}.`,
        );
    }

    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== 'string') {
            throw new TypeError(
                `${file_path}: optional field "${field_name}" values must be strings; key "${key}" has ${describe_type(entry)}.`,
            );
        }
    }

    return value as Record<string, string>;
}

/**
 * Type guard for "plain dictionary object" — non-null, non-array, and with
 * `Object.prototype` as its immediate prototype. Rejects class instances
 * (`Date`, `Map`, `Error`, custom classes) and `Object.create(null)` objects.
 *
 * Inputs from `JSON.parse` and `YAML.parse` always satisfy this predicate
 * when the parsed root or subtree is a mapping; the prototype check is
 * defense-in-depth at module boundaries that might also receive constructed
 * values from other callers.
 */
export function is_plain_object(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object'
        && value !== null
        && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}