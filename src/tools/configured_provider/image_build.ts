/**
 * Image-specification builder and authentication-injection helpers for
 * configured tool providers.
 *
 * Split from `provider_class.ts` so the pure data-shaping logic
 * (`build_base_preparation_lines`, `build_image_specification`) and the
 * per-method authentication helpers can be unit-tested without instantiating
 * a `Configured_Tool_Provider`. The class composes these via plain function
 * calls — no shared mutable state.
 */
import { logger } from '../../logger.js';
import { copy_to_container } from '../../container_runtime.js';
import type {
    Authentication_Result,
    Image_Specification,
} from '../types.js';
import { assert_host_path_within_source } from './path_resolution.js';
import { format_warning } from './trust_hash.js';
import type {
    Configured_Tool_Provider_Manifest,
    Manifest_File_Copy,
} from './types.js';

/**
 * Build the `Image_Specification.get_base_preparation_lines` return value for
 * a configured provider, per the mapping mandated by
 * `tool-provider-image-specification`'s task 3.4 and design Decision 8:
 *
 * - `debian` (non-root): `apt-get install git` + `mkdir -p ${home}/${config_dir} && useradd -d ${home} -s /bin/bash -u ${uid} -o ${user} && chown -R ${user}:${user} ${home}`
 * - `debian` (root): `apt-get install git` + `mkdir -p /root/${config_dir}` (no useradd, no chown)
 * - `alpine` (non-root): `apk add --no-cache git` + `mkdir -p ${home}/${config_dir} && adduser -D -H -h ${home} -u ${uid} ${user} && chown -R ${user}:${user} ${home}`
 * - `alpine` (root): `apk add --no-cache git` + `mkdir -p /root/${config_dir}` (no adduser, no chown)
 * - `prebuilt`: empty lines (no bootstrap; gemini-cli-sandbox style)
 *
 * `package_manager` is taken verbatim from the manifest. For `prebuilt`, when
 * the manifest's `package_manager` is undefined, `build_image` will error
 * loudly if `--capability` is requested against this provider.
 */
function build_base_preparation_lines(
    manifest: Configured_Tool_Provider_Manifest,
    uid: number,
): { lines: string[]; package_manager?: 'apt' | 'apk' } {
    const package_manager = manifest.package_manager;
    const image_user = manifest.image_user;
    const image_home = manifest.image_home;
    const configuration_directory_name = manifest.configuration_directory_name;

    if (manifest.base_family === 'prebuilt') {
        return package_manager ? { lines: [], package_manager } : { lines: [] };
    }

    const root = image_user === 'root';
    const install_line = manifest.base_family === 'alpine'
        ? 'RUN apk add --no-cache git'
        : 'RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*';

    if (root) {
        const lines = [install_line, `RUN mkdir -p /root/${configuration_directory_name}`];
        return package_manager ? { lines, package_manager } : { lines };
    }

    const user_setup = manifest.base_family === 'alpine'
        ? String.raw`RUN mkdir -p ${image_home}/${configuration_directory_name} \
    && adduser -D -H -h ${image_home} -u ${uid} ${image_user} \
    && chown -R ${image_user}:${image_user} ${image_home}`
        : String.raw`RUN mkdir -p ${image_home}/${configuration_directory_name} \
    && useradd -d ${image_home} -s /bin/bash -u ${uid} -o ${image_user} \
    && chown -R ${image_user}:${image_user} ${image_home}`;

    const lines = [install_line, user_setup];
    return package_manager ? { lines, package_manager } : { lines };
}

/**
 * Build the `Image_Specification` exposed by a synthesized provider from a
 * parsed manifest. The data fields are forwarded verbatim — the manifest-format
 * parser owns defaulting (`image_home` derived from `image_user`,
 * `configuration_directory_name` defaulted to `.<name>`, `base_family`
 * defaulted to `'debian'`, `package_manager` derived from `base_family`).
 *
 * `prepare_build_assets` returns an empty map — configured providers don't
 * download external binaries during build (the tool's install steps live in
 * `dockerfile.install` and run inside the build, not host-side).
 */
export function build_image_specification(
    manifest: Configured_Tool_Provider_Manifest,
): Image_Specification {
    return {
        base_image: manifest.base_image,
        image_user: manifest.image_user,
        image_home: manifest.image_home,
        configuration_directory_name: manifest.configuration_directory_name,

        prepare_build_assets(): Promise<Map<string, string>> {
            return Promise.resolve(new Map());
        },

        get_dockerfile_lines(): string[] {
            return (manifest.dockerfile?.install ?? []).map((command) => `RUN ${command}`);
        },

        get_dockerfile_environment(): Record<string, string> {
            return manifest.dockerfile?.environment ?? {};
        },

        get_base_preparation_lines(uid: number): { lines: string[]; package_manager?: 'apt' | 'apk' } {
            return build_base_preparation_lines(manifest, uid);
        },
    };
}

export function inject_authentication_none(): Authentication_Result {
    return { type: 'none' };
}

export function inject_authentication_environment_variables(
    manifest: Configured_Tool_Provider_Manifest,
    variable_names: string[],
): Authentication_Result {
    const entries: { name: string; value: string }[] = [];
    for (const name of variable_names) {
        const value = process.env[name];
        if (value === undefined) {
            logger().warn(format_warning({
                operation: 'inject_authentication',
                provider_name: manifest.name,
                action: 'omitted',
                target: `'${name}'`,
                reason: 'variable not set in host environment',
            }));
            continue;
        }
        entries.push({ name, value });
    }

    return (entries.length === 0) ? { type: 'none' }
        : { type: 'environment_variables', entries };
}

export function inject_authentication_file_copy(
    manifest: Configured_Tool_Provider_Manifest,
    container_name: string,
    copies: Manifest_File_Copy[],
    manifest_path: string,
    repository_root?: string,
): Authentication_Result {
    for (let index = 0; index < copies.length; index++) {
        const copy = copies[index];
        // TOCTOU re-check. Containment was proven at registration, but the host
        // path is re-read here — after the (possibly interactive) trust prompt —
        // and the file's CONTENT is never part of the trust hash. A writable-repo
        // attacker could have swapped `copy.host` for a symlink escaping the tree
        // in that window. Re-verify immediately before the copy to shrink the
        // exposure to this check→cp gap. Per-source manifests only: user-global
        // manifests pass no `repository_root` and are not containment-restricted.
        // A residual check→cp race remains and is accepted (documented in the
        // configured-tool-provider threat model).
        if (repository_root !== undefined) {
            const containment_error = assert_host_path_within_source(
                copy.host,
                repository_root,
                manifest_path,
                { field_index: index },
            );
            if (containment_error) {
                logger().warn(format_warning({
                    operation: 'inject_authentication',
                    provider_name: manifest.name,
                    action: 'refused to copy (host path escaped repository tree at injection time)',
                    target: `'${copy.host}' → '${copy.container}'`,
                    reason: containment_error.reason,
                }));
                continue;
            }
        }

        try {
            copy_to_container(container_name, copy.host, copy.container);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger().warn(format_warning({
                operation: 'inject_authentication',
                provider_name: manifest.name,
                action: 'failed to copy',
                target: `'${copy.host}' → '${copy.container}'`,
                reason: message,
            }));
        }
    }

    return { type: 'file_copy' };
}
