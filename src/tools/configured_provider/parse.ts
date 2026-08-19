/**
 * Top-level `parse_manifest` entry point and its supporting helpers.
 *
 * Composes the per-block validators (authentication, dockerfile, artifacts,
 * validation block, launch command) into a single pass that returns either
 * a normalized `Configured_Tool_Provider_Manifest` or a structured
 * `Manifest_Parse_Error`.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import YAML from 'yaml';
import { validate_archive_subpath } from '../../extractable_artifact.js';
import { is_plain_object } from '../../json_validators.js';
import { validate_authentication } from './authentication.js';
import {
    validate_extractable_artifacts,
    validate_launch_command,
    validate_optional_prompt_launch_command,
    validate_validation_block,
} from './artifacts.js';
import { validate_dockerfile } from './dockerfile.js';
import { expand_container_path } from './path_resolution.js';
import type {
    Configured_Tool_Provider_Manifest,
    Manifest_File_Copy,
    Manifest_Parse_Error,
} from './types.js';
import {
    fail,
    Manifest_Validation_Error,
    validate_absolute_linux_path,
    validate_base_family,
    validate_base_image,
    validate_name,
    validate_package_manager,
    validate_simple_path_component,
    validate_strict_boolean,
    validate_string_non_empty,
} from './validators.js';

const KNOWN_TOP_LEVEL_FIELDS = new Set([
    'name', 'display_name', 'image_user', 'image_home',
    'configuration_directory_name', 'base_image', 'base_family', 'package_manager',
    'dockerfile', 'authentication', 'launch_command', 'prompt_launch_command',
    'prompt_resume_launch_command', 'validation', 'extractable_artifacts',
    'overrides_builtin',
]);

export interface Parse_Manifest_Options {
    /** Override `os.homedir()` for tests. Returning null/empty triggers the host-home failure path. */
    homedir_resolver?: () => string | null;
}

/**
 * Parse YAML into a top-level mapping or throw a `Manifest_Validation_Error`
 * with `field_path: ''` for syntax errors and non-mapping roots. The thrown
 * error rides the same catch path as field-level validation failures, so
 * callers see one uniform error shape.
 */
function parse_yaml_root(yaml_text: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = YAML.parse(yaml_text);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail('', `YAML parse error: ${message}`);
    }

    if (parsed === null || parsed === undefined || !is_plain_object(parsed)) {
        fail('', 'manifest root must be a YAML mapping');
    }

    return parsed;
}

function reject_unknown_top_level_fields(root: Record<string, unknown>): void {
    for (const key of Object.keys(root)) {
        if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) {
            fail(key, 'unknown top-level field');
        }
    }
}

/**
 * Resolve `image_home`: explicit values are validated as absolute Linux
 * paths; absent values default to `/root` for `image_user='root'` and
 * `/home/${image_user}` otherwise. Downstream code reads the result as a
 * plain absolute path with no special-casing.
 */
function resolve_image_home(raw: unknown, image_user: string): string {
    if (raw === undefined) {
        return image_user === 'root' ? '/root' : `/home/${image_user}`;
    }

    return validate_absolute_linux_path(raw, 'image_home');
}

/**
 * Resolve `configuration_directory_name`: explicit values are checked against
 * the shared `validate_archive_subpath` rule set (so parse-time and runtime
 * cannot drift); absent values default to `.<name>`.
 */
function resolve_configuration_directory_name(raw: unknown, name: string): string {
    if (raw === undefined) {
        return `.${name}`;
    }
    if (typeof raw !== 'string') {
        fail('configuration_directory_name', 'must be a string');
    }

    try {
        validate_archive_subpath(raw, name);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail('configuration_directory_name', message);
    }

    return raw;
}

/**
 * Second-pass expansion of `file_copy` container paths once `image_home`
 * is known. Host paths were expanded by `validate_authentication`; this pass
 * substitutes `image_home` for `~`/`$HOME` and rejects unresolvable
 * `$VAR` references.
 */
function expand_file_copy_container_paths(
    copies: Manifest_File_Copy[],
    image_home: string
): Manifest_File_Copy[] {
    return copies.map((copy, index) => ({
        host: copy.host,
        container: expand_container_path(
            copy.container,
            image_home,
            `authentication.copies[${index}].container`
        ),
        uses_home_expansion: copy.uses_home_expansion,
    }));
}

export function to_parse_error(error: unknown, manifest_path: string): Manifest_Parse_Error {
    if (error instanceof Manifest_Validation_Error) {
        return { manifest_path, field_path: error.field_path, reason: error.message };
    }

    return {
        manifest_path,
        field_path: '',
        reason: error instanceof Error ? error.message : String(error),
    };
}

/**
 * Parse and validate a manifest YAML string. Returns the typed manifest on
 * success or a `Manifest_Parse_Error` on any failure. Pure function — no
 * side effects, no provider registration, no runtime invocations.
 *
 * The function performs YAML parsing, field-level validation, path expansion
 * (host and container), and per-array uniqueness checks (delegating to the
 * shared `extractable_artifact.ts` validators so parse-time and host-boundary
 * rules cannot drift).
 */
export function parse_manifest(
    yaml_text: string,
    manifest_path: string,
    options?: Parse_Manifest_Options
): Configured_Tool_Provider_Manifest | Manifest_Parse_Error {
    const homedir_resolver = options?.homedir_resolver ?? (() => os.homedir());
    const manifest_directory = path.dirname(manifest_path);

    try {
        const root = parse_yaml_root(yaml_text);
        reject_unknown_top_level_fields(root);

        const name = validate_name(root.name);
        const display_name = validate_string_non_empty(root.display_name, 'display_name');
        const image_user = validate_simple_path_component(root.image_user, 'image_user');
        const base_image = validate_base_image(root.base_image);
        const base_family = validate_base_family(root.base_family);
        const package_manager = validate_package_manager(root.package_manager, base_family);
        const image_home = resolve_image_home(root.image_home, image_user);
        const configuration_directory_name = resolve_configuration_directory_name(
            root.configuration_directory_name,
            name
        );
        const dockerfile = validate_dockerfile(root.dockerfile);
        const authentication = validate_authentication(
            root.authentication,
            manifest_directory,
            homedir_resolver
        );
        if (authentication.method === 'file_copy') {
            authentication.copies = expand_file_copy_container_paths(
                authentication.copies,
                image_home
            );
        }
        const launch_command = validate_launch_command(root.launch_command);
        const prompt_launch_command = validate_optional_prompt_launch_command(
            root.prompt_launch_command,
            'prompt_launch_command',
        );
        const prompt_resume_launch_command = validate_optional_prompt_launch_command(
            root.prompt_resume_launch_command,
            'prompt_resume_launch_command',
        );
        if (prompt_resume_launch_command !== undefined && prompt_launch_command === undefined) {
            fail(
                'prompt_resume_launch_command',
                'requires prompt_launch_command when set',
            );
        }
        const validation = validate_validation_block(root.validation);
        const extractable_artifacts = validate_extractable_artifacts(
            root.extractable_artifacts,
            name,
            image_home
        );
        const overrides_builtin = root.overrides_builtin === undefined
            ? false
            : validate_strict_boolean(root.overrides_builtin, 'overrides_builtin');

        return {
            name,
            display_name,
            image_user,
            image_home,
            configuration_directory_name,
            base_image,
            base_family,
            package_manager,
            dockerfile,
            authentication,
            launch_command,
            prompt_launch_command,
            prompt_resume_launch_command,
            validation,
            extractable_artifacts,
            overrides_builtin,
        };
    } catch (error) {
        return to_parse_error(error, manifest_path);
    }
}
