/**
 * Image-staleness detection. Each sandbox image carries a `CAPABILITIES_LABEL`
 * recording the set of capabilities the image was built to satisfy. When a
 * project's currently-detected capabilities grow beyond what the existing
 * image label advertises, the image is "stale" and the user is prompted to
 * rebuild via `patchlab build-image`.
 */
import { CAPABILITIES_LABEL } from './images.js';
import { read_image_label } from './container_runtime.js';

/**
 * Read the capabilities label from a container image.
 * Returns null if the image has no capabilities label.
 */
export function get_image_capabilities(image: string): string[] | null {
    const result = read_image_label(image, CAPABILITIES_LABEL);

    if (!result || result === '<no value>') {
        return null;
    }

    return result.split(',').map((s) => s.trim()).filter(Boolean);
}

export interface Stale_Check_Result {
    stale: boolean;
    missing: string[];
    no_label: boolean;
}

/**
 * Compare detected capabilities against the image label.
 * Returns which capabilities are missing from the image.
 */
export function check_stale_image(
    image: string,
    detected_capabilities: string[],
): Stale_Check_Result {
    if (detected_capabilities.length === 0) {
        return { stale: false, missing: [], no_label: false };
    }

    const image_capabilities = get_image_capabilities(image);

    if (image_capabilities === null) {
        return {
            stale: true,
            missing: detected_capabilities,
            no_label: true,
        };
    }

    const image_capability_set = new Set(image_capabilities);
    const missing = detected_capabilities.filter((capability) => !image_capability_set.has(capability));

    return {
        stale: missing.length > 0,
        missing,
        no_label: false,
    };
}
