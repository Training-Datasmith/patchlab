import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARCHIVE_ARTIFACTS_DIRECTORY } from '../archive.js';
import type { Loaded_Configuration } from '../configuration.js';
import {
    filter_valid_artifacts_for_injection,
    type Extractable_Artifact,
} from '../extractable_artifact.js';
import type { Image_Validation } from '../images.js';
import { logger } from '../logger.js';
import {
    copy_to_container,
    exec_container,
    get_runtime_binary,
} from '../container_runtime.js';
import { find_escape_symlinks } from '../symlink_compatibility.js';
import { CONTAINER_UID } from '../container_runtime/index.js';
import type {
    Authentication_Method,
    Authentication_Result,
    Image_Specification,
    Launch_Context,
    Prompt_Passthrough_Capability,
    Tool_Provider,
} from '../tools/types.js';
import {
    validate_opencode_interactive_extra_argv,
    validate_opencode_prompt_extra_argv,
} from './passthrough.js';
import { build_image_specification } from '../tools/configured_provider/image_build.js';
import type { Configured_Tool_Provider_Manifest } from '../tools/configured_provider/types.js';
import { compute_manifest_hash, format_warning } from '../tools/configured_provider/trust_hash.js';
import { start_host_proxy } from '../local_model_proxy/manager.js';
import type { Host_Access_Plan, Prepare_Host_Access_Context } from '../tools/host_access.js';
import { HOST_PATCHLAB_INTERNAL } from '../tools/host_access.js';
import {
    collect_opencode_environment_variables,
    prepare_opencode_host_configuration,
} from './host_configuration.js';
import {
    container_opencode_project_directory,
    host_opencode_auth_path,
    host_opencode_configuration_directory,
    path_exists_as_file_or_directory,
} from './paths.js';
import {
    DEFAULT_LOADED_OPENCODE_SETTINGS,
    type Loaded_OpenCode_Settings,
} from './settings.js';
import { maybe_opencode_prompt_output_followup } from './prompt_output.js';
import {
    OPENCODE_NPM_SPEC,
    OPENCODE_PINNED_VERSION,
    parse_opencode_version_output,
} from './version.js';

export const OPENCODE_TOOL_NAME = 'opencode';

const OPENCODE_NPM_BOOTSTRAP_LINE = String.raw`RUN command -v npm >/dev/null 2>&1 || ( \
  apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/* \
)`;

const OPENCODE_MANIFEST: Configured_Tool_Provider_Manifest = {
    name: OPENCODE_TOOL_NAME,
    display_name: 'OpenCode',
    image_user: 'patchlab',
    image_home: '/home/patchlab',
    configuration_directory_name: '.opencode',
    base_image: 'docker.io/library/node:22-slim',
    base_family: 'debian',
    package_manager: 'apt',
    dockerfile: {
        install: [`npm install -g ${OPENCODE_NPM_SPEC}`],
        environment: {},
    },
    authentication: { method: 'none' },
    launch_command: ['opencode'],
    validation: { command: ['opencode', '--version'] },
    extractable_artifacts: [{
        name: 'project',
        container_path: '/home/patchlab/.local/share/opencode/project',
        type: 'directory',
        archive_subpath: 'opencode-project',
        required_for_resume: false,
    }],
    overrides_builtin: false,
};

const OPENCODE_BASE_IMAGE_SPECIFICATION = build_image_specification(OPENCODE_MANIFEST);

const OPENCODE_IMAGE_SPECIFICATION: Image_Specification = {
    ...OPENCODE_BASE_IMAGE_SPECIFICATION,
    get_dockerfile_lines(build_assets) {
        return [
            OPENCODE_NPM_BOOTSTRAP_LINE,
            ...OPENCODE_BASE_IMAGE_SPECIFICATION.get_dockerfile_lines(build_assets),
        ];
    },
};

export class OpenCode_Tool_Provider implements Tool_Provider {
    readonly name = OPENCODE_TOOL_NAME;
    readonly display_name = 'OpenCode';
    readonly image_specification = OPENCODE_IMAGE_SPECIFICATION;
    readonly manifest_hash = compute_manifest_hash(OPENCODE_MANIFEST);

    inject_authentication(_context: {
        sandbox_id: string;
        container_name?: string;
    }): Authentication_Result {
        return { type: 'none' };
    }

