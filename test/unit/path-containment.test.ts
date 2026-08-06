import { describe, it, expect, afterEach } from 'vitest';
import {
    host_is_case_insensitive,
    paths_equal_for_host,
    is_path_within,
} from '../../src/path_containment.js';

/**
 * `host_is_case_insensitive()` reads `process.platform`, so case-fold behavior
 * is exercised by passing the `case_insensitive` argument explicitly rather
 * than by mocking the platform — the explicit argument is the same value the
 * production default computes, and keeps these assertions deterministic on any
 * CI runner.
 */
describe('host_is_case_insensitive', () => {
    const original_platform = process.platform;

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: original_platform });
    });

    function set_platform(value: NodeJS.Platform): void {
        Object.defineProperty(process, 'platform', { value });
    }

    it('is true on win32 and darwin, false on linux', () => {
        set_platform('win32');
        expect(host_is_case_insensitive()).toBe(true);
        set_platform('darwin');
        expect(host_is_case_insensitive()).toBe(true);
        set_platform('linux');
        expect(host_is_case_insensitive()).toBe(false);
    });
});

describe('paths_equal_for_host', () => {
    it('treats forward and backward separators as interchangeable', () => {
        expect(paths_equal_for_host('a/b/c', String.raw`a\b\c`, false)).toBe(true);
    });

    it('ignores trailing separators (single or repeated)', () => {
        expect(paths_equal_for_host('/repo/', '/repo', false)).toBe(true);
        expect(paths_equal_for_host('/repo//', '/repo', false)).toBe(true);
    });

    it('floors an all-separator path at root rather than the empty string', () => {
        // `//` is the root, not "". Equal to `/`, and NOT equal to a relative ''.
        expect(paths_equal_for_host('//', '/', false)).toBe(true);
        expect(paths_equal_for_host('//', '', false)).toBe(false);
    });

    it('folds case only when case_insensitive is set', () => {
        expect(paths_equal_for_host('/Repo/Sub', '/repo/sub', true)).toBe(true);
        expect(paths_equal_for_host('/Repo/Sub', '/repo/sub', false)).toBe(false);
    });
});

describe('is_path_within', () => {
    it('returns true for an identical path', () => {
        expect(is_path_within('/repo', '/repo', false)).toBe(true);
    });

    it('returns true for a strict descendant', () => {
        expect(is_path_within('/repo/sub/file', '/repo', false)).toBe(true);
    });

    it('rejects a sibling that merely shares a prefix string', () => {
        // '/repo-evil' starts with '/repo' textually but is not under it; the
        // separator boundary check must reject it.
        expect(is_path_within('/repo-evil/file', '/repo', false)).toBe(false);
    });

    it('rejects a path outside the parent', () => {
        expect(is_path_within('/etc/passwd', '/repo', false)).toBe(false);
    });

    it('normalizes separators on both sides', () => {
        expect(is_path_within(String.raw`C:\repo\sub`, 'C:/repo', false)).toBe(true);
    });

    it('honors case-insensitive containment (Windows/macOS)', () => {
        // The macOS regression this unification fixed: containment must fold
        // case on a case-insensitive host, not only on Windows.
        expect(is_path_within('/Repo/Sub', '/repo', true)).toBe(true);
        expect(is_path_within('/Repo/Sub', '/repo', false)).toBe(false);
    });
});
