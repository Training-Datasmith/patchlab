/**
 * Tests for `assert_host_path_within_source` — the per-source host-path
 * containment validator. Per-source manifests SHALL NOT copy files from
 * outside the source tree (hard policy, no override flag). User-global
 * manifests are NOT subject to this check.
 *
 * Coverage (tasks 1.1-1.10 of configured-provider-per-source-and-trust):
 * - lexical containment: absolute outside, `..` escape, drive change
 * - realpath containment: symlink escape, longest-existing-prefix walk
 * - case-insensitive on Windows-style mode, case-sensitive on POSIX
 * - separator normalization
 * - `~` and `$HOME` expansion edge cases (cross-machine caveat)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    assert_host_path_within_source,
    expand_host_path,
} from '../../../../src/tools/configured_provider/index.js';

describe('assert_host_path_within_source — lexical containment (task 1.1)', () => {
    it('accepts a host path inside the source tree', () => {
        const result = assert_host_path_within_source(
            '/workspace/repo/.patchlab/tools/template.json',
            '/workspace/repo',
            '/workspace/repo/.patchlab/tools/foo.yaml',
            { case_insensitive: false },
        );
        expect(result).toBeNull();
    });

    it('rejects an absolute path outside the source tree', () => {
        const result = assert_host_path_within_source(
            '/etc/passwd',
            '/workspace/repo',
            '/workspace/repo/.patchlab/tools/foo.yaml',
            { case_insensitive: false },
        );
        expect(result).not.toBeNull();
        expect(result?.field_path).toBe('authentication.copies[*].host');
        expect(result?.reason).toContain('outside repository tree');
    });

    it('rejects a `..`-traversal that escapes the source tree (task 6.1)', () => {
        // A LITERAL `..` path — lexically it starts with the repository prefix
        // (`/workspace/repo/.patchlab/...`), so the only thing that rejects it is
        // the `path.resolve` normalization collapsing the `..` segments to land
        // outside the tree. realpath_resolver is a pass-through so the lexical
        // leg (not the filesystem) is what's under test; if the resolve were
        // dropped, `is_path_within` is purely lexical and would wrongly accept.
        const result = assert_host_path_within_source(
            '/workspace/repo/.patchlab/../../../home/user/secret',
            '/workspace/repo',
            '/workspace/repo/.patchlab/tools/foo.yaml',
            { case_insensitive: false, realpath_resolver: (input) => input },
        );
        expect(result).not.toBeNull();
        expect(result?.reason).toContain('outside repository tree');
    });

    it('includes the field_index in the rejection path when provided', () => {
        const result = assert_host_path_within_source(
            '/etc/passwd',
            '/workspace/repo',
            '/workspace/repo/.patchlab/tools/foo.yaml',
            { case_insensitive: false, field_index: 2 },
        );
        expect(result?.field_path).toBe('authentication.copies[2].host');
    });
});

describe('assert_host_path_within_source — case sensitivity (task 1.3, 6.2)', () => {
    it('accepts case-only differences in case-insensitive mode (Windows-style)', () => {
        const result = assert_host_path_within_source(
            'C:\\Users\\matt\\source\\template.json',
            'C:\\Users\\Matt\\source',
            'C:\\Users\\Matt\\source\\.patchlab\\tools\\foo.yaml',
            { case_insensitive: true },
        );
        expect(result).toBeNull();
    });

    it('rejects case-only differences in case-sensitive mode (POSIX-style)', () => {
        const result = assert_host_path_within_source(
            '/Workspace/REPO/template.json',
            '/workspace/repo',
            '/workspace/repo/.patchlab/tools/foo.yaml',
            { case_insensitive: false },
        );
        expect(result).not.toBeNull();
    });
});

describe('assert_host_path_within_source — realpath leg (tasks 1.4, 1.7, 6.3)', () => {
    let temporary_root: string;

    beforeEach(() => {
        temporary_root = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-containment-'));
    });

    afterEach(() => {
        try {
            fs.rmSync(temporary_root, { recursive: true, force: true });
        } catch (_ignored) {
            /* best effort */
        }
    });

    it('walks upward to the longest existing prefix when the host path does not exist (task 1.4)', () => {
        const source = fs.realpathSync(temporary_root);
        fs.mkdirSync(path.join(source, '.patchlab', 'tools'), { recursive: true });
        const not_yet_created = path.join(source, '.patchlab', 'tools', 'never-existed.json');

        const result = assert_host_path_within_source(
            not_yet_created,
            source,
            path.join(source, '.patchlab', 'tools', 'foo.yaml'),
            { case_insensitive: false },
        );

        expect(result).toBeNull();
    });

    it('rejects when a symlink inside the source tree points outside (task 1.7, 6.3)', () => {
        if (process.platform === 'win32') {
            return; // symlink creation requires admin on Windows; covered by NTFS-junction test 1.8
        }
        const source = fs.realpathSync(temporary_root);
        const outside_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-containment-outside-'));
        const outside_file = path.join(outside_directory, 'secret');
        fs.writeFileSync(outside_file, 'secret-bytes');
        const link_inside = path.join(source, 'link-to-secret');
        fs.symlinkSync(outside_file, link_inside);

        try {
            const result = assert_host_path_within_source(
                link_inside,
                source,
                path.join(source, '.patchlab', 'tools', 'foo.yaml'),
                { case_insensitive: false },
            );
            expect(result).not.toBeNull();
            expect(result?.reason).toMatch(/symlink|realpath/i);
        } finally {
            fs.rmSync(outside_directory, { recursive: true, force: true });
        }
    });

    it('fails CLOSED when realpath resolution errors (EACCES) instead of falling back to lexical', () => {
        // A lexically-contained path whose realpath cannot be resolved (e.g. an
        // unreadable component hiding a junction) must be REJECTED, not waved
        // through on the lexical result alone.
        const source = '/workspace/repo';
        const host = '/workspace/repo/.patchlab/tools/template.json';

        const result = assert_host_path_within_source(
            host,
            source,
            '/workspace/repo/.patchlab/tools/foo.yaml',
            {
                case_insensitive: false,
                realpath_resolver: () => {
                    const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
                    error.code = 'EACCES';
                    throw error;
                },
            },
        );

        expect(result).not.toBeNull();
        expect(result?.reason).toMatch(/real path failed \(EACCES\)|could not be verified/i);
    });
});

