import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
    load_overrides,
    load_sources_from_manifest,
    save_overrides,
    update_overrides,
    type Patchlab_Overrides,
} from '../../src/overrides.js';
import { ConsoleLogger, set_logger } from '../../src/logger.js';
import { RecordingLogger } from '../helpers/recording_logger.js';
import { initialize_repository_with_initial_commit } from '../helpers/git_repository.js';

describe('overrides', () => {
    let temp_dir: string;

    beforeEach(() => {
        temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-overrides-'));
    });

    afterEach(() => {
        fs.rmSync(temp_dir, { recursive: true, force: true });
    });

    function write_config(content: object): void {
        fs.writeFileSync(path.join(temp_dir, '.patchlab.json'), JSON.stringify(content));
    }

    describe('load_overrides', () => {
        it('returns empty when no .patchlab.json exists', () => {
            const result = load_overrides(temp_dir);
            expect(result).toEqual({});
        });

        it('loads valid .patchlab.json', () => {
            write_config({
                requirements: {
                    system_packages: ['curl'],
                    environment_variables: { DATABASE_URL: 'postgres://localhost/dev' },
                },
                allow_socket_mount: true,
            });
            const result = load_overrides(temp_dir);
            expect(result.requirements?.system_packages).toEqual(['curl']);
            expect(result.allow_socket_mount).toBe(true);
        });

        it('throws on invalid JSON structure', () => {
            fs.writeFileSync(path.join(temp_dir, '.patchlab.json'), '"not an object"');
            expect(() => load_overrides(temp_dir))
                .toThrow(/expected the parsed JSON to be an object; got string/);
        });

        it('throws on invalid requirements type', () => {
            write_config({ requirements: 'bad' });
            expect(() => load_overrides(temp_dir)).toThrow('"requirements" must be an object');
        });

        it('throws on invalid system_packages type', () => {
            write_config({ requirements: { system_packages: 'not-array' } });
            expect(() => load_overrides(temp_dir)).toThrow('"requirements.system_packages" must be an array');
        });

        it('throws on invalid volume_mounts type', () => {
            write_config({ requirements: { volume_mounts: 'not-array' } });
            expect(() => load_overrides(temp_dir)).toThrow('"requirements.volume_mounts" must be an array');
        });

        it('throws on invalid npm_packages type', () => {
            write_config({ requirements: { npm_packages: 42 } });
            expect(() => load_overrides(temp_dir)).toThrow('"requirements.npm_packages" must be an array');
        });

        it('throws on invalid environment_variables type', () => {
            // `environment_variables` must be a non-null, non-array object. An
            // array would pass `typeof === 'object'` so the guard explicitly
            // rejects arrays alongside primitives.
            write_config({ requirements: { environment_variables: ['not', 'an', 'object'] } });
            expect(() => load_overrides(temp_dir))
                .toThrow('"requirements.environment_variables" must be an object');
        });

        it('throws when system_packages contains a non-string element', () => {
            write_config({ requirements: { system_packages: ['curl', 42] } });
            expect(() => load_overrides(temp_dir))
                .toThrow('"requirements.system_packages" elements must be strings');
        });

        it('throws when npm_packages contains a non-string element', () => {
            write_config({ requirements: { npm_packages: [true] } });
            expect(() => load_overrides(temp_dir))
                .toThrow('"requirements.npm_packages" elements must be strings');
        });

        it('throws when an environment_variables value is not a string', () => {
            write_config({ requirements: { environment_variables: { PORT: 8080 } } });
            expect(() => load_overrides(temp_dir))
                .toThrow('"requirements.environment_variables.PORT" must be a string');
        });

        it('throws on invalid ignore_detected type', () => {
            write_config({ ignore_detected: 'not-array' });
            expect(() => load_overrides(temp_dir)).toThrow('"ignore_detected" must be an array');
        });

        it('throws on invalid allow_socket_mount type', () => {
            write_config({ allow_socket_mount: 'yes' });
            expect(() => load_overrides(temp_dir)).toThrow('"allow_socket_mount" must be a boolean');
        });

        it('warns on unknown top-level fields', () => {
            const recording = new RecordingLogger();
            set_logger(recording);
            try {
                write_config({ unknown_field: true });
                load_overrides(temp_dir);
            } finally {
                set_logger(new ConsoleLogger());
            }
            const warnings = recording.calls
                .filter((call) => call.method === 'warn')
                .map((call) => String(call.message));
            expect(warnings.some((w) => w.includes("unknown field 'unknown_field'"))).toBe(true);
        });

        it('warns on unknown requirements sub-fields', () => {
            const recording = new RecordingLogger();
            set_logger(recording);
            try {
                write_config({ requirements: { custom_thing: [] } });
                load_overrides(temp_dir);
            } finally {
                set_logger(new ConsoleLogger());
            }
            const warnings = recording.calls
                .filter((call) => call.method === 'warn')
                .map((call) => String(call.message));
            expect(warnings.some((w) => w.includes("unknown field 'requirements.custom_thing'"))).toBe(true);
        });
    });

    describe('save_overrides', () => {
        it('writes .patchlab.json with pretty-printed JSON', () => {
            const overrides: Patchlab_Overrides = {
                requirements: {
                    system_packages: ['curl', 'git'],
                    environment_variables: { DATABASE_URL: 'postgres://localhost/dev' },
                },
                allow_socket_mount: true,
            };
            save_overrides(temp_dir, overrides);

            const written = fs.readFileSync(path.join(temp_dir, '.patchlab.json'), 'utf-8');
            expect(written).toContain('\n    '); // 4-space indent
            expect(JSON.parse(written)).toEqual(overrides);
        });

        it('overwrites an existing .patchlab.json (full-file replace, not merge)', () => {
            write_config({ requirements: { system_packages: ['old-package'] } });

            save_overrides(temp_dir, { requirements: { npm_packages: ['lodash'] } });

            const written = JSON.parse(fs.readFileSync(path.join(temp_dir, '.patchlab.json'), 'utf-8'));
            expect(written).toEqual({ requirements: { npm_packages: ['lodash'] } });
            expect(written.requirements.system_packages).toBeUndefined();
        });

        it('leaves no .tmp.* files behind on success (atomic-rename cleanup)', () => {
            save_overrides(temp_dir, { allow_socket_mount: false });

            const stragglers = fs.readdirSync(temp_dir).filter((entry) => entry.startsWith('.patchlab.json.tmp.'));
            expect(stragglers).toEqual([]);
        });

        it('round-trips through load_overrides', () => {
            const overrides: Patchlab_Overrides = {
                requirements: {
                    volume_mounts: ['/host/data:/container/data'],
                    npm_packages: ['typescript'],
                },
                ignore_detected: ['mariadb'],
            };
            save_overrides(temp_dir, overrides);
            expect(load_overrides(temp_dir)).toEqual(overrides);
        });
    });

    describe('update_overrides', () => {
        it('reads empty when no .patchlab.json exists, applies the updater, and writes the result', () => {
            update_overrides(temp_dir, (current) => {
                expect(current).toEqual({});
                return { allow_socket_mount: true };
            });

            expect(load_overrides(temp_dir)).toEqual({ allow_socket_mount: true });
        });

        it('passes the existing overrides to the updater for read-modify-write', () => {
            write_config({ requirements: { system_packages: ['curl'] } });

            update_overrides(temp_dir, (current) => {
                expect(current.requirements?.system_packages).toEqual(['curl']);
                return {
                    ...current,
                    requirements: {
                        ...current.requirements,
                        system_packages: [...(current.requirements?.system_packages ?? []), 'git'],
                    },
                };
            });

            expect(load_overrides(temp_dir).requirements?.system_packages).toEqual(['curl', 'git']);
        });

        it('does not write when the updater throws', () => {
            write_config({ allow_socket_mount: false });

            expect(() => update_overrides(temp_dir, () => {
                throw new Error('updater rejected');
            })).toThrow(/updater rejected/);

            // The original content survives untouched.
            expect(load_overrides(temp_dir)).toEqual({ allow_socket_mount: false });
        });
    });

    describe('validate_sources_field (via load_overrides)', () => {
        // `validate_sources_field` is an internal function; its behaviour is
        // exercised through `load_overrides`, which calls it after the top-level
        // structure checks.

        it('accepts a missing sources field', () => {
            write_config({ allow_socket_mount: true });
            // Should not throw.
            const result = load_overrides(temp_dir);
            expect(result.sources).toBeUndefined();
        });

        it('accepts an empty sources array', () => {
            write_config({ sources: [] });
            expect(load_overrides(temp_dir).sources).toEqual([]);
        });

        it('accepts an array of valid non-empty strings', () => {
            write_config({ sources: ['patchlab', 'patchlab/src'] });
            expect(load_overrides(temp_dir).sources).toEqual(['patchlab', 'patchlab/src']);
        });

        it('accepts an array of valid { path, mount } objects', () => {
            const entry = { path: 'repo/src', mount: 'src' };
            write_config({ sources: [entry] });
            expect(load_overrides(temp_dir).sources).toEqual([entry]);
        });

        it('accepts a mixed array of strings and objects', () => {
            const entries = ['patchlab', { path: 'other/src', mount: 'other' }];
            write_config({ sources: entries });
            expect(load_overrides(temp_dir).sources).toEqual(entries);
        });

        it('throws when sources is not an array', () => {
            write_config({ sources: 'patchlab' });
            expect(() => load_overrides(temp_dir)).toThrow(/"sources" must be an array/);
        });

        it('throws when a string entry is empty', () => {
            write_config({ sources: [''] });
            expect(() => load_overrides(temp_dir)).toThrow(/"sources\[0\]" must be a non-empty string/);
        });

        it('throws when an entry is a number', () => {
            write_config({ sources: [42] });
            expect(() => load_overrides(temp_dir)).toThrow(/"sources\[0\]" must be a string or \{ path, mount \} object/);
        });

        it('throws when an entry is an array', () => {
            write_config({ sources: [['patchlab']] });
            expect(() => load_overrides(temp_dir)).toThrow(/"sources\[0\]" must be a string or \{ path, mount \} object/);
        });

        it('throws when an object entry is missing path', () => {
            write_config({ sources: [{ mount: 'src' }] });
            expect(() => load_overrides(temp_dir)).toThrow(/"sources\[0\]\.path" must be a non-empty string/);
        });

        it('throws when an object entry has empty path', () => {
            write_config({ sources: [{ path: '', mount: 'src' }] });
            expect(() => load_overrides(temp_dir)).toThrow(/"sources\[0\]\.path" must be a non-empty string/);
        });

        it('throws when an object entry is missing mount', () => {
            write_config({ sources: [{ path: 'patchlab/src' }] });
            expect(() => load_overrides(temp_dir)).toThrow(/"sources\[0\]\.mount" must be a non-empty string/);
        });

        it('throws when an object entry has empty mount', () => {
            write_config({ sources: [{ path: 'patchlab/src', mount: '' }] });
            expect(() => load_overrides(temp_dir)).toThrow(/"sources\[0\]\.mount" must be a non-empty string/);
        });

        it('names the correct index in the error for the second bad element', () => {
            write_config({ sources: ['ok', 42] });
            expect(() => load_overrides(temp_dir)).toThrow(/"sources\[1\]"/);
        });

        it('warns on unknown fields in a { path, mount } object entry', () => {
            const recording = new RecordingLogger();
            set_logger(recording);
            try {
                write_config({ sources: [{ path: 'patchlab', mount: 'patchlab', extra_key: true }] });
                load_overrides(temp_dir);
            } finally {
                set_logger(new ConsoleLogger());
            }

            const warnings = recording.calls
                .filter((call) => call.method === 'warn')
                .map((call) => String(call.message));
            expect(warnings.some((w) => w.includes("'extra_key'") && w.includes('sources[0]'))).toBe(true);
        });
    });

});

