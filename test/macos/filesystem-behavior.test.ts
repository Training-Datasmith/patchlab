// macOS-only assertions for host-aware path comparison and per-source
// containment — exercised against REAL APFS semantics (case-insensitive by
// default) and the real `host_is_case_insensitive()` default, rather than the
// injected `case_insensitive` argument the platform-agnostic unit tests use.
//
// The whole suite self-gates with `process.platform === 'darwin'`; on other
// runners every test no-ops cleanly. These run locally on a macOS host via
// `npm test` (the `macos` vitest project).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    host_is_case_insensitive,
    is_path_within,
    paths_equal_for_host,
} from '../../src/path_containment.js';
import { assert_host_path_within_source } from '../../src/tools/configured_provider/index.js';

const IS_MACOS = process.platform === 'darwin';
const describe_on_macos = describe.runIf(IS_MACOS);

describe_on_macos('path_containment — real darwin case-insensitivity (default arg)', () => {
    it('reports the host as case-insensitive', () => {
        expect(host_is_case_insensitive()).toBe(true);
    });

    it('is_path_within folds case by default (the production security-check path)', () => {
        expect(is_path_within('/Users/Me/Repo/sub', '/users/me/repo')).toBe(true);
    });

    it('is_path_within still rejects a case-folded sibling that only shares a prefix string', () => {
        expect(is_path_within('/Repo-Evil/file', '/repo')).toBe(false);
    });

    it('paths_equal_for_host folds case by default', () => {
        expect(paths_equal_for_host('/Repo', '/repo/')).toBe(true);
        expect(paths_equal_for_host('/Repo', '/other')).toBe(false);
    });
});

describe_on_macos('assert_host_path_within_source — real darwin default (no injected case flag)', () => {
    let temporary_root: string;
    let source: string;

    beforeEach(() => {
        temporary_root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-macos-source-')));
        source = path.join(temporary_root, 'MyRepo');
        fs.mkdirSync(path.join(source, '.patchlab', 'tools'), { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(temporary_root, { recursive: true, force: true });
    });

    it('accepts a contained host path that differs only in case from the source', () => {
        const host_file = path.join(temporary_root, 'myrepo', '.patchlab', 'tools', 'template.json');
        fs.writeFileSync(path.join(source, '.patchlab', 'tools', 'template.json'), '{}');

        const result = assert_host_path_within_source(
            host_file,
            source,
            path.join(source, '.patchlab', 'tools', 'foo.yaml'),
        );

        expect(result).toBeNull();
    });

    it('rejects a host path outside the source tree under the real default', () => {
        const result = assert_host_path_within_source(
            '/etc/hosts',
            source,
            path.join(source, '.patchlab', 'tools', 'foo.yaml'),
        );

        expect(result).not.toBeNull();
        expect(result?.reason).toContain('outside repository tree');
    });
});
