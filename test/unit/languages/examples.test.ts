import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse_language_manifest, type Language_Manifest_Error } from '../../../src/languages/manifest.js';
import { apply_version_extraction } from '../../../src/languages/index.js';
import type { Language_Detector } from '../../../src/languages/index.js';

const EXAMPLES_DIR = path.resolve(__dirname, '..', '..', '..', 'documents', 'examples', 'languages');

function load_example(name: string): Language_Detector {
    const text = fs.readFileSync(path.join(EXAMPLES_DIR, name), 'utf-8');
    const result: Language_Detector | Language_Manifest_Error = parse_language_manifest(text, name);
    if ('reason' in result) {
        throw new Error(`example manifest ${name} failed to parse: ${result.reason}`);
    }

    return result;
}

function require_version(detector: Language_Detector): NonNullable<Language_Detector['version']> {
    if (!detector.version) {
        throw new Error(`example manifest for ${detector.language} has no version block`);
    }

    return detector.version;
}

describe('documented example language manifests', () => {
    let temp_dir: string;

    beforeEach(() => {
        temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-examples-'));
    });

    afterEach(() => {
        fs.rmSync(temp_dir, { recursive: true, force: true });
    });

    it('go.yaml parses and pins golang:<minor> from a real go.mod', () => {
        const detector = load_example('go.yaml');
        expect(detector).toMatchObject({ language: 'Go', marker: 'go.mod' });

        const go_mod = path.join(temp_dir, 'go.mod');
        fs.writeFileSync(go_mod, 'module example.com/x\n\ngo 1.21\n');
        expect(apply_version_extraction(require_version(detector), go_mod)).toBe('golang:1.21');
    });

    it('python.yaml parses and pins python:<minor>-slim from requires-python', () => {
        const detector = load_example('python.yaml');
        expect(detector).toMatchObject({ language: 'Python', marker: 'pyproject.toml' });

        const pyproject = path.join(temp_dir, 'pyproject.toml');
        fs.writeFileSync(pyproject, '[project]\nname = "x"\nrequires-python = ">=3.11"\n');
        expect(apply_version_extraction(require_version(detector), pyproject)).toBe('python:3.11-slim');
    });
});
