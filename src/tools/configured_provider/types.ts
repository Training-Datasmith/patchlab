/**
 * Type declarations for the configured tool-provider subsystem.
 *
 * Pure types: no runtime exports. Importing this file pulls in no validator,
 * parser, or filesystem code — keeps the cycle graph clean across the rest of
 * `configured_provider/`.
 */
import type { Extractable_Artifact } from '../../extractable_artifact.js';

/**
 * Supported base-image families. `debian` and `alpine` describe a vanilla
 * upstream image that patchlab will set up with the matching package manager
 * (`apt` / `apk`); `prebuilt` describes an upstream image that already ships
 * the tool — no package install runs, and the manifest author MAY leave
 * `package_manager` unset.
 */
export type Base_Family = 'debian' | 'alpine' | 'prebuilt';

/**
 * Typed manifest produced by `parse_manifest` after YAML parsing, path
 * expansion, defaulting, and validation. Every field is normalized — defaults
 * are filled in (`image_home`, `configuration_directory_name`,
 * `extractable_artifacts`, `overrides_builtin`), so downstream code never
 * needs to ask "was this field explicit or defaulted." Path-shaped fields
 * have already had `~`, `$HOME`, and `$VARIABLE_NAME` resolved against the
 * appropriate context.
 */
export interface Configured_Tool_Provider_Manifest {
    name: string;
    display_name: string;
    image_user: string;
    image_home: string;
    configuration_directory_name: string;
    base_image: string;
    base_family: Base_Family;
    /**
     * Package manager available in the built image. Drives the
     * `biz.ecartz.patchlab.package_manager` LABEL and the patchlab capabilities
     * install pipeline. Defaults derived from `base_family`:
     *   - `debian` → `'apt'`
     *   - `alpine` → `'apk'`
     *   - `prebuilt` → `undefined` (manifest author may set explicitly)
     * When `undefined`, the build flow refuses to install user-requested
     * capabilities (`build_image` errors loudly per spec).
     */
    package_manager: 'apt' | 'apk' | undefined;
    dockerfile?: {
        install: string[];
        environment: Record<string, string>;
    };
    authentication: Manifest_Authentication;
    launch_command: string[];
    validation?: { command: string[] };
    extractable_artifacts: Extractable_Artifact[];
    overrides_builtin: boolean;
}

export type Manifest_Authentication =
    | { method: 'none' }
    | { method: 'environment_variables'; variable_names: string[] }
    | { method: 'file_copy'; copies: Manifest_File_Copy[] };

export interface Manifest_File_Copy {
    host: string;
    container: string;
    // True if `host` was authored as `~`, `~/...`, `$HOME`, or `$HOME/...` in the
    // raw YAML — captured BEFORE expansion so the trust prompt can surface the
    // cross-machine-reproducibility note. The expanded `host` no longer carries
    // the literal characters, so this flag is the only record that survives.
    uses_home_expansion: boolean;
}

/**
 * Structured rejection emitted by `parse_manifest`. Callers format the error
 * uniformly (see `format_warning`); the structured shape lets callers compose
 * their own messages or aggregate failures across many manifests.
 *
 * `field_path` uses dotted YAML key notation — empty string for top-level
 * failures (YAML syntax error, non-mapping root, invalid UTF-8), otherwise a
 * field path like `authentication.variable_names` or
 * `extractable_artifacts[1].archive_subpath`.
 */
export interface Manifest_Parse_Error {
    manifest_path: string;
    field_path: string;
    reason: string;
}
