import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { apply_version_extraction } from '../../../src/languages/strategy.js';
import type { Version_Extraction } from '../../../src/languages/index.js';

describe('apply_version_extraction', () => {
    let temp_dir: string;

    beforeEach(() => {
        temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-strategy-'));
    });

    afterEach(() => {
        fs.rmSync(temp_dir, { recursive: true, force: true });
    });

    function write(name: string, contents: string): string {
        const file_path = path.join(temp_dir, name);
        fs.writeFileSync(file_path, contents);
        return file_path;
    }

    describe('regex strategy', () => {
        const go_version: Version_Extraction = {
            strategy: 'regex',
            pattern: String.raw`^go (\d+)\.(\d+)`,
            image_template: 'golang:{1}.{2}',
        };

        it('extracts from a realistic go.mod via the multiline flag', () => {
            // The `go` directive is not the first line — `module` is. Only the
            // `m` flag lets `^go` anchor to the directive line.
            const file = write('go.mod', 'module example.com/x\n\ngo 1.22\n');
            expect(apply_version_extraction(go_version, file)).toBe('golang:1.22');
        });

        it('returns null when the pattern does not match', () => {
            const file = write('go.mod', 'module example.com/x\n');
            expect(apply_version_extraction(go_version, file)).toBeNull();
        });

        it('substitutes {0} with the whole match', () => {
            const file = write('.tool-version', 'ruby 3.3.1\n');
            const version: Version_Extraction = {
                strategy: 'regex',
                pattern: String.raw`\d+\.\d+`,
                image_template: 'ruby:{0}-slim',
            };
            expect(apply_version_extraction(version, file)).toBe('ruby:3.3-slim');
        });

        it('copies non-placeholder braces literally', () => {
            const file = write('v', '5\n');
            const version: Version_Extraction = {
                strategy: 'regex',
                pattern: String.raw`(\d+)`,
                image_template: 'img-{x}-{1}',
            };
            expect(apply_version_extraction(version, file)).toBe('img-{x}-5');
        });

        it('returns null for an out-of-bounds group reference', () => {
            const file = write('v', '5\n');
            const version: Version_Extraction = {
                strategy: 'regex',
                pattern: String.raw`(\d+)`,
                image_template: 'x:{2}',
            };
            expect(apply_version_extraction(version, file)).toBeNull();
        });

        it('returns null for an optional group that did not participate', () => {
            const file = write('v', '5\n');
            const version: Version_Extraction = {
                strategy: 'regex',
                pattern: String.raw`(\d+)(\.\d+)?`,
                image_template: 'x:{2}',
            };
            expect(apply_version_extraction(version, file)).toBeNull();
        });

        it('returns null for an uncompilable pattern rather than throwing', () => {
            const file = write('v', '5\n');
            const version: Version_Extraction = {
                strategy: 'regex',
                pattern: '([',
                image_template: 'x:{0}',
            };
            expect(apply_version_extraction(version, file)).toBeNull();
        });
    });

    describe('json-pointer strategy', () => {
        const node_version: Version_Extraction = {
            strategy: 'json-pointer',
            pointer: '/engines/node',
            pattern: String.raw`(\d+)`,
            image_template: 'node:{1}-slim',
        };

        it('reproduces the Node engines.node behavior', () => {
            const file = write('package.json', JSON.stringify({ engines: { node: '^20' } }));
            expect(apply_version_extraction(node_version, file)).toBe('node:20-slim');
        });

        it('coerces a numeric scalar target to a string', () => {
            const file = write('package.json', JSON.stringify({ engines: { node: 20 } }));
            expect(apply_version_extraction(node_version, file)).toBe('node:20-slim');
        });

        it('returns null when the pointer targets a non-scalar', () => {
            const file = write('package.json', JSON.stringify({ engines: { node: '>=18' } }));
            const to_object: Version_Extraction = { ...node_version, pointer: '/engines' };
            expect(apply_version_extraction(to_object, file)).toBeNull();
        });

        it('returns null when the pointer is absent (missing key)', () => {
            const file = write('package.json', JSON.stringify({ name: 'x' }));
            expect(apply_version_extraction(node_version, file)).toBeNull();
        });

        it('decodes RFC 6901 ~1 to a literal slash in a key', () => {
            const file = write('marker.json', JSON.stringify({ 'a/b': 'node 18' }));
            const version: Version_Extraction = {
                strategy: 'json-pointer',
                pointer: '/a~1b',
                pattern: String.raw`(\d+)`,
                image_template: 'node:{1}-slim',
            };
            expect(apply_version_extraction(version, file)).toBe('node:18-slim');
        });

        it('returns null for unparseable JSON', () => {
            const file = write('package.json', '{ not valid json');
            expect(apply_version_extraction(node_version, file)).toBeNull();
        });

        it('returns null when no pointer is supplied', () => {
            const file = write('package.json', JSON.stringify({ engines: { node: '20' } }));
            const no_pointer: Version_Extraction = { ...node_version, pointer: undefined };
            expect(apply_version_extraction(no_pointer, file)).toBeNull();
        });
    });

    it('returns null for an unreadable marker file', () => {
        const missing = path.join(temp_dir, 'does-not-exist.json');
        const version: Version_Extraction = {
            strategy: 'json-pointer',
            pointer: '/engines/node',
            pattern: String.raw`(\d+)`,
            image_template: 'node:{1}-slim',
        };
        expect(apply_version_extraction(version, missing)).toBeNull();
    });
});
