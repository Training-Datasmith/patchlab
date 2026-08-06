/**
 * The vocabulary of project-language detection. A `Language_Detector` maps a
 * marker file to a base image and, optionally, extracts a version-pinned image
 * from that marker. `detect_project` iterates the registered detectors.
 *
 * A detector carries AT MOST ONE version-extraction form: a code-hook
 * `extract_image` function OR a declarative `version` block. If both are
 * present, `extract_image` (the explicit code escape hatch) takes precedence
 * and `version` is ignored. A detector with neither form always yields its
 * `default_image`.
 */

export interface Version_Extraction {
    /**
     * `regex` applies `pattern` to the marker file read as text. `json-pointer`
     * navigates `pointer` (RFC 6901) into the marker parsed as JSON, then
     * applies `pattern` to the located value.
     */
    strategy: 'regex' | 'json-pointer';
    /** Required for `json-pointer`; forbidden for `regex`. RFC 6901 reference. */
    pointer?: string;
    /** Regular expression with capture groups; compiled with the `m` flag. */
    pattern: string;
    /** Template whose `{n}` placeholders take capture groups (`{0}` = whole match). */
    image_template: string;
}

export interface Language_Detector {
    language: string;
    marker: string;
    default_image: string;
    extract_image?: (directory: string) => string | null;
    version?: Version_Extraction;
}

export interface Detected_Project {
    language: string;
    image: string;
    marker: string;
}