/**
 * Normalize path separators to forward slashes for cross-platform equality
 * assertions. `get_repository_root` delegates to `git rev-parse --show-toplevel`,
 * which always returns forward-slash paths; `fs.mkdtempSync` returns native-
 * separator paths on Windows. macOS may add a `/private` prefix via realpath.
 * Compare through `canonical_path()` so both representations resolve to the same
 * location before asserting equality.
 */
function to_forward_slashes(value: string): string {
    return value.replaceAll('\\', '/');
}

/** Canonicalize for equality: realpath (macOS `/var` vs `/private/var`) then `/`. */
function canonical_path(value: string): string {
    return to_forward_slashes(fs.realpathSync(value));
}

describe('load_sources_from_manifest', () => {
    // Each `load_sources_from_manifest` test needs a clean temp directory so
    // that stray `.patchlab.json` files from one test cannot influence others.
    // Use per-test setup/teardown rather than the outer `overrides` describe's
    // shared `temp_dir`.
    let cwd: string;

    beforeEach(() => {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-sources-manifest-'));
    });

    afterEach(() => {
        fs.rmSync(cwd, { recursive: true, force: true });
    });

    function write_patchlab_json(directory: string, content: object): void {
        fs.writeFileSync(path.join(directory, '.patchlab.json'), JSON.stringify(content));
    }

    it('returns undefined when CWD has no .patchlab.json', () => {
        // `cwd` is a plain temp dir outside any git repo.
        expect(load_sources_from_manifest(cwd)).toBeUndefined();
    });

    it('returns undefined when CWD has .patchlab.json without sources field', () => {
        write_patchlab_json(cwd, { allow_socket_mount: true });
        expect(load_sources_from_manifest(cwd)).toBeUndefined();
    });

    it('returns undefined when sources array is present but empty', () => {
        // This also locks in the invariant that `load_sources_from_manifest`
        // never returns a defined result with an empty `entries` array — the
        // empty-array case collapses to `undefined` so callers need not guard
        // against `discovered.entries.length === 0` separately.
        write_patchlab_json(cwd, { sources: [] });
        expect(load_sources_from_manifest(cwd)).toBeUndefined();
    });

    it('returns entries from CWD .patchlab.json when sources is present and non-empty', () => {
        write_patchlab_json(cwd, { sources: ['patchlab'] });
        const discovered = load_sources_from_manifest(cwd);
        expect(discovered).not.toBeUndefined();
        expect(discovered?.entries).toEqual(['patchlab']);
        expect(discovered?.base_directory).toBe(cwd);
    });

    it('does not throw when CWD is not inside a git repository', () => {
        // The git-root fallback probe must be silently skipped for non-repo CWDs.
        // `cwd` is a bare temp dir (no .git) — no error should surface.
        expect(() => load_sources_from_manifest(cwd)).not.toThrow();
        expect(load_sources_from_manifest(cwd)).toBeUndefined();
    });

    it('falls back to the git root when CWD has no .patchlab.json but the git root does', () => {
        // Build a git repository at `git_root`, then work from a subdirectory
        // inside it that has no .patchlab.json of its own.
        const git_root = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-sm-gitroot-'));
        try {
            initialize_repository_with_initial_commit(git_root);
            write_patchlab_json(git_root, { sources: ['patchlab'] });

            // Work from a subdirectory inside the git root that has no .patchlab.json.
            const subdirectory = path.join(git_root, 'subdir');
            fs.mkdirSync(subdirectory);

            const discovered = load_sources_from_manifest(subdirectory);
            expect(discovered).not.toBeUndefined();
            expect(discovered?.entries).toEqual(['patchlab']);
            // `get_repository_root` returns forward-slash paths (git output);
            // compare after normalizing both sides to forward slashes.
            expect(canonical_path(discovered?.base_directory ?? '')).toBe(
                canonical_path(git_root),
            );
        } finally {
            fs.rmSync(git_root, { recursive: true, force: true });
        }
    });

    it('CWD manifest wins when both CWD and git root have .patchlab.json with sources', () => {
        const git_root = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-sm-cwdwins-'));
        try {
            initialize_repository_with_initial_commit(git_root);
            write_patchlab_json(git_root, { sources: ['from-git-root'] });

            // The subdirectory also has its own .patchlab.json — it should win.
            const subdirectory = path.join(git_root, 'workspace');
            fs.mkdirSync(subdirectory);
            write_patchlab_json(subdirectory, { sources: ['from-cwd'] });

            const discovered = load_sources_from_manifest(subdirectory);
            expect(discovered?.entries).toEqual(['from-cwd']);
            // CWD path comes directly from `path.join` (native separators on
            // Windows). `load_sources_from_manifest` returns it verbatim from
            // the `working_directory` argument, so native comparison is correct.
            expect(discovered?.base_directory).toBe(subdirectory);
        } finally {
            fs.rmSync(git_root, { recursive: true, force: true });
        }
    });

    it('skips the git-root fallback when CWD is itself the git root', () => {
        // When git_root === resolved CWD, there is no distinct git-root to
        // check — the function must return undefined rather than re-checking
        // the same directory and returning empty-sources as undefined.
        const git_root = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-sm-isroot-'));
        try {
            initialize_repository_with_initial_commit(git_root);
            // No .patchlab.json at the git root.
            expect(load_sources_from_manifest(git_root)).toBeUndefined();
        } finally {
            fs.rmSync(git_root, { recursive: true, force: true });
        }
    });
});
