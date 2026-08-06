import { describe, it, expect } from 'vitest';
import { parse_language_manifest, type Language_Manifest_Error } from '../../../src/languages/manifest.js';
import type { Language_Detector } from '../../../src/languages/index.js';

function is_error(result: Language_Detector | Language_Manifest_Error): result is Language_Manifest_Error {
    return 'reason' in result;
}

describe('parse_language_manifest', () => {
    describe('valid manifests', () => {
        it('parses a minimal manifest with no version block', () => {
            const result = parse_language_manifest(
                'language: Go\nmarker: go.mod\ndefault_image: golang:1.22\n',
                'go.yaml',
            );
            expect(result).toEqual({ language: 'Go', marker: 'go.mod', default_image: 'golang:1.22' });
        });

        it('parses a regex version block', () => {
            const result = parse_language_manifest(
                'language: Go\nmarker: go.mod\ndefault_image: golang:1.22\n'
                + "version:\n  strategy: regex\n  pattern: '^go (\\d+)'\n  image_template: 'golang:{1}'\n",
                'go.yaml',
            );
            expect(is_error(result)).toBe(false);
            if (!is_error(result)) {
                expect(result.version).toEqual({
                    strategy: 'regex',
                    pattern: '^go (\\d+)',
                    image_template: 'golang:{1}',
                });
            }
        });

        it('parses a json-pointer version block', () => {
            const result = parse_language_manifest(
                'language: Node.js\nmarker: package.json\ndefault_image: node:22-slim\n'
                + "version:\n  strategy: json-pointer\n  pointer: /engines/node\n  pattern: '(\\d+)'\n  image_template: 'node:{1}-slim'\n",
                'node.yaml',
            );
            expect(is_error(result)).toBe(false);
            if (!is_error(result)) {
                expect(result.version?.strategy).toBe('json-pointer');
                expect(result.version?.pointer).toBe('/engines/node');
            }
        });
    });

    describe('rejections', () => {
        function expect_rejection(yaml_text: string, fragment: RegExp): void {
            const result = parse_language_manifest(yaml_text, 'manifest.yaml');
            expect(is_error(result)).toBe(true);
            if (is_error(result)) {
                expect(result.file_path).toBe('manifest.yaml');
                expect(result.reason).toMatch(fragment);
            }
        }

        it('rejects invalid YAML', () => {
            expect_rejection('language: Go\n  marker: [unclosed', /YAML parse error/);
        });

        it('rejects a manifest that uses a YAML alias (alias bomb hardening)', () => {
            const yaml_with_alias = 'base: &anchor golang:1.22\nlanguage: Go\nmarker: go.mod\ndefault_image: *anchor\n';
            expect_rejection(yaml_with_alias, /YAML parse error/);
        });

        it('rejects a non-mapping root', () => {
            expect_rejection('- a\n- b\n', /must be a YAML mapping/);
        });

        it('rejects a missing required field', () => {
            expect_rejection('language: Go\nmarker: go.mod\n', /'default_image' must be a non-empty string/);
        });

        it('rejects an empty-string field', () => {
            expect_rejection('language: Go\nmarker: go.mod\ndefault_image: "  "\n', /'default_image'/);
        });

        it('rejects a marker containing a path separator', () => {
            expect_rejection(
                'language: X\nmarker: ../package.json\ndefault_image: x:1\n',
                /'marker' must be a bare filename/,
            );
        });

        it('rejects an unknown top-level field', () => {
            expect_rejection(
                'language: Go\nmarker: go.mod\ndefault_image: golang:1.22\ndefaultimage: golang:1.21\n',
                /unknown field 'defaultimage'/,
            );
        });

        it('rejects an unknown field inside version', () => {
            expect_rejection(
                'language: Go\nmarker: go.mod\ndefault_image: golang:1.22\n'
                + "version:\n  strategy: regex\n  pattern: 'x'\n  image_template: 'y'\n  extra: 1\n",
                /unknown field 'version.extra'/,
            );
        });

        it('rejects an unknown strategy', () => {
            expect_rejection(
                'language: Go\nmarker: go.mod\ndefault_image: golang:1.22\n'
                + "version:\n  strategy: toml-key\n  pattern: 'x'\n  image_template: 'y'\n",
                /'version.strategy' must be 'regex' or 'json-pointer'/,
            );
        });

        it('rejects a pointer supplied with the regex strategy', () => {
            expect_rejection(
                'language: Go\nmarker: go.mod\ndefault_image: golang:1.22\n'
                + "version:\n  strategy: regex\n  pointer: /a\n  pattern: 'x'\n  image_template: 'y'\n",
                /'version.pointer' is not allowed with strategy 'regex'/,
            );
        });

        it('rejects a json-pointer strategy without a pointer', () => {
            expect_rejection(
                'language: Node.js\nmarker: package.json\ndefault_image: node:22-slim\n'
                + "version:\n  strategy: json-pointer\n  pattern: '(\\d+)'\n  image_template: 'node:{1}-slim'\n",
                /'version.pointer' must be a non-empty string/,
            );
        });

        it('rejects an uncompilable pattern', () => {
            expect_rejection(
                'language: Go\nmarker: go.mod\ndefault_image: golang:1.22\n'
                + "version:\n  strategy: regex\n  pattern: '(['\n  image_template: 'y'\n",
                /'version.pattern' is not a valid regular expression/,
            );
        });
    });
});
