import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
    register_user_global_language_detectors,
    discover_user_global_language_manifest_paths,
    register_builtin_language_detectors,
    _reset_language_detectors,
    list_language_detectors,
    detect_project,
} from '../../../src/languages/index.js';
import { install_recording_logger_hooks, filter_recorded_messages } from '../../helpers/recording_logger.js';

describe('user-global language manifest discovery', () => {
    const recording = install_recording_logger_hooks();
    let home: string;
    let project: string;
    let languages_dir: string;

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-lang-home-'));
        project = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-lang-proj-'));
        languages_dir = path.join(home, '.patchlab', 'languages');
        fs.mkdirSync(languages_dir, { recursive: true });
        // Isolate the shared registry: start from a known built-in-only state.
        _reset_language_detectors();
        register_builtin_language_detectors();
    });

    afterEach(() => {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(project, { recursive: true, force: true });
    });

    function write_manifest(name: string, contents: string): void {
        fs.writeFileSync(path.join(languages_dir, name), contents);
    }

    function load(): void {
        register_user_global_language_detectors({ homedir_resolver: () => home });
    }

    function warnings(): string[] {
        return filter_recorded_messages(recording.current(), 'warn');
    }

    it('adds a new language and pins the image from the manifest', () => {
        write_manifest('go.yaml',
            'language: Go\nmarker: go.mod\ndefault_image: golang:1.22\n'
            + "version:\n  strategy: regex\n  pattern: '^go (\\d+)\\.(\\d+)'\n  image_template: 'golang:{1}.{2}'\n");
        load();
        fs.writeFileSync(path.join(project, 'go.mod'), 'module example.com/x\n\ngo 1.21\n');

        const go = detect_project(project).find((detected) => detected.language === 'Go');
        expect(go?.image).toBe('golang:1.21');
    });

    it('overrides a built-in detector by marker with no override flag', () => {
        write_manifest('node.yaml', 'language: Node.js\nmarker: package.json\ndefault_image: node:20-bookworm\n');
        load();
        fs.writeFileSync(path.join(project, 'package.json'), '{}');

        const node = detect_project(project).find((detected) => detected.language === 'Node.js');
        expect(node?.image).toBe('node:20-bookworm');
        expect(warnings()).toHaveLength(0);
    });

    it('resolves two same-marker manifests last-wins by alphabetical filename', () => {
        write_manifest('a-node.yaml', 'language: Node.js\nmarker: package.json\ndefault_image: node:18-slim\n');
        write_manifest('b-node.yaml', 'language: Node.js\nmarker: package.json\ndefault_image: node:20-slim\n');
        load();
        fs.writeFileSync(path.join(project, 'package.json'), '{}');

        const node = detect_project(project).find((detected) => detected.language === 'Node.js');
        expect(node?.image).toBe('node:20-slim');
    });

    it('returns no manifests and does not throw when the directory is absent', () => {
        const empty_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-lang-empty-'));
        try {
            const before = list_language_detectors().length;
            expect(discover_user_global_language_manifest_paths({ homedir_resolver: () => empty_home })).toEqual([]);
            expect(() => register_user_global_language_detectors({ homedir_resolver: () => empty_home })).not.toThrow();
            expect(list_language_detectors()).toHaveLength(before);
        } finally {
            fs.rmSync(empty_home, { recursive: true, force: true });
        }
    });

    it('does not throw and yields no manifests when the directory path is unreadable', () => {
        const broken_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-lang-broken-'));
        fs.mkdirSync(path.join(broken_home, '.patchlab'), { recursive: true });
        // Make `languages` a regular file, not a directory, so readdir fails
        // with a non-ENOENT error (ENOTDIR on POSIX). The contract is that
        // discovery never throws and yields no manifests regardless.
        fs.writeFileSync(path.join(broken_home, '.patchlab', 'languages'), 'not a directory');
        try {
            let result: string[] = ['sentinel'];
            expect(() => {
                result = discover_user_global_language_manifest_paths({ homedir_resolver: () => broken_home });
            }).not.toThrow();
            expect(result).toEqual([]);
            // On POSIX the non-ENOENT error is warned; on Windows the readdir
            // error code varies, so only the no-throw/empty contract is asserted.
            if (process.platform !== 'win32') {
                expect(warnings().some((message) => message.includes('Could not read language-manifest directory'))).toBe(true);
            }
        } finally {
            fs.rmSync(broken_home, { recursive: true, force: true });
        }
    });

    it('skips a malformed-YAML manifest while keeping built-ins and well-formed manifests', () => {
        write_manifest('bad.yaml', 'language: Go\n  marker: [unclosed');
        write_manifest('good.yaml', 'language: Go\nmarker: go.mod\ndefault_image: golang:1.21\n');
        load();

        expect(warnings().some((message) => message.includes('Skipping invalid language manifest') && message.includes('bad.yaml'))).toBe(true);
        // Built-ins still present.
        expect(list_language_detectors().some((detector) => detector.marker === 'package.json')).toBe(true);
        // Well-formed manifest registered (overrode the Go built-in's default).
        const go = list_language_detectors().find((detector) => detector.marker === 'go.mod');
        expect(go?.default_image).toBe('golang:1.21');
    });

    it('skips a manifest with an unknown field, naming the field', () => {
        write_manifest('typo.yaml', 'language: Go\nmarker: go.mod\ndefault_image: golang:1.22\ndefaultimage: golang:1.21\n');
        load();
        expect(warnings().some((message) => message.includes('typo.yaml') && message.includes('defaultimage'))).toBe(true);
    });

    it('skips a manifest whose marker contains a path separator', () => {
        write_manifest('evil.yaml', 'language: X\nmarker: ../package.json\ndefault_image: x:1\n');
        load();
        expect(warnings().some((message) => message.includes('bare filename'))).toBe(true);
    });

    it('skips a manifest that exceeds the 64 KiB size cap and warns', () => {
        const oversized = 'language: CustomLang\nmarker: custom.lockfile\ndefault_image: custom:1.0\n'
            + '#'.repeat(66 * 1024);
        write_manifest('too-large.yaml', oversized);
        load();
        expect(warnings().some(
            (message) => message.includes('too-large.yaml') && message.includes('byte cap'),
        )).toBe(true);
        // The oversized manifest must not register any detector
        expect(list_language_detectors().some((detector) => detector.marker === 'custom.lockfile')).toBe(false);
    });

    it('loads manifests in ascending filename order regardless of write order', () => {
        write_manifest('z-last.yaml', 'language: Go\nmarker: go.mod\ndefault_image: golang:1.20\n');
        write_manifest('a-first.yaml', 'language: Rust\nmarker: Cargo.toml\ndefault_image: rust:1.80\n');
        const ordered = discover_user_global_language_manifest_paths({ homedir_resolver: () => home })
            .map((manifest_path) => path.basename(manifest_path));
        expect(ordered).toEqual(['a-first.yaml', 'z-last.yaml']);
    });

    it('follows a symlinked manifest file and skips directory entries', () => {
        // Symlink creation needs privileges on Windows; the directory-skip half
        // of the behavior is still asserted there.
        const subdirectory = path.join(languages_dir, 'nested');
        fs.mkdirSync(subdirectory);

        if (process.platform !== 'win32') {
            const target = path.join(home, 'real-go.yaml');
            fs.writeFileSync(target, 'language: Go\nmarker: go.mod\ndefault_image: golang:1.19\n');
            fs.symlinkSync(target, path.join(languages_dir, 'linked.yaml'));
        }

        const discovered = discover_user_global_language_manifest_paths({ homedir_resolver: () => home })
            .map((manifest_path) => path.basename(manifest_path));

        expect(discovered).not.toContain('nested');
        if (process.platform !== 'win32') {
            expect(discovered).toContain('linked.yaml');
        }
    });
});