describe('assert_host_path_within_source — tilde / $HOME expansion (tasks 1.6, 1.9, 6.1)', () => {
    it('rejects `~/.ssh/id_rsa` when HOME is outside the source (task 1.9a)', () => {
        const home = process.platform === 'win32' ? 'C:\\Users\\dev' : '/home/dev';
        const source = process.platform === 'win32' ? 'C:\\workspace\\repo' : '/workspace/repo';
        const manifest_directory = process.platform === 'win32'
            ? 'C:\\workspace\\repo\\.patchlab\\tools'
            : '/workspace/repo/.patchlab/tools';

        const expanded = expand_host_path(
            '~/.ssh/id_rsa',
            manifest_directory,
            'authentication.copies[0].host',
            () => home,
        );

        const result = assert_host_path_within_source(
            expanded,
            source,
            path.join(manifest_directory, 'foo.yaml'),
            { case_insensitive: process.platform === 'win32' },
        );

        expect(result).not.toBeNull();
        expect(result?.reason).toContain('outside repository tree');
    });

    it('accepts `~/config/foo` when HOME IS the source root (task 1.9b: cross-machine caveat)', () => {
        const home = process.platform === 'win32' ? 'C:\\Users\\dev' : '/home/dev';
        const source = home; // the source IS the home directory
        const manifest_directory = path.join(home, '.patchlab', 'tools');

        const expanded = expand_host_path(
            '~/config/foo',
            manifest_directory,
            'authentication.copies[0].host',
            () => home,
        );

        const result = assert_host_path_within_source(
            expanded,
            source,
            path.join(manifest_directory, 'foo.yaml'),
            { case_insensitive: process.platform === 'win32' },
        );

        expect(result).toBeNull();
    });

    it('treats `$HOME/foo` the same as `~/foo` (task 1.9c)', () => {
        const home = process.platform === 'win32' ? 'C:\\Users\\dev' : '/home/dev';
        const source = process.platform === 'win32' ? 'C:\\workspace\\repo' : '/workspace/repo';
        const manifest_directory = process.platform === 'win32'
            ? 'C:\\workspace\\repo\\.patchlab\\tools'
            : '/workspace/repo/.patchlab/tools';

        const expanded_tilde = expand_host_path(
            '~/foo',
            manifest_directory,
            'authentication.copies[0].host',
            () => home,
        );
        const expanded_var = expand_host_path(
            '$HOME/foo',
            manifest_directory,
            'authentication.copies[0].host',
            () => home,
        );

        // Same expanded path → same containment verdict (both rejected here since
        // source is /workspace/repo and HOME is /home/dev).
        expect(expanded_tilde).toBe(expanded_var);
        const tilde_result = assert_host_path_within_source(
            expanded_tilde,
            source,
            path.join(manifest_directory, 'foo.yaml'),
            { case_insensitive: process.platform === 'win32' },
        );
        const var_result = assert_host_path_within_source(
            expanded_var,
            source,
            path.join(manifest_directory, 'foo.yaml'),
            { case_insensitive: process.platform === 'win32' },
        );
        expect(tilde_result).not.toBeNull();
        expect(var_result).not.toBeNull();
    });
});
