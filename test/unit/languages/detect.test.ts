import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { detect_project } from '../../../src/languages/index.js';

// Prevent host PHP installation from interfering with image-resolution tests:
// resolve_php_version_from_host shells out to `php --version`, which must be
// suppressed here so PHP image assertions fall through to the composer.json
// constraint logic (priority 3) rather than picking up the host PHP (priority 2).
vi.mock('node:child_process', () => ({ execSync: vi.fn(() => { throw new Error('ENOENT'); }) }));

describe('detect_project', () => {
    let temp_dir: string;

    beforeEach(() => {
        temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-detect-'));
    });

    afterEach(() => {
        fs.rmSync(temp_dir, { recursive: true, force: true });
    });

    it('detects Node.js from package.json', () => {
        fs.writeFileSync(path.join(temp_dir, 'package.json'), '{}');
        const detected = detect_project(temp_dir);
        expect(detected).toHaveLength(1);
        expect(detected[0].language).toBe('Node.js');
        expect(detected[0].image).toMatch(/^node:/);
        expect(detected[0].marker).toBe('package.json');
    });

    it('reads node version from engines field', () => {
        fs.writeFileSync(path.join(temp_dir, 'package.json'), JSON.stringify({
            engines: { node: '>=18' },
        }));
        const detected = detect_project(temp_dir);
        expect(detected[0].image).toBe('node:18-slim');
    });

    it('detects Python from requirements.txt', () => {
        fs.writeFileSync(path.join(temp_dir, 'requirements.txt'), 'flask\n');
        const detected = detect_project(temp_dir);
        expect(detected).toHaveLength(1);
        expect(detected[0].language).toBe('Python');
        expect(detected[0].image).toMatch(/^python:/);
    });

    it('detects Python from pyproject.toml', () => {
        fs.writeFileSync(path.join(temp_dir, 'pyproject.toml'), '[project]\nname = "test"\n');
        const detected = detect_project(temp_dir);
        expect(detected).toHaveLength(1);
        expect(detected[0].language).toBe('Python');
    });

    it('detects Go from go.mod', () => {
        fs.writeFileSync(path.join(temp_dir, 'go.mod'), 'module example.com/test\n');
        const detected = detect_project(temp_dir);
        expect(detected).toHaveLength(1);
        expect(detected[0].language).toBe('Go');
        expect(detected[0].image).toMatch(/^golang:/);
    });

    it('detects Rust from Cargo.toml', () => {
        fs.writeFileSync(path.join(temp_dir, 'Cargo.toml'), '[package]\nname = "test"\n');
        const detected = detect_project(temp_dir);
        expect(detected).toHaveLength(1);
        expect(detected[0].language).toBe('Rust');
        expect(detected[0].image).toMatch(/^rust:/);
    });

    it('detects Ruby from Gemfile', () => {
        fs.writeFileSync(path.join(temp_dir, 'Gemfile'), 'source "https://rubygems.org"\n');
        const detected = detect_project(temp_dir);
        expect(detected).toHaveLength(1);
        expect(detected[0].language).toBe('Ruby');
    });

    it('detects Java from pom.xml', () => {
        fs.writeFileSync(path.join(temp_dir, 'pom.xml'), '<project></project>\n');
        const detected = detect_project(temp_dir);
        expect(detected).toHaveLength(1);
        expect(detected[0].language).toBe('Java');
    });

    it('detects multiple languages', () => {
        fs.writeFileSync(path.join(temp_dir, 'package.json'), '{}');
        fs.writeFileSync(path.join(temp_dir, 'requirements.txt'), 'flask\n');
        const detected = detect_project(temp_dir);
        expect(detected).toHaveLength(2);
        expect(detected[0].language).toBe('Node.js');
        expect(detected[1].language).toBe('Python');
    });

    it('deduplicates same language from multiple markers', () => {
        fs.writeFileSync(path.join(temp_dir, 'pyproject.toml'), '[project]\n');
        fs.writeFileSync(path.join(temp_dir, 'requirements.txt'), 'flask\n');
        const detected = detect_project(temp_dir);
        expect(detected).toHaveLength(1);
        expect(detected[0].language).toBe('Python');
        expect(detected[0].marker).toBe('pyproject.toml');
    });

    it('returns empty for unknown project', () => {
        const detected = detect_project(temp_dir);
        expect(detected).toHaveLength(0);
    });

    it('detects PHP from composer.json', () => {
        fs.writeFileSync(path.join(temp_dir, 'composer.json'), '{}');
        const detected = detect_project(temp_dir);
        expect(detected).toHaveLength(1);
        expect(detected[0].language).toBe('PHP');
        expect(detected[0].image).toBe('php:8.3-cli');
        expect(detected[0].marker).toBe('composer.json');
    });

    it('resolves require.php constraint to highest known satisfying version', () => {
        fs.writeFileSync(path.join(temp_dir, 'composer.json'), JSON.stringify({
            require: { php: '^8.1' },
        }));
        const detected = detect_project(temp_dir);
        expect(detected[0].image).toBe('php:8.4-cli');
    });

    it('resolves major-only caret constraint to highest matching major', () => {
        fs.writeFileSync(path.join(temp_dir, 'composer.json'), JSON.stringify({
            require: { php: '^8' },
        }));
        const detected = detect_project(temp_dir);
        expect(detected[0].image).toBe('php:8.4-cli');
    });

    it('detects current project as Node.js', () => {
        const detected = detect_project(path.resolve(__dirname, '..', '..', '..'));
        expect(detected.some((d) => d.language === 'Node.js')).toBe(true);
    });

    it('detects Java from build.gradle', () => {
        fs.writeFileSync(path.join(temp_dir, 'build.gradle'), 'plugins {}\n');
        const detected = detect_project(temp_dir);
        expect(detected).toHaveLength(1);
        expect(detected[0].language).toBe('Java');
        expect(detected[0].marker).toBe('build.gradle');
    });
});

