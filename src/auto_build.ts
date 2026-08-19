import { detect_requirements } from './detect/index.js';
import { build_image, get_default_image } from './images.js';
import { detect_project } from './languages/index.js';
import { load_overrides } from './overrides.js';
import { merge_requirements } from './overrides_merge.js';
import { CONTAINER_UID } from './container_runtime.js';
import { get_provider } from './tools/index.js';
import { logger } from './logger.js';

function resolve_detected_base_image(project_directory: string, tool: string): string | undefined {
    const provider = get_provider(tool);
    const base_preparation = provider.image_specification.get_base_preparation_lines(CONTAINER_UID);
    // Language detection steers the base for bootstrap providers (debian/alpine
    // families that emit git+useradd prep lines). Pre-baked providers (Gemini)
    // ship a tool-specific sandbox — never override their declared base_image.
    if (base_preparation.lines.length === 0) {
        return undefined;
    }

    const language_projects = detect_project(project_directory);
    if (language_projects.length === 0) {
        return undefined;
    }

    return language_projects[0].image;
}

function resolve_effective_base_image_for_cache(project_directory: string, tool: string): string {
    return resolve_detected_base_image(project_directory, tool)
        ?? get_provider(tool).image_specification.base_image;
}

/** Return an existing default image, or auto-build one for the given project directory. */
export async function ensure_default_image(project_directory: string, tool: string): Promise<string> {
    const tools = [tool];
    const required_tool = tool;

    const detected_requirements = detect_requirements(project_directory, tool ? { tool } : undefined);
    const overrides = load_overrides(project_directory);
    const merged = merge_requirements(detected_requirements, overrides);
    const capabilities = merged.system_packages.map((r) => r.capability);

    const detected_base_image = resolve_detected_base_image(project_directory, tool);
    const cache_base_image = resolve_effective_base_image_for_cache(project_directory, tool);

    const existing = get_default_image(required_tool, capabilities, cache_base_image);
    if (existing) {
        return existing;
    }

    const provider = get_provider(required_tool);

    logger().info('No patchlab-compatible image found — building one automatically...');
    const tag = await build_image({
        project_directory,
        capabilities,
        tools,
        base_image: detected_base_image,
    });
    logger().info(`Image built: ${tag}`);

    return tag;
}
