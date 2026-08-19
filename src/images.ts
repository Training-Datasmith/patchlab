import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    generate_install_command,
    generate_php_extension_install_command,
    requires_php_source_installer,
    targets_php_source_image,
} from './capabilities.js';
import { exec_runtime, get_runtime_binary, runtime_host_tmpdir } from './container_runtime.js';
import { image_exists, CONTAINER_UID } from './container_runtime.js';
import { get_provider, compute_container_workspace_path } from './tools/index.js';
import { logger } from './logger.js';

export const CAPABILITIES_LABEL = 'biz.ecartz.patchlab.capabilities';

/** Repository component of the default tag patchlab builds for a base image. */
export function patchlab_image_repository_for_base(base_image: string): string {
    return `patchlab/${base_image.replace(':', '-')}`;
}

// Image labeling convention for patchlab-compatible images.
export const PATCHLAB_LABEL = 'biz.ecartz.patchlab.compatible';
export const PATCHLAB_TOOLS_LABEL = 'biz.ecartz.patchlab.tools';
// Marks an image as built by/for the integration test suite so it can be
// filtered out of normal listings and cleaned up separately.
export const PATCHLAB_TEST_LABEL = 'biz.ecartz.patchlab.test';

export interface Patchlab_Image {
    repository: string;
    tag: string;
    id: string;
    tools: string[];
    tool_states: Record<string, string>;
    capabilities: string[];
}

/** List locally available patchlab-compatible images. */
export function list_images(): Patchlab_Image[] {
    try {
        const output = execFileSync(
            get_runtime_binary(),
            ['images', '--filter', `label=${PATCHLAB_LABEL}=true`, '--format', 'json'],
            { stdio: 'pipe' }
        ).toString('utf-8').trim();

        if (output === '' || output === '[]') {
            return [];
        }

        const raw = JSON.parse(output) as {
            repository?: string;
            Repository?: string;
            tag?: string;
            Tag?: string;
            id?: string;
            Id?: string;
            ID?: string;
            Names?: string[];
            Labels?: Record<string, string>;
            labels?: Record<string, string>;
        }[];

        return raw.map((entry) => {
            const labels = entry.Labels ?? entry.labels ?? {};
            const tools_str = labels[PATCHLAB_TOOLS_LABEL] ?? '';

            // Podman uses Names[] array; Docker uses repository/tag fields
            let repository = entry.repository ?? entry.Repository ?? '<none>';
            let tag = entry.tag ?? entry.Tag ?? 'latest';
            if (repository === '<none>' && entry.Names && entry.Names.length > 0) {
                const full_name = entry.Names[0];
                const colon_index = full_name.lastIndexOf(':');
                if (colon_index === -1) {
                    repository = full_name;
                } else {
                    repository = full_name.slice(0, colon_index);
                    tag = full_name.slice(colon_index + 1);
                }
            }

            // Podman qualifies locally-built images as localhost/<name> internally;
            // strip that prefix so callers see the same tag they passed to build.
            if (repository.startsWith('localhost/')) {
                repository = repository.slice('localhost/'.length);
            }

            const tool_states: Record<string, string> = {};
            const tool_label_prefix = 'biz.ecartz.patchlab.tool.';
            for (const [key, value] of Object.entries(labels)) {
                if (key.startsWith(tool_label_prefix)) {
                    const tool_name = key.slice(tool_label_prefix.length);
                    tool_states[tool_name] = value;
                }
            }

            const capabilities = ((typeof labels[CAPABILITIES_LABEL] === 'string')
                              && labels[CAPABILITIES_LABEL])
                               ? labels[CAPABILITIES_LABEL].split(',').map(
                                    (c) => c.trim()) : [];

            return {
                repository,
                tag,
                id: (entry.id ?? entry.Id ?? entry.ID ?? '').slice(0, 12),
                tools: tools_str ? tools_str.split(',').map((t) => t.trim()) : [],
                tool_states,
                capabilities,
            };
        });
    } catch (_image_listing_failed) {
        return [];
    }
}

