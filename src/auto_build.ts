import { detect_requirements } from './detect/index.js';
import { build_image, get_default_image } from './images.js';
import { detect_project } from './languages/index.js';
import { load_overrides } from './overrides.js';
import { merge_requirements } from './overrides_merge.js';
import { CONTAINER_UID } from './podman.js';
import { get_provider } from './tools/index.js';
import { logger } from './logger.js';

/** Return an existing default image, or auto-build one for the given project directory. */
export async function ensure_default_image(project_directory: string, tool: string): Promise<string> {
    const tools = [tool];
    const required_tool = tool;

    const detected_requirements = detect_requirements(project_directory, tool ? { tool } : undefined);
    const overrides = load_overrides(project_directory);
    const merged = merge_requirements(detected_requirements, overrides);
    const capabilities = merged.system_packages.map((r) => r.capability);

    const existing = get_default_image(required_tool, capabilities);
    if (existing) {
        return existing;
    }

    const language_projects = detect_project(project_directory);
    const provider = get_provider(required_tool);
    const base_preparation = provider.image_specification.get_base_preparation_lines(CONTAINER_UID);
    // Language detection steers the base for bootstrap providers (debian/alpine
    // families that emit git+useradd prep lines). Pre-baked providers (Gemini)
    // ship a tool-specific sandbox — never override their declared base_image.
    const detected_base_image = base_preparation.lines.length > 0 && language_projects.length > 0
        ? language_projects[0].image
        : undefined;

    logger().info('No patchlab-compatible image found — building one automatically...');
    const tag = await build_image({ project_directory, capabilities, tools, base_image: detected_base_image });
    logger().info(`Image built: ${tag}`);

    return tag;
}
