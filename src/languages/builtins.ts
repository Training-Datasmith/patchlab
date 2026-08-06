import type { Language_Detector } from './types.js';
import { resolve_php_image } from './php_version.js';

/**
 * The built-in language detectors, migrated from the former `PROJECT_MARKERS`
 * table in `src/images.ts`. Order is significant: `detect_project` reports
 * detected languages in this order, and the first marker to match a given
 * language wins (later markers for an already-detected language are skipped).
 * Node.js and PHP carry version extraction. Node.js uses the declarative
 * `json-pointer` strategy. PHP uses `extract_image` to pick the highest known
 * PHP version that satisfies the Composer constraint. The remaining detectors
 * always yield their `default_image`.
 */
export const BUILTIN_LANGUAGE_DETECTORS: Language_Detector[] = [
    {
        language: 'Node.js',
        marker: 'package.json',
        default_image: 'node:22-slim',
        // Locate engines.node, pull the first integer out of the semver range
        // (e.g. ">=18", "^20", "22.x"), and pin node:<major>-slim.
        version: {
            strategy: 'json-pointer',
            pointer: '/engines/node',
            pattern: String.raw`(\d+)`,
            image_template: 'node:{1}-slim',
        },
    },
    {
        language: 'Python',
        marker: 'pyproject.toml',
        default_image: 'python:3.12-slim',
    },
    {
        language: 'Python',
        marker: 'requirements.txt',
        default_image: 'python:3.12-slim',
    },
    {
        language: 'Go',
        marker: 'go.mod',
        default_image: 'golang:1.22',
    },
    {
        language: 'Rust',
        marker: 'Cargo.toml',
        default_image: 'rust:1.77-slim',
    },
    {
        language: 'Ruby',
        marker: 'Gemfile',
        default_image: 'ruby:3.3-slim',
    },
    {
        language: 'Java',
        marker: 'pom.xml',
        default_image: 'eclipse-temurin:21',
    },
    {
        language: 'Java',
        marker: 'build.gradle',
        default_image: 'eclipse-temurin:21',
    },
    {
        language: 'PHP',
        marker: 'composer.json',
        default_image: 'php:8.3-cli',
        extract_image: resolve_php_image,
    },
];