/** Check if a patchlab-compatible image exists locally. */
export function has_any_compatible_image(): boolean {
    return list_images().length > 0;
}

/** Get the first patchlab-compatible image that matches the tool and
 *  capability labels AND passes `validate_image` (git present, tool binary
 *  working). Label-only matches are skipped so stale mis-built caches cannot
 *  satisfy the lookup. */
export function get_default_image(
    required_tool?: string,
    required_capabilities?: string[],
    required_base_image?: string,
): string | null {
    let candidates = list_images().filter((image) => {
        if (required_tool !== undefined && !image.tools.includes(required_tool)) {
            return false;
        }

        return (required_capabilities === undefined)
            || (required_capabilities.length <= 0)
            || required_capabilities.every((cap) => image.capabilities.includes(cap));
    });

    if (required_base_image !== undefined) {
        const expected_repository = patchlab_image_repository_for_base(required_base_image);
        candidates = candidates.filter((image) => image.repository === expected_repository);
    }

    if (candidates.length === 0) {
        return null;
    }

    // Pre-baked providers (Gemini) declare a tool-specific sandbox base.
    // Ignore generic language-detection images (e.g. patchlab/node-22-slim)
    // that happen to carry the tool label but were not built from that base.
    if (required_tool !== undefined && provider_uses_prebaked_base(required_tool)) {
        const provider_base = get_provider(required_tool).image_specification.base_image;
        candidates = candidates.filter((image) =>
            repository_matches_provider_base(image.repository, provider_base),
        );
    }

    for (const image of candidates) {
        const tag = `${image.repository}:${image.tag}`;
        const validation = required_tool !== undefined
            ? validate_image(tag, required_tool)
            : validate_image_baseline(tag);
        if (validation.valid) {
            return tag;
        }
        logger().verbose(`Skipping unfit cached image ${tag}: ${validation.reasons.join('; ')}`);
    }

    return null;
}

/** Git-only fitness check for unfiltered get_default_image lookups. */
function validate_image_baseline(tag: string): Image_Validation {
    if (!image_exists(tag)) {
        return { valid: false, reasons: ['image does not exist'] };
    }
    if (!image_has_git(tag)) {
        return { valid: false, reasons: ['git binary not found in $PATH'] };
    }
    return { valid: true, reasons: [] };
}

/** True when the provider's base_image already ships git, user, and tool layout. */
function provider_uses_prebaked_base(tool: string): boolean {
    return get_provider(tool).image_specification
        .get_base_preparation_lines(CONTAINER_UID).lines.length === 0;
}

/** Match patchlab tag repositories derived from a provider's declared base_image. */
function repository_matches_provider_base(repository: string, provider_base: string): boolean {
    const normalized = provider_base.replace(/[:@/]/g, '-');
    return repository.includes(normalized);
}


/** Remove all images marked with the test label. */
export function remove_test_images(): void {
    try {
        const output = execFileSync(
            get_runtime_binary(),
            ['images', '--filter', `label=${PATCHLAB_TEST_LABEL}=true`, '--format', '{{.ID}}'],
            { stdio: 'pipe' },
        ).toString('utf-8').trim();

        if (output === '') {
            return;
        }

        const ids = output.split('\n').map(id => id.trim()).filter(Boolean);
        for (const id of ids) {
            try {
                execFileSync(get_runtime_binary(), ['rmi', '-f', id], { stdio: 'pipe' });
            } catch (_image_in_use) {
                /* image may be in use */
            }
        }
    } catch (_image_listing_failed) {
        /* podman images listing failed
         — if podman isn't running, there's nothing to clean up */
    }
}

export interface Image_Validation {
    valid: boolean;
    reasons: string[];
}

/** Validate that a patchlab image has git (required for every sandbox baseline)
 *  and, when `tool_name` is supplied, a working tool binary for that provider.
 *  Returns the validation result without modifying anything.
 */
