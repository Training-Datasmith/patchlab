/**
 * Tests for per-repository default-tool preference persistence.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    read_default_tool_preference,
    write_default_tool_preference,
    default_tool_preference_path,
} from '../../../src/tools/default_tool_preference.js';
import { trust_marker_path } from '../../../src/tools/configured_provider/trust_marker.js';

let patchlab_home: string;
let repository_root: string;
let original_patchlab_home: string | undefined;

beforeEach(() => {
    original_patchlab_home = process.env.PATCHLAB_HOME;
    patchlab_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-default-tool-pref-'));
    repository_root = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-repo-'));
    process.env.PATCHLAB_HOME = patchlab_home;
});

afterEach(() => {
    if (original_patchlab_home === undefined) {
        delete process.env.PATCHLAB_HOME;
    } else {
        process.env.PATCHLAB_HOME = original_patchlab_home;
    }

    fs.rmSync(patchlab_home, { recursive: true, force: true });
    fs.rmSync(repository_root, { recursive: true, force: true });
});

describe('default_tool_preference persistence', () => {
    it('round-trips write and read', () => {
        write_default_tool_preference(repository_root, 'aider', 'repository');
        const stored = read_default_tool_preference(repository_root);
        expect(stored).not.toBeNull();
        expect(stored?.value).toBe('aider');
        expect(stored?.choice).toBe('repository');
        expect(stored?.repository_root).toBe(fs.realpathSync(repository_root));
    });

    it('returns null for missing preference file', () => {
        expect(read_default_tool_preference(repository_root)).toBeNull();
    });

    it('returns null for corrupt JSON', () => {
        const preference_path = default_tool_preference_path(repository_root);
        fs.mkdirSync(path.dirname(preference_path), { recursive: true });
        fs.writeFileSync(preference_path, '{not json', 'utf-8');
        expect(read_default_tool_preference(repository_root)).toBeNull();
    });

    it('returns null when stored value is empty', () => {
        const preference_path = default_tool_preference_path(repository_root);
        fs.mkdirSync(path.dirname(preference_path), { recursive: true });
        fs.writeFileSync(
            preference_path,
            JSON.stringify({ value: '', choice: 'repository' }),
            'utf-8',
        );
        expect(read_default_tool_preference(repository_root)).toBeNull();
    });

    it('uses a separate path from manifest trust markers', () => {
        write_default_tool_preference(repository_root, 'shell', 'fallback');
        expect(default_tool_preference_path(repository_root)).not.toBe(trust_marker_path(repository_root));
    });

    it('returns null when stored choice is invalid', () => {
        const preference_path = default_tool_preference_path(repository_root);
        fs.mkdirSync(path.dirname(preference_path), { recursive: true });
        fs.writeFileSync(
            preference_path,
            JSON.stringify({ value: 'aider', choice: 'bogus' }),
            'utf-8',
        );
        expect(read_default_tool_preference(repository_root)).toBeNull();
    });

    it('keys preferences by realpath so symlinked paths share one file', () => {
        const symlink_parent = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-pref-symlink-parent-'));
        const symlink_path = path.join(symlink_parent, 'repo-link');
        fs.symlinkSync(repository_root, symlink_path);

        write_default_tool_preference(symlink_path, 'aider', 'repository');
        const via_symlink = read_default_tool_preference(symlink_path);
        const via_canonical = read_default_tool_preference(repository_root);

        expect(via_symlink).not.toBeNull();
        expect(via_canonical).not.toBeNull();
        expect(via_symlink?.value).toBe('aider');
        expect(via_canonical?.choice).toBe('repository');
        expect(default_tool_preference_path(symlink_path)).toBe(default_tool_preference_path(repository_root));

        fs.rmSync(symlink_parent, { recursive: true, force: true });
    });
});
