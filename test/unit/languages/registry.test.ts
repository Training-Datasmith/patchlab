import { describe, it, expect } from 'vitest';
import {
    register_language_detector,
    list_language_detectors,
} from '../../../src/languages/index.js';
import type { Language_Detector } from '../../../src/languages/index.js';

describe('language-detector registry', () => {
    it('registers the eight built-in detectors at module load', () => {
        const markers = list_language_detectors().map((detector) => detector.marker);
        expect(markers).toEqual(expect.arrayContaining([
            'package.json', 'pyproject.toml', 'requirements.txt', 'go.mod',
            'Cargo.toml', 'Gemfile', 'pom.xml', 'build.gradle',
        ]));
    });

    it('exposes the built-in Node.js detector', () => {
        const node = list_language_detectors().find((detector) => detector.marker === 'package.json');
        expect(node?.language).toBe('Node.js');
        expect(node?.default_image).toBe('node:22-slim');
    });

    it('adds a newly registered detector with a novel marker', () => {
        const detector: Language_Detector = {
            language: 'Elixir',
            marker: 'mix.exs',
            default_image: 'elixir:1.16-slim',
        };
        register_language_detector(detector);
        const found = list_language_detectors().find((entry) => entry.marker === 'mix.exs');
        expect(found).toEqual(detector);
    });

    it('replaces a detector that shares a marker (override by marker)', () => {
        const first: Language_Detector = {
            language: 'Zig',
            marker: 'build.zig',
            default_image: 'zig:0.11',
        };
        const second: Language_Detector = {
            language: 'Zig',
            marker: 'build.zig',
            default_image: 'zig:0.13',
        };
        register_language_detector(first);
        register_language_detector(second);

        const matches = list_language_detectors().filter((entry) => entry.marker === 'build.zig');
        expect(matches).toHaveLength(1);
        expect(matches[0].default_image).toBe('zig:0.13');
    });
});