export function validate_image(tag: string, tool_name?: string): Image_Validation {
    if (!image_exists(tag)) {
        return { valid: false, reasons: ['image does not exist'] };
    }

    const reasons: string[] = [];

    if (!image_has_git(tag)) {
        reasons.push('git binary not found in $PATH');
    }

    if (tool_name !== undefined) {
        const provider = get_provider(tool_name);
        const provider_result = provider.validate_image(tag);
        if (!provider_result.valid) {
            reasons.push(...provider_result.reasons);
        }
    }

    return { valid: reasons.length === 0, reasons };
}

/** True when `git --version` succeeds inside a throwaway container from `tag`. */
function image_has_git(tag: string): boolean {
    try {
        execFileSync(
            get_runtime_binary(),
            ['run', '--rm', '--entrypoint', '', tag, 'git', '--version'],
            { stdio: 'pipe' },
        );
        return true;
    } catch (_git_missing) {
        return false;
    }
}

/** Validate a patchlab image; remove it if invalid so it gets rebuilt
 *  on next use. Returns the validation result.
 */
function primary_tool_from_image_tag(tag: string): string | undefined {
    const [repository, image_tag] = tag.includes(':')
        ? [tag.slice(0, tag.lastIndexOf(':')), tag.slice(tag.lastIndexOf(':') + 1)]
        : [tag, 'latest'];
    const match = list_images().find((image) =>
        image.repository === repository && image.tag === image_tag,
    );
    return match?.tools[0];
}

export function validate_or_remove_image(tag: string, tool_name?: string): Image_Validation {
    const resolved_tool = tool_name ?? primary_tool_from_image_tag(tag);
    const result = validate_image(tag, resolved_tool);
    if (!result.valid && image_exists(tag)) {
        logger().info(`Removing invalid image ${tag}: ${result.reasons.join(', ')}`);
        try {
            execFileSync(get_runtime_binary(), ['rmi', '-f', tag], { stdio: 'pipe' });
        } catch (_image_in_use) {
            /* image may be in use */
        }
    }
    return result;
}

// TOOL_INSTALLERS removed — tool installation is now handled by Tool_Provider.get_dockerfile_lines().

// Project-language detection (PROJECT_MARKERS / detect_project / Detected_Project)
// moved to src/languages/. build_image does not consult it (the base image comes
// from the provider's Image_Specification); detect_project remains a host-side
// advisory used by the build-image command.

export interface Build_Image_Options {
    base_image?: string;
    tools?: string[];
    tag?: string;
    project_directory?: string;
    capabilities?: string[];
    labels?: string[];
}

