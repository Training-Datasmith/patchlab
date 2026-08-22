import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expand_manifest_sources, resolve_source_inputs } from '../../src/sources.js';
import { canonical_host_path } from '../../src/archive.js';
import { initialize_repository_with_initial_commit } from '../helpers/git_repository.js';

/**
 * Normalize backslashes to forward slashes for cross-platform path equality.
 * `git rev-parse --show-toplevel` returns forward-slash paths on every host;
 * `canonical_host_path` returns native-separator paths on Windows. The two
 * representations are semantically identical for the same on-disk location,
 * so the tests compare them after normalization.
 */
function to_forward_slashes(value: string): string {
    return value.replaceAll('\\', '/');
}

function compare_host_path(value: string): string {
    return to_forward_slashes(canonical_host_path(value));
}

// Hoisted fixture: every test in this file calls `resolve_source_inputs`,
// which reads `git rev-parse --show-toplevel` and asserts the host directory
// exists. No test mutates the repository's commits, branches, refs, working
// tree, or .git/ state — they only create subdirectories under the
// repository (via `mkdirSync({recursive: true})`, idempotent). Sharing
// the two temp repositories across all tests saves 24 × ~300 ms = ~7 s on
// Windows. A future test that adds commits or branches must declare its own
// per-test repository to preserve isolation.
describe('resolve_source_inputs', () => {
    let repository: string;
    let other_repository: string;

    beforeAll(() => {
        repository = canonical_host_path(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-sources-')));
        initialize_repository_with_initial_commit(repository);
        other_repository = canonical_host_path(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-sources-other-')));
        initialize_repository_with_initial_commit(other_repository);
    });

    afterAll(() => {
        fs.rmSync(repository, { recursive: true, force: true });
        fs.rmSync(other_repository, { recursive: true, force: true });
    });

    it('single source at repo root yields one entry with empty source_prefix', () => {
        const sources = resolve_source_inputs(repository, []);
        expect(sources).toHaveLength(1);
        expect(compare_host_path(sources[0].repository_root)).toBe(compare_host_path(repository));
        expect(sources[0].source_prefix).toBe('');
        expect(sources[0].mount_name).toBe('');
        expect(compare_host_path(sources[0].host_path)).toBe(compare_host_path(repository));
    });

    it('single source at subdirectory yields one entry with derived prefix', () => {
        const subdirectory = path.join(repository, 'src', 'ui');
        fs.mkdirSync(subdirectory, { recursive: true });
        const sources = resolve_source_inputs(subdirectory, []);
        expect(sources).toHaveLength(1);
        expect(compare_host_path(sources[0].repository_root)).toBe(compare_host_path(repository));
        expect(sources[0].source_prefix).toBe('src/ui');
        expect(sources[0].mount_name).toBe('src/ui');
    });

    it('two sibling sources in the same repo yield two entries sharing repository_root', () => {
        const ui = path.join(repository, 'src', 'ui');
        const server = path.join(repository, 'src', 'server');
        fs.mkdirSync(ui, { recursive: true });
        fs.mkdirSync(server, { recursive: true });

        const sources = resolve_source_inputs(ui, [server]);
        expect(sources).toHaveLength(2);
        expect(compare_host_path(sources[0].repository_root)).toBe(compare_host_path(repository));
        expect(compare_host_path(sources[1].repository_root)).toBe(compare_host_path(repository));
        expect(sources[0].source_prefix).toBe('src/ui');
        expect(sources[1].source_prefix).toBe('src/server');
    });

    it('rejects multi-repo sources without explicit --mount on every source', () => {
        // Without explicit --mount, the multi-repo case is rejected because
        // source_prefix is per-repo and the same prefix (e.g., "src") could
        // appear in both repos with no useful default.
        expect(() => resolve_source_inputs(repository, [other_repository])).toThrow(
            /every source MUST be supplied with an explicit --mount/i,
        );
    });

    it('accepts multi-repo sources when every source supplies --mount', () => {
        const sources = resolve_source_inputs(
            { host_path: repository, mount_name: 'a' },
            [{ host_path: other_repository, mount_name: 'b' }],
        );
        expect(sources).toHaveLength(2);
        expect(compare_host_path(sources[0].repository_root)).toBe(compare_host_path(repository));
        expect(compare_host_path(sources[1].repository_root)).toBe(compare_host_path(other_repository));
        expect(sources[0].mount_name).toBe('a');
        expect(sources[1].mount_name).toBe('b');
    });

    it('rejects multi-repo create when only some sources have --mount', () => {
        expect(() =>
            resolve_source_inputs(
                { host_path: repository, mount_name: 'a' },
                [{ host_path: other_repository }],
            ),
        ).toThrow(/every source MUST be supplied with an explicit --mount/i);
    });

    it('accepts same-prefix sources across different repositories with explicit mounts', () => {
        const src_a = path.join(repository, 'src');
        const src_b = path.join(other_repository, 'src');
        fs.mkdirSync(src_a, { recursive: true });
        fs.mkdirSync(src_b, { recursive: true });

        const sources = resolve_source_inputs(
            { host_path: src_a, mount_name: 'a-src' },
            [{ host_path: src_b, mount_name: 'b-src' }],
        );
        expect(sources).toHaveLength(2);
        expect(sources[0].source_prefix).toBe('src');
        expect(sources[1].source_prefix).toBe('src');
        expect(sources[0].mount_name).toBe('a-src');
        expect(sources[1].mount_name).toBe('b-src');
    });

    it('rejects mount-name collision across different repositories', () => {
        expect(() =>
            resolve_source_inputs(
                { host_path: repository, mount_name: 'shared' },
                [{ host_path: other_repository, mount_name: 'shared' }],
            ),
        ).toThrow(/mount names must be unique/i);
    });

    it('rejects nested-prefix overlap within one repository', () => {
        const outer = path.join(repository, 'src');
        const inner = path.join(repository, 'src', 'ui');
        fs.mkdirSync(inner, { recursive: true });

        expect(() => resolve_source_inputs(outer, [inner])).toThrow(/path-component prefix/i);
    });

    it('accepts nested-prefix overlap across different repositories', () => {
        const a_src = path.join(repository, 'src');
        const b_src_ui = path.join(other_repository, 'src', 'ui');
        fs.mkdirSync(a_src, { recursive: true });
        fs.mkdirSync(b_src_ui, { recursive: true });

        const sources = resolve_source_inputs(
            { host_path: a_src, mount_name: 'a-src' },
            [{ host_path: b_src_ui, mount_name: 'b-ui' }],
        );
        expect(sources).toHaveLength(2);
        expect(sources[0].source_prefix).toBe('src');
        expect(sources[1].source_prefix).toBe('src/ui');
    });

    it('rejects two sources that resolve to the same source_prefix (symlink collision proxy)', () => {
        // Two paths whose `path.resolve` results both reduce to the same
        // repo-relative source_prefix: `./src` and a second physical
        // directory that happens to be the same on disk. We approximate
        // this by passing the same resolved path twice.
        const subdirectory = path.join(repository, 'src', 'ui');
        fs.mkdirSync(subdirectory, { recursive: true });

        expect(() => resolve_source_inputs(subdirectory, [subdirectory])).toThrow(
            /must be unique/i,
        );
    });

    it('rejects empty-prefix source combined with another source', () => {
        const subdirectory = path.join(repository, 'src');
        fs.mkdirSync(subdirectory, { recursive: true });

        expect(() => resolve_source_inputs(repository, [subdirectory])).toThrow(
            /shadow every sibling/i,
        );
    });

    it('rejects nested-prefix overlap (src vs src/ui)', () => {
        const outer = path.join(repository, 'src');
        const inner = path.join(repository, 'src', 'ui');
        fs.mkdirSync(inner, { recursive: true });

        expect(() => resolve_source_inputs(outer, [inner])).toThrow(/path-component prefix/i);
    });

    it('accepts sibling prefixes that share a lexical prefix (src vs src2)', () => {
        const src = path.join(repository, 'src');
        const src2 = path.join(repository, 'src2');
        fs.mkdirSync(src, { recursive: true });
        fs.mkdirSync(src2, { recursive: true });

        const sources = resolve_source_inputs(src, [src2]);
        expect(sources).toHaveLength(2);
        expect(sources[0].source_prefix).toBe('src');
        expect(sources[1].source_prefix).toBe('src2');
    });

    it('accepts prefixes whose second components differ (src/ui vs src/ui-old)', () => {
        const ui = path.join(repository, 'src', 'ui');
        const ui_old = path.join(repository, 'src', 'ui-old');
        fs.mkdirSync(ui, { recursive: true });
        fs.mkdirSync(ui_old, { recursive: true });

        const sources = resolve_source_inputs(ui, [ui_old]);
        expect(sources).toHaveLength(2);
        expect(sources[0].source_prefix).toBe('src/ui');
        expect(sources[1].source_prefix).toBe('src/ui-old');
    });

    it('normalizes trailing slashes off source_prefix', () => {
        const subdirectory = path.join(repository, 'src', 'ui');
        fs.mkdirSync(subdirectory, { recursive: true });
        // path.resolve already strips a trailing separator but the helper's
        // contract still says "no trailing slash" — verify explicitly.
        const with_trailing = subdirectory + path.sep;

        const sources = resolve_source_inputs(with_trailing, []);
        expect(sources[0].source_prefix).toBe('src/ui');
        expect(sources[0].source_prefix.endsWith('/')).toBe(false);
    });

    it('collapses . and .. segments in input paths', () => {
        const subdirectory = path.join(repository, 'src', 'ui');
        fs.mkdirSync(subdirectory, { recursive: true });
        // `src/./ui` and `src/../src/ui` both resolve to `src/ui`. `path.resolve`
        // performs the collapse before `get_source_prefix` sees the value.
        const dotted = path.join(repository, 'src', '.', 'ui');
        const back_and_forth = path.join(repository, 'src', '..', 'src', 'ui');

        const fromdot = resolve_source_inputs(dotted, []);
        const fromback = resolve_source_inputs(back_and_forth, []);
        expect(fromdot[0].source_prefix).toBe('src/ui');
        expect(fromback[0].source_prefix).toBe('src/ui');
    });

    it('accepts spaces in source_prefix (git permits them)', () => {
        const spaced = path.join(repository, 'My Code', 'src');
        fs.mkdirSync(spaced, { recursive: true });

        const sources = resolve_source_inputs(spaced, []);
        expect(sources[0].source_prefix).toBe('My Code/src');
    });

    it('rejects case-only nested overlap (Src vs src/ui) under case-insensitive ASCII fold', () => {
        // Some hosts have case-insensitive filesystems where `Src/ui` and
        // `src/ui` resolve identically. The validator rejects on every host
        // to preserve manifest portability.
        const upper = path.join(repository, 'Src');
        const lower_ui = path.join(repository, 'src', 'ui');
        fs.mkdirSync(upper, { recursive: true });
        try {
            fs.mkdirSync(lower_ui, { recursive: true });
        } catch (_ignored) {
            // On case-insensitive filesystems, `Src` and `src` are the same
            // directory; `path.join(repository, 'src')` may already exist.
        }

        expect(() => resolve_source_inputs(upper, [lower_ui])).toThrow(
            /path-component prefix|must be unique/i,
        );
    });

    it('defaults mount_name to source_prefix for same-repo sources without --mount', () => {
        const ui = path.join(repository, 'src', 'ui');
        const server = path.join(repository, 'src', 'server');
        fs.mkdirSync(ui, { recursive: true });
        fs.mkdirSync(server, { recursive: true });

        const sources = resolve_source_inputs(ui, [server]);
        for (const entry of sources) {
            expect(entry.mount_name).toBe(entry.source_prefix);
        }
    });

    it('throws for non-existent source directory', () => {
        // The validator rejects bad paths BEFORE attempting any container or
        // git work. Originally lived in `test/integration/sandbox.test.ts` as
        // `throws for non-existent source directory`; the assertion subject is
        // host-side `resolve_source_inputs` validation, no podman in the path.
        expect(() => resolve_source_inputs('/nonexistent/path', [])).toThrow(/not found/i);
    });

    it('rejects source not in a git repository', () => {
        // `resolve_source_inputs` calls `get_repository_root` which runs
        // `git rev-parse --show-toplevel` — that fails for a path outside any
        // git repository. Originally lived in `test/integration/sandbox.test.ts`
        // as `rejects source not in a git repository`.
        const non_git_directory = canonical_host_path(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-nogit-')));
        try {
            fs.writeFileSync(path.join(non_git_directory, 'file.txt'), 'content\n');
            expect(() => resolve_source_inputs(non_git_directory, [])).toThrow(/git repository/i);
        } finally {
            fs.rmSync(non_git_directory, { recursive: true, force: true });
        }
    });

    it('honors explicit --mount override in a single-repo create', () => {
        const ui = path.join(repository, 'src', 'ui');
        fs.mkdirSync(ui, { recursive: true });

        const sources = resolve_source_inputs(
            { host_path: ui, mount_name: 'frontend' },
            [],
        );
        expect(sources).toHaveLength(1);
        expect(sources[0].source_prefix).toBe('src/ui');
        expect(sources[0].mount_name).toBe('frontend');
    });
});

describe('expand_manifest_sources', () => {
    // `expand_manifest_sources` is a pure path-math function — it does NOT
    // touch the filesystem or run git commands. No temp directories needed.

    const base = '/workspace';

    it('string at base yields host_path = base/string, mount_name = string', () => {
        const result = expand_manifest_sources(['patchlab'], base);
        expect(result).toHaveLength(1);
        expect(result[0].host_path).toBe(path.resolve(base, 'patchlab'));
        expect(result[0].mount_name).toBe('patchlab');
    });

    it('string with subdirectory yields forward-slash mount_name equal to the entry', () => {
        const result = expand_manifest_sources(['patchlab/src'], base);
        expect(result[0].mount_name).toBe('patchlab/src');
        expect(result[0].host_path).toBe(path.resolve(base, 'patchlab/src'));
    });

    it('string with trailing slash has slash stripped from mount_name', () => {
        const result = expand_manifest_sources(['patchlab/'], base);
        expect(result[0].mount_name).toBe('patchlab');
    });

    it('all string entries set mount_name (never undefined)', () => {
        const result = expand_manifest_sources(['a', 'b/c'], base);
        for (const entry of result) {
            expect(entry.mount_name).not.toBeUndefined();
        }
    });

    it('object entry uses entry.path for host_path and entry.mount for mount_name', () => {
        const result = expand_manifest_sources(
            [{ path: 'repo/src', mount: 'frontend' }],
            base,
        );
        expect(result).toHaveLength(1);
        expect(result[0].host_path).toBe(path.resolve(base, 'repo/src'));
        expect(result[0].mount_name).toBe('frontend');
    });

    it('mixed array of strings and objects expands correctly', () => {
        const result = expand_manifest_sources(
            ['patchlab', { path: 'other/lib', mount: 'lib' }],
            base,
        );
        expect(result).toHaveLength(2);
        expect(result[0].mount_name).toBe('patchlab');
        expect(result[1].mount_name).toBe('lib');
    });

    it('absolute path in string entry is used as-is for host_path', () => {
        const absolute = '/absolute/path/to/repo';
        const result = expand_manifest_sources([absolute], base);
        expect(result[0].host_path).toBe(path.resolve(base, absolute));
    });

    it('absolute path in object entry is used as-is for host_path', () => {
        const absolute = '/absolute/path/to/repo';
        const result = expand_manifest_sources([{ path: absolute, mount: 'repo' }], base);
        expect(result[0].host_path).toBe(path.resolve(base, absolute));
    });

    it('empty array returns empty array', () => {
        expect(expand_manifest_sources([], base)).toEqual([]);
    });

    it('Windows backslash in string entry is normalized to forward slashes in mount_name', () => {
        // On any host, a backslash in a manifest string (e.g., from a Windows
        // path entered manually) must produce a forward-slash mount_name so the
        // container path under workspace/ uses the standard separator.
        const result = expand_manifest_sources([String.raw`patchlab\src`], base);
        expect(result[0].mount_name).toBe('patchlab/src');
    });
});

// End-to-end: string entries through expand_manifest_sources → resolve_source_inputs.
//
// The `expand_manifest_sources` unit tests above verify path-math in isolation.
// These tests verify the full chain: string entries produce Source_Input values
// with explicit mount_name that flow correctly through resolve_source_inputs,
// including git-root discovery, source_prefix computation, and the multi-repository
// mount-name explicitness bypass (the central new behavior of sources-in-manifest).
//
// A shared parent directory owns two git repository subdirectories so that
// base_directory-relative string paths work naturally.
describe('string entries end-to-end: expand_manifest_sources → resolve_source_inputs', () => {
    let parent_directory: string;
    let repo_a: string;
    let repo_b: string;

    beforeAll(() => {
        parent_directory = canonical_host_path(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-sources-e2e-')),
        );
        repo_a = path.join(parent_directory, 'repo-a');
        fs.mkdirSync(repo_a);
        initialize_repository_with_initial_commit(repo_a);
        fs.mkdirSync(path.join(repo_a, 'src'), { recursive: true });

        repo_b = path.join(parent_directory, 'repo-b');
        fs.mkdirSync(repo_b);
        initialize_repository_with_initial_commit(repo_b);
    });

    afterAll(() => {
        fs.rmSync(parent_directory, { recursive: true, force: true });
    });

    it('string at repository root yields source_prefix="" and mount_name=string', () => {
        const inputs = expand_manifest_sources(['repo-a'], parent_directory);
        const sources = resolve_source_inputs(inputs[0], inputs.slice(1));
        expect(sources).toHaveLength(1);
        expect(sources[0].source_prefix).toBe('');
        expect(sources[0].mount_name).toBe('repo-a');
        expect(compare_host_path(sources[0].repository_root)).toBe(
            compare_host_path(repo_a),
        );
    });

    it('string into subdirectory yields correct source_prefix and mount_name', () => {
        const inputs = expand_manifest_sources(['repo-a/src'], parent_directory);
        const sources = resolve_source_inputs(inputs[0], inputs.slice(1));
        expect(sources).toHaveLength(1);
        expect(sources[0].source_prefix).toBe('src');
        expect(sources[0].mount_name).toBe('repo-a/src');
        expect(compare_host_path(sources[0].repository_root)).toBe(
            compare_host_path(repo_a),
        );
    });

    it('two strings from the same repository produce distinct mount names and pass validation', () => {
        fs.mkdirSync(path.join(repo_a, 'test'), { recursive: true });
        const inputs = expand_manifest_sources(['repo-a/src', 'repo-a/test'], parent_directory);
        const sources = resolve_source_inputs(inputs[0], inputs.slice(1));
        expect(sources).toHaveLength(2);
        expect(sources[0].mount_name).toBe('repo-a/src');
        expect(sources[1].mount_name).toBe('repo-a/test');
        expect(compare_host_path(sources[0].repository_root)).toBe(
            compare_host_path(sources[1].repository_root),
        );
    });

    it('string entries from different repositories pass without --mount (explicitness bypass)', () => {
        // This is the central new behavior: string entries always carry an
        // explicit mount_name, so assert_multi_repository_mount_explicitness
        // does not reject them even when the two repos are distinct.
        const inputs = expand_manifest_sources(['repo-a', 'repo-b'], parent_directory);
        expect(() => resolve_source_inputs(inputs[0], inputs.slice(1))).not.toThrow();
        const sources = resolve_source_inputs(inputs[0], inputs.slice(1));
        expect(sources).toHaveLength(2);
        expect(sources[0].mount_name).toBe('repo-a');
        expect(sources[1].mount_name).toBe('repo-b');
    });
});
