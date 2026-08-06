import type { Language_Detector } from './types.js';

/**
 * Registered language detectors, keyed by marker file. Mirrors the
 * tool-provider registry in `src/tools/provider.ts`, but keys on `marker`
 * rather than a name: keying by marker gives same-marker override its natural
 * `Map.set` overwrite semantics — built-ins register first, and a later
 * registration for an already-registered marker replaces the earlier detector
 * while preserving its original insertion slot (so the order
 * `list_language_detectors` reports is stable across an override).
 */
const detectors = new Map<string, Language_Detector>();

/** Register a language detector, replacing any prior detector for its marker. */
export function register_language_detector(detector: Language_Detector): void {
    detectors.set(detector.marker, detector);
}

/**
 * Return all registered detectors in insertion order (built-ins first, then
 * any later registrations). `detect_project` iterates this list.
 */
export function list_language_detectors(): Language_Detector[] {
    return [...detectors.values()];
}

/**
 * Test-only: clear the registry. Production code never calls this — built-ins
 * and user-global detectors register at module load and stay for the process
 * lifetime. Tests use it to re-run registration against fixture inputs.
 */
export function _reset_language_detectors(): void {
    detectors.clear();
}
