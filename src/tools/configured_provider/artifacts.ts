/**
 * Validators for the three shape-validation blocks that share a similar style:
 *   - `validation` — optional `{ command: string[] }` block
 *   - `launch_command` — required `string[]`
 *   - `extractable_artifacts` — optional `Extractable_Artifact[]`
 *
 * Grouped here because all three feed off the same low-level field
 * validators and the artifact validator needs the container-path expander
 * once `image_home` has been resolved — the natural seam keeps them
 * together rather than splitting one helper across two files.
 */
import {
    assert_unique_archive_subpaths,
    assert_unique_artifact_names,
    validate_archive_subpath,
    type Extractable_Artifact,
} from '../../extractable_artifact.js';
import { is_plain_object } from '../../json_validators.js';
import { expand_container_path } from './path_resolution.js';
import {
    fail,
    validate_artifact_name,
    validate_artifact_type,
    validate_strict_boolean,
} from './validators.js';

export function validate_validation_block(raw: unknown): { command: string[] } | undefined {
    if (raw === undefined) {
        return undefined;
    }
    if (!is_plain_object(raw)) {
        fail('validation', 'must be a mapping');
    }

    const command_raw = (raw as { command?: unknown }).command;
    if (!Array.isArray(command_raw)) {
        fail('validation.command', 'required when validation is set; must be a list of strings');
    }
    if (command_raw.length === 0) {
        fail('validation.command', 'must be non-empty when validation is set; omit the validation block to opt out');
    }
    for (const [index, token] of command_raw.entries()) {
        if (typeof token !== 'string') {
            fail(`validation.command[${index}]`, 'must be a string');
        }
    }

    // Reject unknown keys.
    for (const key of Object.keys(raw)) {
        if (key !== 'command') {
            fail(`validation.${key}`, 'unknown field');
        }
    }

    return { command: command_raw as string[] };
}

export function validate_launch_command(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
        fail('launch_command', 'required; must be a list of strings');
    }
    if (raw.length === 0) {
        fail('launch_command', 'must be a non-empty array — execve requires a program name as argv[0]');
    }
    for (const [index, token] of raw.entries()) {
        if (typeof token !== 'string') {
            fail(`launch_command[${index}]`, 'must be a string');
        }
    }

    return raw as string[];
}

const KNOWN_ARTIFACT_FIELDS = new Set([
    'name', 'container_path', 'type', 'archive_subpath', 'required_for_resume',
]);

function reject_unknown_artifact_fields(entry: Record<string, unknown>, index: number): void {
    for (const key of Object.keys(entry)) {
        if (!KNOWN_ARTIFACT_FIELDS.has(key)) {
            fail(`extractable_artifacts[${index}].${key}`, 'unknown field');
        }
    }
}

function validate_artifact_archive_subpath(
    raw: unknown,
    index: number,
    manifest_name_or_path: string
): string {
    if (typeof raw !== 'string') {
        fail(`extractable_artifacts[${index}].archive_subpath`, 'must be a string');
    }

    // Delegate to the host-boundary validator so parse-time and runtime stay in lockstep.
    try {
        validate_archive_subpath(raw, manifest_name_or_path);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(`extractable_artifacts[${index}].archive_subpath`, message);
    }

    return raw;
}

function validate_artifact_container_path(
    raw: unknown,
    index: number,
    image_home: string
): string {
    if (typeof raw !== 'string') {
        fail(`extractable_artifacts[${index}].container_path`, 'must be a string');
    }

    return expand_container_path(
        raw,
        image_home,
        `extractable_artifacts[${index}].container_path`
    );
}

function validate_single_extractable_artifact(
    entry_raw: unknown,
    index: number,
    manifest_name_or_path: string,
    image_home: string
): Extractable_Artifact {
    if (!is_plain_object(entry_raw)) {
        fail(`extractable_artifacts[${index}]`, 'must be a mapping');
    }

    const name = validate_artifact_name(entry_raw.name, `extractable_artifacts[${index}].name`);
    const type = validate_artifact_type(entry_raw.type, `extractable_artifacts[${index}].type`);
    const required_for_resume = validate_strict_boolean(
        entry_raw.required_for_resume,
        `extractable_artifacts[${index}].required_for_resume`
    );
    const archive_subpath = validate_artifact_archive_subpath(
        entry_raw.archive_subpath,
        index,
        manifest_name_or_path
    );
    const container_path = validate_artifact_container_path(
        entry_raw.container_path,
        index,
        image_home
    );
    reject_unknown_artifact_fields(entry_raw, index);

    return { name, container_path, type, archive_subpath, required_for_resume };
}

function assert_artifact_uniqueness(
    artifacts: Extractable_Artifact[],
    manifest_name_or_path: string
): void {
    // Per-array uniqueness checks reuse the host-boundary helpers; surface
    // their thrown errors through the structured Manifest_Validation_Error
    // path so parse_manifest's catch produces a uniform Manifest_Parse_Error.
    try {
        assert_unique_archive_subpaths(artifacts, manifest_name_or_path);
    } catch (error) {
        fail('extractable_artifacts', error instanceof Error ? error.message : String(error));
    }
    try {
        assert_unique_artifact_names(artifacts, manifest_name_or_path);
    } catch (error) {
        fail('extractable_artifacts', error instanceof Error ? error.message : String(error));
    }
}

export function validate_extractable_artifacts(
    raw: unknown,
    manifest_name_or_path: string,
    image_home: string
): Extractable_Artifact[] {
    if (raw === undefined) {
        return [];
    }

    if (!Array.isArray(raw)) {
        fail('extractable_artifacts', 'must be a list of mappings');
    }

    const artifacts = raw.map((entry_raw, index) =>
        validate_single_extractable_artifact(entry_raw, index, manifest_name_or_path, image_home)
    );
    assert_artifact_uniqueness(artifacts, manifest_name_or_path);
    return artifacts;
}
