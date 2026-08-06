import * as fs from 'node:fs';
import * as path from 'node:path';
import { list_language_detectors } from './registry.js';
import { apply_version_extraction } from './strategy.js';
import type { Detected_Project, Language_Detector } from './types.js';

/**
 * Resolve a detector's version-pinned image, or `null` to fall back to its
 * `default_image`. A code-hook `extract_image` takes precedence over a
 * declarative `version` block (a detector carries at most one form; this is the
 * tie-break when both are somehow present). A detector with neither yields `null`.
 */
function resolve_extracted_image(detector: Language_Detector, directory: string): string | null {
    if (detector.extract_image) {
        return detector.extract_image(directory);
    }

    if (detector.version) {
        return apply_version_extraction(detector.version, path.join(directory, detector.marker));
    }

    return null;
}

/** Detect project language from marker files and suggest a base image. */
export function detect_project(directory: string): Detected_Project[] {
    const resolved = path.resolve(directory);
    const detected: Detected_Project[] = [];
    const seen_languages = new Set<string>();

    for (const detector of list_language_detectors()) {
        if (seen_languages.has(detector.language)) {
            continue;
        }

        if (fs.existsSync(path.join(resolved, detector.marker))) {
            const extracted = resolve_extracted_image(detector, resolved);
            detected.push({
                language: detector.language,
                image: extracted ?? detector.default_image,
                marker: detector.marker,
            });
            seen_languages.add(detector.language);
        }
    }

    return detected;
}