/** Build a patchlab-compatible image with specified tools pre-installed. */
export async function build_image(options?: Build_Image_Options): Promise<string> {
    const tools = options?.tools;
    if (tools === undefined || tools.length === 0) {
        throw new Error('build_image requires at least one tool in options.tools');
    }

    // The primary tool's image_specification drives image-level configuration
    // (base_image, image_user, image_home, base preparation). Secondary tools'
    // image_specifications are NOT consulted for these fields — multi-tool
    // builds with conflicting image_specifications are undefined behavior
    // (see design Decision 9b).
    const primary_tool = tools[0];
    const primary_provider = get_provider(primary_tool);
    const image_specification = primary_provider.image_specification;

    // CLI --base override > caller-supplied base_image (e.g. from detect_project)
    // > provider's declared base_image. See design Decision 9.
    const base_image = options?.base_image ?? image_specification.base_image;

    const tag = options?.tag ?? `${patchlab_image_repository_for_base(base_image)}:latest`;

    const image_user = image_specification.image_user;
    const container_working_directory = compute_container_workspace_path(primary_provider);

    // Ask the primary provider's image_specification what its base needs
    // (apt-install-git + useradd for vanilla debian; empty for pre-baked).
    // The optional package_manager field drives both the LABEL and the
    // capabilities install pipeline.
    const base_preparation = image_specification.get_base_preparation_lines(CONTAINER_UID);

    const capabilities = options?.capabilities ?? [];

    // When the base is an official php:*-cli image, PHP extensions must be
    // installed via install-php-extensions (which understands the from-source
    // PHP layout) rather than through the distro package manager.  Split the
    // capability list so that php-ext-* caps are routed to the helper and all
    // other caps continue through the normal apt/apk pipeline.
    const php_source = targets_php_source_image(base_image);
    const apt_capabilities = php_source
        ? capabilities.filter((c) => !requires_php_source_installer(c))
        : capabilities;
    const php_extension_capabilities = php_source
        ? capabilities.filter((c) => requires_php_source_installer(c))
        : [];

    if (apt_capabilities.length > 0 && base_preparation.package_manager === undefined) {
        throw new Error(
            `Cannot install --capability [${apt_capabilities.join(', ')}] against `
            + `provider '${primary_provider.name}': its image_specification has no `
            + `package_manager. Either remove --capability flags, swap base_image `
            + `with --base, or set package_manager in the configured-provider manifest.`,
        );
    }

    const capability_install_command = build_capability_install_command(
        apt_capabilities,
        base_preparation.package_manager,
    );

    const raw_php_extension_command = generate_php_extension_install_command(php_extension_capabilities);
    const php_extension_install_block = raw_php_extension_command
        ? `ADD https://github.com/mlocati/docker-php-extension-installer/releases/download/2.11.11/install-php-extensions /usr/local/bin/install-php-extensions\nRUN chmod +x /usr/local/bin/install-php-extensions && ${raw_php_extension_command}`
        : '';

    // Prepare build assets and dockerfile lines for all tools.
    // Secondary tools contribute their dockerfile lines / env / per-tool LABEL
    // but NOT their image_specification's image_user / image_home / base prep.
    const build_context = fs.mkdtempSync(path.join(runtime_host_tmpdir(), 'patchlab-build-'));
    try {
        const tool_contributions = await collect_tool_contributions(tools, build_context);

        const dockerfile = assemble_dockerfile_text({
            base_image,
            base_preparation,
            capability_install_command,
            php_extension_install_block,
            tool_contributions,
            image_user,
            container_working_directory,
            tools,
            capabilities,
            extra_labels: options?.labels ?? [],
        });

        execFileSync(
            get_runtime_binary(),
            ['build', '-t', tag, '-f', '-', build_context],
            {
                input: dockerfile,
                stdio: ['pipe', 'inherit', 'inherit'],
            }
        );
    } finally {
        fs.rmSync(build_context, { recursive: true, force: true });
    }

    return tag;
}

interface Tool_Contributions {
    provider_lines: string[];
    provider_environment: Record<string, string>;
    tool_labels: string[];
}

async function collect_tool_contributions(
    tools: string[],
    build_context: string,
): Promise<Tool_Contributions> {
    const provider_lines: string[] = [];
    const provider_environment: Record<string, string> = {};
    const tool_labels: string[] = [];

    for (const tool_name of tools) {
        const provider = get_provider(tool_name);
        const tool_image = provider.image_specification;
        const build_assets = await tool_image.prepare_build_assets();

        for (const [filename, host_path] of build_assets) {
            fs.copyFileSync(host_path, path.join(build_context, filename));
        }

        provider_lines.push(...tool_image.get_dockerfile_lines([...build_assets.keys()]));
        Object.assign(provider_environment, tool_image.get_dockerfile_environment());
        tool_labels.push(`LABEL biz.ecartz.patchlab.tool.${tool_name}="installed"`);
        const cached_version = provider.get_cached_version();
        if (cached_version !== null) {
            tool_labels.push(
                `LABEL biz.ecartz.patchlab.tool.${tool_name}.version=${JSON.stringify(cached_version)}`,
            );
        }
        const manifest_hash = (provider as { manifest_hash?: unknown }).manifest_hash;
        if (typeof manifest_hash === 'string') {
            tool_labels.push(
                `LABEL biz.ecartz.patchlab.tool.${tool_name}.spec_hash=${JSON.stringify(manifest_hash)}`,
            );
        }
    }

    return { provider_lines, provider_environment, tool_labels };
}

