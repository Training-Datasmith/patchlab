/**
 * Authentication-block validators for the configured tool-provider manifest.
 *
 * Three methods are supported:
 *   - `none` — no authentication injection at all
 *   - `environment_variables` — declare a list of host environment variable
 *     names that the build flow will read and inject into the image
 *   - `file_copy` — declare a list of host→container path pairs that the
 *     build flow will read from the host and copy into the image
 *
 * Host-path expansion runs INSIDE this module (so `manifest_directory` and
 * `homedir_resolver` can be threaded in here); container-path expansion is
 * deferred to `parse.ts`'s second pass, after `image_home` is known.
 */
import { is_plain_object } from '../../json_validators.js';
import { fail } from './validators.js';
import { expand_host_path } from './path_resolution.js';
import type { Manifest_Authentication, Manifest_File_Copy } from './types.js';

function validate_none_method(raw: Record<string, unknown>): Manifest_Authentication {
    // Reject extra fields under method:none for clarity (e.g., a stray
    // `variable_names` left over from switching strategies).
    for (const key of Object.keys(raw)) {
        if (key !== 'method') {
            fail(`authentication.${key}`, 'not allowed when method=none');
        }
    }

    return { method: 'none' };
}

function validate_environment_variables_method(raw: Record<string, unknown>): Manifest_Authentication {
    const variable_names = raw.variable_names;
    if (!Array.isArray(variable_names)) {
        fail('authentication.variable_names', 'required when method=environment_variables; must be a list of strings');
    }

    if (variable_names.length === 0) {
        fail('authentication.variable_names', 'must declare at least one variable; use method: none for no authentication');
    }

    for (const [index, name] of variable_names.entries()) {
        if (typeof name !== 'string' || name === '') {
            fail(`authentication.variable_names[${index}]`, 'must be a non-empty string');
        }
    }

    return { method: 'environment_variables', variable_names: variable_names as string[] };
}

function validate_file_copy_entry(
    copy_raw: unknown,
    index: number,
    manifest_directory: string,
    homedir_resolver: () => string | null
): Manifest_File_Copy {
    if (!is_plain_object(copy_raw)) {
        fail(`authentication.copies[${index}]`, 'must be a mapping with `host` and `container` keys');
    }
    const host_raw = copy_raw.host;
    const container_raw = copy_raw.container;
    if (typeof host_raw !== 'string' || host_raw === '') {
        fail(`authentication.copies[${index}].host`, 'must be a non-empty string');
    }
    if (typeof container_raw !== 'string' || container_raw === '') {
        fail(`authentication.copies[${index}].container`, 'must be a non-empty string');
    }
    // Host-path expansion happens here with manifest_directory in scope.
    // Container-path expansion is deferred to parse_manifest's second pass,
    // when image_home is known.
    const expanded_host = expand_host_path(
        host_raw,
        manifest_directory,
        `authentication.copies[${index}].host`,
        homedir_resolver
    );
    return {
        host: expanded_host,
        container: container_raw,
        uses_home_expansion: host_value_uses_home_expansion(host_raw),
    };
}

// Matches the prefixes recognized by `expand_host_path`'s home-expansion
// branches. Checked against the RAW YAML value before expansion runs.
function host_value_uses_home_expansion(host_raw: string): boolean {
    return host_raw === '~' || host_raw.startsWith('~/') || host_raw.startsWith('~\\')
        || host_raw === '$HOME' || host_raw.startsWith('$HOME/') || host_raw.startsWith('$HOME\\');
}

function validate_file_copy_method(
    raw: Record<string, unknown>,
    manifest_directory: string,
    homedir_resolver: () => string | null
): Manifest_Authentication {
    const copies = raw.copies;
    if (!Array.isArray(copies) || copies.length === 0) {
        fail('authentication.copies', 'required when method=file_copy; must be a non-empty list. For no authentication use method: none');
    }
    const validated_copies = copies.map((copy_raw, index) =>
        validate_file_copy_entry(copy_raw, index, manifest_directory, homedir_resolver)
    );
    return { method: 'file_copy', copies: validated_copies };
}

export function validate_authentication(
    raw: unknown,
    manifest_directory: string,
    homedir_resolver: () => string | null
): Manifest_Authentication {
    if (!is_plain_object(raw)) {
        fail('authentication', 'must be a mapping');
    }

    const method = raw.method;
    if (method === 'none') {
        return validate_none_method(raw);
    }
    if (method === 'environment_variables') {
        return validate_environment_variables_method(raw);
    }
    if (method === 'file_copy') {
        return validate_file_copy_method(raw, manifest_directory, homedir_resolver);
    }

    fail('authentication.method', `must be one of 'none', 'environment_variables', 'file_copy'; got ${JSON.stringify(method)}`);
}
