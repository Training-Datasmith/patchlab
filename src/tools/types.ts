import type { Image_Validation } from '../images.js';
import type { Extractable_Artifact } from '../extractable_artifact.js';

export type Authentication_Method = 'file_copy' | 'environment_variables' | 'none';

export type Authentication_Result =
    | { type: 'none' }
    | { type: 'file_copy' }
    | { type: 'environment_variables'; entries: { name: string; value: string }[] };

/**
 * Image-build configuration for a tool provider. Separates "what gets baked into
 * the patchlab image at build time" from `Tool_Provider`'s tool-integration
 * surface (auth injection, launch command, validation).
 *
 * The `container_*` namespace prefix is intentionally NOT used here — it is
 * reserved for a future `Container_Runtime` abstraction (engine selection,
 * networking, capabilities — runtime-side concerns, not image-baked).
 */
export interface Image_Specification {
    readonly base_image: string;
    readonly image_user: string;
    readonly image_home: string;
    readonly configuration_directory_name: string;

    prepare_build_assets(): Promise<Map<string, string>>;
    get_dockerfile_lines(build_asset_filenames: string[]): string[];
    get_dockerfile_environment(): Record<string, string>;

    /**
     * Emit the base-image bootstrap block: install git (or its distro equivalent),
     * create the patchlab user (or skip when `image_user === 'root'`), and prepare
     * the configuration directory under `image_home`. Returns `{ lines: [] }` for
     * pre-baked images whose base already ships git + the patchlab user at the
     * matching UID (e.g., Google's gemini-cli sandbox).
     *
     * The optional `package_manager` field, when set, drives two things:
     * (1) the `biz.ecartz.patchlab.package_manager` LABEL on the built image
     * (read by `detect_package_manager` in src/capabilities.ts as a fast path);
     * (2) the patchlab capabilities install pipeline — `build_image` invokes
     * `generate_install_command(capabilities, package_manager)` only when this
     * field is set.
     *
     * When `package_manager` is `undefined` AND the user requested capabilities,
     * `build_image` errors loudly rather than silently no-op'ing the install.
     *
     * `uid` is the host-side UID patchlab uses for the in-image user. Built-ins
     * receive `CONTAINER_UID` from src/podman.ts.
     */
    get_base_preparation_lines(uid: number): {
        lines: string[];
        package_manager?: 'apt' | 'apk';
    };
}

export interface Tool_Provider {
    readonly name: string;
    readonly display_name: string;
    readonly image_specification: Image_Specification;

    inject_authentication(context: {
        sandbox_id: string;
        container_name?: string;
    }): Authentication_Result;
    get_launch_command(): string[];
    validate_image(image_tag: string): Image_Validation;
    get_cached_version(): string | null;
    get_openspec_tool_name(): string;
    get_authentication_method(): Authentication_Method;

    /**
     * Declare which artifacts the tool produces inside the sandbox that should be
     * extracted into the session archive on exit. Patchlab treats each artifact's
     * contents as opaque — only the path, type, and resume requirement are interpreted.
     *
     * Default implementation: return an empty array.
     */
    get_extractable_artifacts(): Extractable_Artifact[];

    /**
     * Restore previously extracted session state into a new sandbox. Implementations
     * SHOULD copy files from `session_path` (the archive's `sessions/{n}/` directory)
     * into the appropriate locations in the container. Failures SHOULD log a warning
     * and return — sandbox creation continues without restored state.
     *
     * Default implementation: no-op.
     */
    inject_session_state(container_name: string, session_path: string): Promise<void>;
}
