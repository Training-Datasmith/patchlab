import * as fs from 'node:fs';
import type { Version_Extraction } from './types.js';

/**
 * Apply a declarative version-extraction strategy to a marker file and return a
 * rendered base-image string, or `null` when no usable version can be produced
 * (the caller then falls back to the detector's `default_image`).
 *
 * This function NEVER throws. Every failure mode — unreadable file, unparseable
 * JSON, an uncompilable pattern, no match, an absent or non-scalar JSON-pointer
 * target, an out-of-bounds or unmatched template group — resolves to `null`.
 */
export function apply_version_extraction(version: Version_Extraction, file_path: string): string | null {
    let text: string;
    try {
        text = fs.readFileSync(file_path, 'utf-8');
    } catch (_unreadable_marker) {
        return null;
    }

    // `json-pointer` narrows the file to a single scalar value; `regex` applies
    // the pattern to the whole file text.
    const subject = version.strategy === 'json-pointer'
        ? resolve_json_pointer_scalar(text, version.pointer)
        : text;
    if (subject === null) {
        return null;
    }

    const pattern = compile_pattern(version.pattern);
    if (pattern === null) {
        return null;
    }

    const match = pattern.exec(subject);
    if (match === null) {
        return null;
    }

    return render_template(version.image_template, match);
}

/** Compile `pattern` with the multiline flag; `null` if it is not a valid regex. */
function compile_pattern(pattern: string): RegExp | null {
    try {
        return new RegExp(pattern, 'm');
    } catch (_invalid_pattern) {
        return null;
    }
}

const NOT_FOUND = Symbol('json_pointer_not_found');

/**
 * Resolve an RFC 6901 JSON pointer into `text` parsed as JSON, returning the
 * located value coerced to a string when it is a scalar (string/number/boolean),
 * or `null` when the JSON is unparseable, the pointer is absent or does not
 * resolve, or the target is an object, array, or null.
 */
function resolve_json_pointer_scalar(text: string, pointer: string | undefined): string | null {
    if (pointer === undefined) {
        return null;
    }

    let document: unknown;
    try {
        document = JSON.parse(text);
    } catch (_unparseable_json) {
        return null;
    }

    const located = navigate_json_pointer(document, pointer);
    if (located === NOT_FOUND) {
        return null;
    }
    if (typeof located === 'string' || typeof located === 'number' || typeof located === 'boolean') {
        return String(located);
    }
    return null;
}

/** Decode a single RFC 6901 reference token: `~1` → `/`, then `~0` → `~`. */
function decode_reference_token(token: string): string {
    return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

function navigate_json_pointer(document: unknown, pointer: string): unknown {
    if (pointer === '') {
        return document;
    }
    // A non-empty RFC 6901 pointer must begin with '/'.
    if (!pointer.startsWith('/')) {
        return NOT_FOUND;
    }

    let current: unknown = document;
    for (const raw_token of pointer.split('/').slice(1)) {
        const token = decode_reference_token(raw_token);
        if (current === null || typeof current !== 'object') {
            return NOT_FOUND;
        }
        if (Array.isArray(current)) {
            const index = /^\d+$/.test(token) ? Number(token) : -1;
            if (index < 0 || index >= current.length) {
                return NOT_FOUND;
            }
            current = current[index];
        } else if (Object.prototype.hasOwnProperty.call(current, token)) {
            current = (current as Record<string, unknown>)[token];
        } else {
            return NOT_FOUND;
        }
    }
    return current;
}

/**
 * Render `template`, substituting each `{n}` placeholder with the n-th capture
 * group of `match` (`{0}` is the whole match). Any character that is not part of
 * a `{<digits>}` placeholder is copied literally — there is no escape mechanism.
 * Returns `null` if a placeholder references a group index beyond the match or a
 * group that did not participate (so `"undefined"` is never emitted into a tag).
 */
function render_template(template: string, match: RegExpExecArray): string | null {
    let result = '';
    let index = 0;
    while (index < template.length) {
        if (template[index] === '{') {
            const close = template.indexOf('}', index);
            const inner = close > index ? template.slice(index + 1, close) : '';
            if (close > index && /^\d+$/.test(inner)) {
                const group_index = Number(inner);
                if (group_index >= match.length || match[group_index] === undefined) {
                    return null;
                }
                result += match[group_index];
                index = close + 1;
                continue;
            }
        }
        result += template[index];
        index += 1;
    }
    return result;
}