    get_prompt_passthrough_capabilities(): readonly Prompt_Passthrough_Capability[] {
        return ['passthrough', 'file'];
    }

    get_launch_command(context?: Launch_Context): string[] {
        validate_opencode_interactive_extra_argv(context?.extra_argv, context?.exec);
        return ['opencode', ...(context?.extra_argv ?? [])];
    }

    get_prompt_launch_command(prompt: string, context?: Launch_Context): string[] {
        validate_opencode_prompt_extra_argv(context?.extra_argv, context?.exec);
        const command = ['opencode', 'run', '--auto'];
        if (context?.resume) {
            command.push('--continue');
        }
        if (context?.extra_argv !== undefined) {
            command.push(...context.extra_argv);
        }
        for (const file of context?.files ?? []) {
            command.push('--file', file);
        }
        command.push('--', prompt);
        return command;
    }

    maybe_prompt_output_followup(
        container_name: string,
        working_directory: string,
        prompt: string,
        context?: Launch_Context,
    ): string[] | null {
        return maybe_opencode_prompt_output_followup(
            container_name,
            working_directory,
            prompt,
            context,
        );
    }

    validate_image(image_tag: string): Image_Validation {
        const version_result = this.run_image_validation_command(
            image_tag,
            ['opencode', '--version'],
        );
        if (!version_result.ok) {
            return version_result.validation;
        }

        const installed_version = parse_opencode_version_output(version_result.stdout);
        if (installed_version === null) {
            return {
                valid: false,
                reasons: ['opencode --version output could not be parsed'],
            };
        }
        if (installed_version !== OPENCODE_PINNED_VERSION) {
            return {
                valid: false,
                reasons: [
                    `opencode version ${installed_version} does not match pinned ${OPENCODE_PINNED_VERSION}`,
                ],
            };
        }

        const export_help = this.run_image_validation_command(
            image_tag,
            ['opencode', 'export', '--help'],
        );
        if (!export_help.ok) {
            return export_help.validation;
        }
        if (!export_help.stdout.includes('--sanitize')) {
            return {
                valid: false,
                reasons: ['opencode export does not support --sanitize'],
            };
        }

        return { valid: true, reasons: [] };
    }

    private run_image_validation_command(
        image_tag: string,
        command: string[],
    ):
        | { ok: true; stdout: string }
        | { ok: false; validation: Image_Validation } {
        const result = spawnSync(get_runtime_binary(), [
            'run', '--rm', '--entrypoint', '',
            '--user', this.image_specification.image_user,
            '--workdir', this.image_specification.image_home,
            '--network', 'none',
            image_tag,
            ...command,
        ], { encoding: 'utf-8', stdio: 'pipe' });

        if (result.error !== undefined) {
            return {
                ok: false,
                validation: {
                    valid: false,
                    reasons: [`validation could not run: ${result.error.message}`],
                },
            };
        }

        const combined_output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        if (result.status !== 0) {
            const reason = combined_output.trim() === ''
                ? `validation command ${command.join(' ')} exited with code ${result.status ?? 'unknown'}`
                : combined_output.trim();
            return {
                ok: false,
                validation: { valid: false, reasons: [reason] },
            };
        }

        return { ok: true, stdout: combined_output };
    }

    get_cached_version(): string | null {
        return OPENCODE_PINNED_VERSION;
    }

    get_openspec_tool_name(): string {
        return OPENCODE_TOOL_NAME;
    }

    get_authentication_method(): Authentication_Method {
        return 'none';
    }

    get_extractable_artifacts(): Extractable_Artifact[] {
        return [...OPENCODE_MANIFEST.extractable_artifacts];
    }

    async inject_session_state(container_name: string, session_path: string): Promise<void> {
        const artifacts = this.get_extractable_artifacts();
        const valid_artifacts = filter_valid_artifacts_for_injection(artifacts, this.name);

        for (const artifact of valid_artifacts) {
            const archive_directory = path.join(
                session_path,
                ARCHIVE_ARTIFACTS_DIRECTORY,
                artifact.archive_subpath,
            );
            if (!fs.existsSync(archive_directory)) {
                continue;
            }

            try {
                const escape_links = find_escape_symlinks(archive_directory);
                if (escape_links.length > 0) {
                    logger().warn(format_warning({
                        operation: 'inject_session_state',
                        provider_name: this.name,
                        action: 'skipped',
                        target: `'${artifact.name}' artifact`,
                        reason: `escape-symlink found at ${escape_links.join(', ')}`,
                    }));
                    continue;
                }

                exec_container(container_name, ['mkdir', '-p', artifact.container_path]);
                copy_to_container(container_name, archive_directory + '/.', artifact.container_path);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger().warn(format_warning({
                    operation: 'inject_session_state',
                    provider_name: this.name,
                    action: 'failed to inject',
                    target: `'${artifact.name}' artifact`,
                    reason: message,
                }));
            }
        }
    }