// The built-in Node.js detector's extract_image hook has several
// null-fallthrough branches: malformed JSON, non-object JSON root,
// engines field missing/null/non-object, engines.node not a string,
// and engines.node with no numeric prefix. Each MUST fall back to the
// detector's default image (`node:22-slim`) rather than throw or return
// a malformed image string. The happy-path (semver → `node:N-slim`) is
// covered by the 'reads node version from engines field' test above.
describe('detect_project — Node.js extract_image fallthroughs', () => {
    let temp_dir: string;

    beforeEach(() => {
        temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-version-hint-'));
    });

    afterEach(() => {
        fs.rmSync(temp_dir, { recursive: true, force: true });
    });

    it('falls back to default image when package.json is malformed JSON', () => {
        fs.writeFileSync(path.join(temp_dir, 'package.json'), '{ not: valid json ');
        const detected = detect_project(temp_dir);
        expect(detected[0].image).toBe('node:22-slim');
    });

    it('falls back to default image when package.json is the literal null', () => {
        fs.writeFileSync(path.join(temp_dir, 'package.json'), 'null');
        const detected = detect_project(temp_dir);
        expect(detected[0].image).toBe('node:22-slim');
    });

    it('falls back to default image when package.json is a top-level string', () => {
        fs.writeFileSync(path.join(temp_dir, 'package.json'), '"a string"');
        const detected = detect_project(temp_dir);
        expect(detected[0].image).toBe('node:22-slim');
    });

    it('falls back to default image when engines is the literal null', () => {
        fs.writeFileSync(path.join(temp_dir, 'package.json'), JSON.stringify({ engines: null }));
        const detected = detect_project(temp_dir);
        expect(detected[0].image).toBe('node:22-slim');
    });

    // Behavior change accepted in the declarative migration (design Decision 3):
    // the prior code closure rejected a non-string engines.node and fell back to
    // the default; the json-pointer scalar-coercion rule stringifies a numeric
    // value and pins from it. `20` (≠ the 22 default) proves the coercion path.
    it('coerces a numeric engines.node and pins from it (declarative divergence)', () => {
        fs.writeFileSync(path.join(temp_dir, 'package.json'), JSON.stringify({
            engines: { node: 20 },
        }));
        const detected = detect_project(temp_dir);
        expect(detected[0].image).toBe('node:20-slim');
    });

    it('falls back to default image when engines.node has no digits', () => {
        fs.writeFileSync(path.join(temp_dir, 'package.json'), JSON.stringify({
            engines: { node: 'lts' },
        }));
        const detected = detect_project(temp_dir);
        expect(detected[0].image).toBe('node:22-slim');
    });
});