function build_capability_install_command(
    capabilities: string[],
    package_manager: 'apt' | 'apk' | undefined,
): string {
    if (capabilities.length === 0 || package_manager === undefined) {
        return '';
    }

    const command = generate_install_command(capabilities, package_manager);
    return command ? `RUN ${command}` : '';
}

interface Dockerfile_Assembly_Input {
    base_image: string;
    base_preparation: { lines: string[]; package_manager?: 'apt' | 'apk' };
    capability_install_command: string;
    /** Non-empty only for php:*-cli bases; contains the ADD + RUN for install-php-extensions. */
    php_extension_install_block: string;
    tool_contributions: Tool_Contributions;
    image_user: string;
    container_working_directory: string;
    tools: string[];
    capabilities: string[];
    extra_labels: string[];
}

function dockerfile_needs_root_elevation(input: Dockerfile_Assembly_Input): boolean {
    return input.base_preparation.lines.length > 0
        || input.capability_install_command.length > 0
        || input.php_extension_install_block.length > 0
        || input.tool_contributions.provider_lines.length > 0;
}

function assemble_dockerfile_text(input: Dockerfile_Assembly_Input): string {
    const root_elevation_block = dockerfile_needs_root_elevation(input) ? 'USER root\n' : '';
    const base_preparation_block = input.base_preparation.lines.length > 0
        ? input.base_preparation.lines.join('\n') + '\n'
        : '';
    const provider_lines_block = input.tool_contributions.provider_lines.length > 0
        ? input.tool_contributions.provider_lines.join('\n') + '\n'
        : '';
    // Double-quote the value so a legitimate space (or `=`) does not make
    // the Dockerfile `ENV` parser split it into extra key=value pairs and
    // fail the build. JSON.stringify yields exactly the double-quoted,
    // `\`/`"`-escaped token Dockerfile expects; newlines / control chars
    // are already rejected by the manifest validator
    // (validate_dockerfile_environment_value), so the value is printable.
    const provider_environment_block = Object.entries(input.tool_contributions.provider_environment)
        .map(([key, value]) => `ENV ${key}=${JSON.stringify(value)}`)
        .join('\n');
    // JSON.stringify yields the double-quoted, `\`/`"`-escaped token the
    // Dockerfile LABEL parser expects — the same treatment the ENV block above
    // uses — so a value carrying a space, `"`, or `=` cannot break out of the
    // `key="value"` form into an extra directive.
    const package_manager_label = input.base_preparation.package_manager === undefined
        ? ''
        : `\nLABEL biz.ecartz.patchlab.package_manager=${JSON.stringify(input.base_preparation.package_manager)}`;
    const capabilities_label = input.capabilities.length > 0
        ? `\nLABEL ${CAPABILITIES_LABEL}=${JSON.stringify(input.capabilities.join(','))}`
        : '';
    const extra_labels_block = input.extra_labels.length > 0
        ? '\n' + input.extra_labels.map(l => `LABEL ${l}`).join('\n')
        : '';

    return `FROM ${input.base_image}
${root_elevation_block}${base_preparation_block}${input.capability_install_command ? input.capability_install_command + '\n' : ''}${input.php_extension_install_block ? input.php_extension_install_block + '\n' : ''}${provider_lines_block}${provider_environment_block ? provider_environment_block + '\n' : ''}USER ${input.image_user}
RUN mkdir -p ${input.container_working_directory}
WORKDIR ${input.container_working_directory}
LABEL ${PATCHLAB_LABEL}="true"
LABEL ${PATCHLAB_TOOLS_LABEL}="${input.tools.join(',')}"
${input.tool_contributions.tool_labels.join('\n')}${package_manager_label}${capabilities_label}${extra_labels_block}
`;
}