    async prepare_host_access(context: Prepare_Host_Access_Context): Promise<Host_Access_Plan | null> {
        const settings = opencode_settings_from_loaded_configuration(context.loaded_configuration);

        const has_host_configuration = settings.copy_host_configuration
            && path_exists_as_file_or_directory(host_opencode_configuration_directory());
        const has_host_auth = settings.copy_host_auth
            && fs.existsSync(host_opencode_auth_path());

        if (!has_host_configuration && !has_host_auth) {
            const env_only = collect_opencode_environment_variables();
            if (Object.keys(env_only).length === 0 && Object.keys(settings.environment).length === 0) {
                return null;
            }
        }

        const initial = prepare_opencode_host_configuration({
            sandbox_directory: context.sandbox_directory,
            image_home: this.image_specification.image_home,
            copy_host_configuration: settings.copy_host_configuration,
            copy_host_auth: settings.copy_host_auth,
            proxy_local_models: settings.proxy_local_models,
        });

        const proxy = await start_host_proxy({
            sandbox_id: context.sandbox_id,
            forwards: initial.forwards,
            proxy_local_models: settings.proxy_local_models,
        });

        const prepared = prepare_opencode_host_configuration({
            sandbox_directory: context.sandbox_directory,
            image_home: this.image_specification.image_home,
            copy_host_configuration: settings.copy_host_configuration,
            copy_host_auth: settings.copy_host_auth,
            proxy_local_models: settings.proxy_local_models,
            rewrite_hostname: HOST_PATCHLAB_INTERNAL,
            listen_ports_by_target: proxy.listen_ports_by_target,
        });

        const extra_environment_variables: Record<string, string> = {
            ...settings.environment,
            ...collect_opencode_environment_variables(),
        };

        return {
            extra_hosts: proxy.extra_hosts,
            file_copies: prepared.file_copies,
            extra_environment_variables,
            stop: proxy.stop,
        };
    }
}

export function create_opencode_provider(): OpenCode_Tool_Provider {
    return new OpenCode_Tool_Provider();
}

/** @internal Exposed for tests. */
export function opencode_manifest_hash_inputs(): Configured_Tool_Provider_Manifest {
    return OPENCODE_MANIFEST;
}

/** @internal UID used when building the OpenCode image. */
export function opencode_container_uid(): number {
    return CONTAINER_UID;
}

/** @internal Container project path for artifact tests. */
export function opencode_project_container_path(): string {
    return container_opencode_project_directory(OPENCODE_MANIFEST.image_home);
}

export function merge_opencode_settings(
    partial: Partial<Loaded_OpenCode_Settings> | null | undefined,
): Loaded_OpenCode_Settings {
    if (partial === null || partial === undefined) {
        return { ...DEFAULT_LOADED_OPENCODE_SETTINGS, environment: {} };
    }

    return {
        copy_host_configuration: partial.copy_host_configuration
            ?? DEFAULT_LOADED_OPENCODE_SETTINGS.copy_host_configuration,
        copy_host_auth: partial.copy_host_auth ?? DEFAULT_LOADED_OPENCODE_SETTINGS.copy_host_auth,
        proxy_local_models: partial.proxy_local_models ?? DEFAULT_LOADED_OPENCODE_SETTINGS.proxy_local_models,
        environment: partial.environment ?? {},
    };
}

/** Read merged OpenCode settings from a loaded patchlab configuration. */
export function opencode_settings_from_loaded_configuration(
    loaded_configuration: Loaded_Configuration,
): Loaded_OpenCode_Settings {
    const block = loaded_configuration.tool_configuration[OPENCODE_TOOL_NAME];
    return merge_opencode_settings(block as Partial<Loaded_OpenCode_Settings> | undefined ?? null);
}
