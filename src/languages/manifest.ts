import YAML from 'yaml';
import { is_plain_object } from '../json_validators.js';
import type { Language_Detector, Version_Extraction } from './types.js';

/** A manifest that failed validation: the path and a human-readable reason. */
export interface Language_Manifest_Error {
    file_path: string;
    reason: string;
}

const KNOWN_TOP_LEVEL_FIELDS = new Set(['language', 'marker', 'default_image', 'version']);
const KNOWN_VERSION_FIELDS = new Set(['strategy', 'pattern', 'pointer', 'image_template']);
const PATH_SEPARATOR = /[/\\]/;

/** Thrown internally by the validators; converted to a Language_Manifest_Error. */
class Manifest_Rejection extends Error {}

function reject(reason: string): never {
    throw new Manifest_Rejection(reason);
}

function require_non_empty_string(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
        reject(`'${field}' must be a non-empty string`);
    }
    return value;
}

function reject_unknown_fields(object: Record<string, unknown>, known: Set<string>, prefix: string): void {
    for (const key of Object.keys(object)) {
        if (!known.has(key)) {
            reject(`unknown field '${prefix}${key}'`);
        }
    }
}

function parse_version_block(raw: unknown): Version_Extraction {
    if (!is_plain_object(raw)) {
        reject(`'version' must be a mapping`);
    }
    reject_unknown_fields(raw, KNOWN_VERSION_FIELDS, 'version.');

    const strategy = raw.strategy;
    if (strategy !== 'regex' && strategy !== 'json-pointer') {
        reject(`'version.strategy' must be 'regex' or 'json-pointer'`);
    }

    const pattern = require_non_empty_string(raw.pattern, 'version.pattern');
    try {
        // Compile with the same flag detection uses, so an uncompilable pattern
        // is caught here (a skipped manifest) rather than at detection time.
        new RegExp(pattern, 'm');
    } catch (_uncompilable_pattern) {
        reject(`'version.pattern' is not a valid regular expression`);
    }

    const image_template = require_non_empty_string(raw.image_template, 'version.image_template');

    if (strategy === 'json-pointer') {
        const pointer = require_non_empty_string(raw.pointer, 'version.pointer');
        return { strategy, pointer, pattern, image_template };
    }

    if (raw.pointer !== undefined) {
        reject(`'version.pointer' is not allowed with strategy 'regex'`);
    }
    return { strategy, pattern, image_template };
}

/**
 * Parse and validate a user-global language manifest. Returns a
 * `Language_Detector` on success, or a `Language_Manifest_Error` (never throws)
 * so the caller can warn-and-skip. Validation is strict: unknown fields (at the
 * top level or inside `version`), a `marker` containing a path separator, an
 * unknown `strategy`, a `pointer`/`strategy` mismatch, and an uncompilable
 * `pattern` are all rejections.
 */
export function parse_language_manifest(
    yaml_text: string,
    file_path: string,
): Language_Detector | Language_Manifest_Error {
    try {
        let root: unknown;
        try {
            root = YAML.parse(yaml_text, { maxAliasCount: 0 });
        } catch (error) {
            reject(`YAML parse error: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!is_plain_object(root)) {
            reject('manifest root must be a YAML mapping');
        }
        reject_unknown_fields(root, KNOWN_TOP_LEVEL_FIELDS, '');

        const language = require_non_empty_string(root.language, 'language');
        const marker = require_non_empty_string(root.marker, 'marker');
        if (PATH_SEPARATOR.test(marker)) {
            reject(`'marker' must be a bare filename without path separators`);
        }
        const default_image = require_non_empty_string(root.default_image, 'default_image');

        const detector: Language_Detector = { language, marker, default_image };
        if (root.version !== undefined) {
            detector.version = parse_version_block(root.version);
        }
        return detector;
    } catch (error) {
        if (error instanceof Manifest_Rejection) {
            return { file_path, reason: error.message };
        }
        return { file_path, reason: error instanceof Error ? error.message : String(error) };
    }
}
