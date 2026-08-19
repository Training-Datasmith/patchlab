/**
 * Synthesized `Tool_Provider` implementation built from a parsed manifest.
 *
 * Composes the pure helpers from `image_build.ts` and `trust_hash.ts`. Holds
 * the parsed `Configured_Tool_Provider_Manifest` so per-method dispatch can
 * read fields without re-parsing.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARCHIVE_ARTIFACTS_DIRECTORY } from '../../archive.js';
import {
    filter_valid_artifacts_for_injection,
    type Extractable_Artifact,
} from '../../extractable_artifact.js';
import type { Image_Validation } from '../../images.js';
import { logger } from '../../logger.js';
import { copy_to_container, exec_container } from '../../container_runtime.js';
import { find_escape_symlinks } from '../../symlink_compatibility.js';
import type {
    Authentication_Method,
    Authentication_Result,
    Image_Specification,
    Launch_Context,
    Tool_Provider,
} from '../types.js';
import { expand_prompt_launch_argv } from './artifacts.js';
import {
    build_image_specification,
    inject_authentication_environment_variables,
    inject_authentication_file_copy,
    inject_authentication_none,
} from './image_build.js';
import { compute_manifest_hash, format_warning } from './trust_hash.js';
import type { Configured_Tool_Provider_Manifest } from './types.js';

import { get_runtime_binary } from '../../container_runtime.js';

/**
 * Synthesized `Tool_Provider` implementation built from a parsed manifest.
 * Satisfies the same contract as a code-defined provider; consumers cannot
 * distinguish it from a built-in via the public API.
 *
 * All defaulting is owned by the manifest-format parser; this class forwards
 * fields verbatim.
 */
export class Configured_Tool_Provider implements Tool_Provider {
    readonly name: string;
    readonly display_name: string;
    readonly image_specification: Image_Specification;
    declare get_prompt_launch_command?: Tool_Provider['get_prompt_launch_command'];

    /** Path to the manifest file this provider was synthesized from. Used by
     *  `list-tools` for the source label. */
    readonly manifest_path: string;

    /** 8-char content hash over the image-affecting manifest fields. Used by
     *  the image-build/cache flow to invalidate cached images when the
     *  manifest's image-affecting content changes. */
    readonly manifest_hash: string;

    private readonly manifest: Configured_Tool_Provider_Manifest;

    /** Repository tree this provider's per-source manifest came from, used to
     *  re-verify `file_copy` host-path containment at injection time. `undefined`
     *  for user-global manifests, which are not repository-containment-restricted. */
    private readonly repository_root?: string;

    constructor(
        manifest: Configured_Tool_Provider_Manifest,
        manifest_path: string,
        repository_root?: string,
    ) {
        this.manifest = manifest;
        this.name = manifest.name;
        this.display_name = manifest.display_name;
        this.image_specification = build_image_specification(manifest);
        this.manifest_path = manifest_path;
        this.manifest_hash = compute_manifest_hash(manifest);
        this.repository_root = repository_root;

        if (manifest.prompt_launch_command !== undefined) {
            const create_argv = manifest.prompt_launch_command;
            const resume_argv = manifest.prompt_resume_launch_command;
            this.get_prompt_launch_command = (
                prompt: string,
                context?: Launch_Context,
            ): string[] => {
                const template = context?.resume && resume_argv !== undefined
                    ? resume_argv
                    : create_argv;
                return expand_prompt_launch_argv(template, prompt);
            };
        }
    }

    inject_authentication(context: {
        sandbox_id: string;
        container_name?: string;
    }): Authentication_Result {
        const authentication = this.manifest.authentication;

        if (authentication.method === 'none') {
            return inject_authentication_none();
        }

        if (authentication.method === 'environment_variables') {
            return inject_authentication_environment_variables(this.manifest, authentication.variable_names);
        }

        // file_copy
        const container_name = context.container_name;
        if (!container_name) {
            return { type: 'none' };
        }
        return inject_authentication_file_copy(
            this.manifest,
            container_name,
            authentication.copies,
            this.manifest_path,
            this.repository_root,
        );
    }

    get_launch_command(_context?: Launch_Context): string[] {
        return [...this.manifest.launch_command];
    }

    validate_image(image_tag: string): Image_Validation {
        const validation = this.manifest.validation;
        if (!validation) {
            return { valid: true, reasons: [] };
        }

        try {
            execFileSync(get_runtime_binary(), [
                'run', '--rm', '--entrypoint', '',
                '--user', this.image_specification.image_user,
                '--workdir', this.image_specification.image_home,
                '--network', 'none',
                image_tag,
                ...validation.command,
            ], { stdio: 'pipe' });
            return { valid: true, reasons: [] };
        } catch (error) {
            // execFileSync throws on non-zero exit. Distinguish podman-itself-failed
            // (no status field, or the binary is missing) from command-exited-non-zero
            // (status field present, indicating the validation command ran but failed).
            const error_with_status = error as { status?: number; stderr?: Buffer; message?: string };
            if (typeof error_with_status.status === 'number') {
                const stderr = error_with_status.stderr?.toString('utf-8').trim() ?? '';
                const reason = stderr === ''
                    ? `validation command exited with code ${error_with_status.status}`
                    : stderr;
                return { valid: false, reasons: [reason] };
            }
            const message = error instanceof Error ? error.message : String(error);
            return { valid: false, reasons: [`validation could not run: ${message}`] };
        }
    }

    get_cached_version(): string | null {
        return null;
    }

    get_openspec_tool_name(): string {
        return this.manifest.name;
    }

    get_authentication_method(): Authentication_Method {
        return this.manifest.authentication.method;
    }

    get_extractable_artifacts(): Extractable_Artifact[] {
        return [...this.manifest.extractable_artifacts];
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
}
