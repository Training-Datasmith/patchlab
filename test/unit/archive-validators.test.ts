import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
    ARCHIVE_SUBPATH_REJECTION_FIXTURE,
    assert_artifact_filesystem_type,
    assert_unique_archive_subpaths,
    assert_unique_artifact_names,
    filter_valid_artifacts_for_injection,
    validate_archive_subpath,
    type Extractable_Artifact,
} from '../../src/extractable_artifact.js';
import { install_recording_logger_hooks, type RecordingLogger } from '../helpers/recording_logger.js';

const PROVIDER = 'test-provider';

function make_artifact(name: string, archive_subpath: string): Extractable_Artifact {
    return {
        name,
        container_path: `/tmp/${name}`,
        type: 'directory',
        archive_subpath,
        required_for_resume: false,
    };
}

describe('validate_archive_subpath (6.1)', () => {
    it('6.1.1 accepts a normal subpath', () => {
        expect(validate_archive_subpath('conversation', PROVIDER)).toBe('conversation');
        expect(validate_archive_subpath('messages', PROVIDER)).toBe('messages');
    });

    it('6.1.0 rejects a non-string subpath (defends against an incorrectly typed provider declaration)', () => {
        // The validator's type signature claims `string`, but providers come
        // from configured (manifest-sourced) sources where the runtime shape
        // may not match. This guard catches a non-string slipping through.
        expect(() => validate_archive_subpath(42 as unknown as string, PROVIDER))
            .toThrow(/not a string/);
        expect(() => validate_archive_subpath(null as unknown as string, PROVIDER))
            .toThrow(/not a string/);
        expect(() => validate_archive_subpath(undefined as unknown as string, PROVIDER))
            .toThrow(/not a string/);
    });

    it('6.1.2 rejects forward slash', () => {
        expect(() => validate_archive_subpath('nested/dir', PROVIDER)).toThrow(/separator/);
    });

    it('6.1.3 rejects backslash', () => {
        expect(() => validate_archive_subpath(String.raw`nested\dir`, PROVIDER)).toThrow(/separator/);
    });

    it('6.1.4 rejects "..".', () => {
        expect(() => validate_archive_subpath('..', PROVIDER)).toThrow(/navigation token/);
    });

    it('6.1.5 rejects ".." as a segment within a longer subpath (separator catches it)', () => {
        // The separator rule fires first — either error is acceptable per the spec.
        expect(() => validate_archive_subpath('a/../b', PROVIDER)).toThrow();
    });

    it('6.1.6 rejects an absolute path', () => {
        expect(() => validate_archive_subpath('/etc/passwd', PROVIDER)).toThrow(/separator/);
    });

    it('6.1.7 rejects a null byte', () => {
        expect(() => validate_archive_subpath('foo\0bar', PROVIDER)).toThrow(/control character/);
    });

    it('6.1.8 rejects control characters', () => {
        expect(() => validate_archive_subpath('foo\x01bar', PROVIDER)).toThrow(/control character/);
        expect(() => validate_archive_subpath('foo\x1fbar', PROVIDER)).toThrow(/control character/);
    });

    it('6.1.9 rejects an empty string', () => {
        expect(() => validate_archive_subpath('', PROVIDER)).toThrow(/empty/);
    });

    it('6.1.10 rejection error names the provider and the offending value', () => {
        try {
            validate_archive_subpath('bad/value', PROVIDER);
            throw new Error('expected to throw');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            expect(message).toContain(PROVIDER);
            expect(message).toContain('bad/value');
        }
    });

    it('6.1.11 rejects "." as distinct from ".."', () => {
        expect(() => validate_archive_subpath('.', PROVIDER)).toThrow(/navigation token/);
    });

    it.each([['<'], ['>'], [':'], ['"'], ['|'], ['?'], ['*']])(
        '6.1.12 rejects Windows-reserved character "%s"',
        (character) => {
            expect(() => validate_archive_subpath(`tool${character}state`, PROVIDER)).toThrow(
                /Windows-reserved character/
            );
        }
    );

    it.each([
        ['CON'], ['PRN'], ['AUX'], ['NUL'],
        ['COM0'], ['COM5'], ['COM9'],
        ['LPT0'], ['LPT5'], ['LPT9'],
        ['Con'], ['nul'], ['Lpt5'],
        // Stem-with-extension: Windows reserves the stem before the first dot
        ['CON.txt'], ['nul.log'], ['COM5.json'], ['Lpt5.data'],
    ])('6.1.13 rejects Windows-reserved device name "%s" (case-insensitive)', (name) => {
        expect(() => validate_archive_subpath(name, PROVIDER)).toThrow(/Windows-reserved device name/);
    });

    it.each([['console-output'], ['aux-data'], ['lpt-controller']])(
        '6.1.14 accepts subpath with reserved-name substring "%s"',
        (subpath) => {
            expect(validate_archive_subpath(subpath, PROVIDER)).toBe(subpath);
        }
    );

    it.each([['foo.'], ['foo..'], ['data.json.']])(
        '6.1.15 rejects trailing dot "%s"',
        (subpath) => {
            expect(() => validate_archive_subpath(subpath, PROVIDER)).toThrow(/dot/);
        }
    );

    it.each([['foo '], ['foo  ']])(
        '6.1.16 rejects trailing space "%s"',
        (subpath) => {
            expect(() => validate_archive_subpath(subpath, PROVIDER)).toThrow(/space/);
        }
    );

    it.each([['my.tool'], ['my tool'], ['tool.config.local']])(
        '6.1.17 accepts mid-string dots and spaces "%s"',
        (subpath) => {
            expect(validate_archive_subpath(subpath, PROVIDER)).toBe(subpath);
        }
    );

    it('exposes ARCHIVE_SUBPATH_REJECTION_FIXTURE; every entry is rejected by the validator', () => {
        // 7.2.6 — shared fixture between this validator and the manifest-format
        // validator. Each entry must be rejected here so both layers stay aligned.
        for (const entry of ARCHIVE_SUBPATH_REJECTION_FIXTURE) {
            expect(() => validate_archive_subpath(entry.value, PROVIDER)).toThrow();
        }
    });
});

describe('assert_unique_archive_subpaths (6.2)', () => {
    it('6.2.1 accepts an empty array', () => {
        expect(() => assert_unique_archive_subpaths([], PROVIDER)).not.toThrow();
    });

    it('6.2.2 accepts a single-artifact array', () => {
        expect(() =>
            assert_unique_archive_subpaths([make_artifact('a', 'data')], PROVIDER)
        ).not.toThrow();
    });

    it('6.2.3 accepts a two-artifact array with distinct subpaths', () => {
        expect(() =>
            assert_unique_archive_subpaths(
                [make_artifact('messages', 'messages'), make_artifact('state', 'state')],
                PROVIDER
            )
        ).not.toThrow();
    });

    it('6.2.4 rejects two artifacts with the same subpath, naming both', () => {
        try {
            assert_unique_archive_subpaths(
                [make_artifact('first', 'data'), make_artifact('second', 'data')],
                PROVIDER
            );
            throw new Error('expected to throw');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            expect(message).toContain('first');
            expect(message).toContain('second');
            expect(message).toContain('data');
            expect(message).toContain(PROVIDER);
        }
    });

    it('6.2.5 rejects three artifacts with two sharing a subpath; error names the conflicting two', () => {
        try {
            assert_unique_archive_subpaths(
                [
                    make_artifact('alpha', 'shared'),
                    make_artifact('beta', 'shared'),
                    make_artifact('gamma', 'unique'),
                ],
                PROVIDER
            );
            throw new Error('expected to throw');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            expect(message).toContain('alpha');
            expect(message).toContain('beta');
            expect(message).not.toContain('gamma');
            expect(message).toContain('shared');
        }
    });

    it('6.2.6 rejects case-only-different subpaths (case-insensitive)', () => {
        try {
            assert_unique_archive_subpaths(
                [make_artifact('upper', 'State'), make_artifact('lower', 'state')],
                PROVIDER
            );
            throw new Error('expected to throw');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            expect(message.toLowerCase()).toContain('state');
            expect(message).toContain('upper');
            expect(message).toContain('lower');
        }
    });

    it('6.2.7 accepts case-only-different VALUES on the name field', () => {
        expect(() =>
            assert_unique_archive_subpaths(
                [
                    { ...make_artifact('foo', 'data') },
                    { ...make_artifact('FOO', 'logs') },
                ],
                PROVIDER
            )
        ).not.toThrow();
    });
});

describe('assert_unique_artifact_names', () => {
    it('accepts an empty array', () => {
        expect(() => assert_unique_artifact_names([], PROVIDER)).not.toThrow();
    });

    it('accepts a single-artifact array', () => {
        expect(() =>
            assert_unique_artifact_names([make_artifact('a', 'data')], PROVIDER)
        ).not.toThrow();
    });

    it('accepts distinct names', () => {
        expect(() =>
            assert_unique_artifact_names(
                [make_artifact('messages', 'a'), make_artifact('state', 'b')],
                PROVIDER
            )
        ).not.toThrow();
    });

    it('rejects duplicate names, naming the duplicated value and the provider', () => {
        try {
            assert_unique_artifact_names(
                [make_artifact('chat', 'a'), make_artifact('chat', 'b')],
                PROVIDER
            );
            throw new Error('expected to throw');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            expect(message).toContain('chat');
            expect(message).toContain(PROVIDER);
            expect(message).toMatch(/duplicate/i);
        }
    });

    it('accepts case-only-different names (case-sensitive comparison)', () => {
        // Symmetry note vs. assert_unique_archive_subpaths (case-insensitive):
        // `name` is a logical identifier, not filesystem-bound, so `Foo` and
        // `foo` are intentionally treated as distinct here.
        expect(() =>
            assert_unique_artifact_names(
                [make_artifact('Foo', 'a'), make_artifact('foo', 'b')],
                PROVIDER
            )
        ).not.toThrow();
    });
});

describe('assert_artifact_filesystem_type (6.3)', () => {
    let temporary_directory: string;

    beforeEach(() => {
        temporary_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-fs-check-'));
    });

    afterEach(() => {
        fs.rmSync(temporary_directory, { recursive: true, force: true });
    });

    it('6.3.1 returns absent for a non-existent path', () => {
        const target = path.join(temporary_directory, 'missing');
        expect(assert_artifact_filesystem_type(target, 'file', PROVIDER, 'a'))
            .toEqual({ kind: 'absent' });
    });

    it('6.3.1a returns absent when an ancestor directory is missing', () => {
        const target = path.join(temporary_directory, 'no-such-parent', 'leaf');
        expect(assert_artifact_filesystem_type(target, 'file', PROVIDER, 'a'))
            .toEqual({ kind: 'absent' });
    });

    it('6.3.2 returns present for a regular file when declared file', () => {
        const target = path.join(temporary_directory, 'regular.txt');
        fs.writeFileSync(target, 'content');
        expect(assert_artifact_filesystem_type(target, 'file', PROVIDER, 'a'))
            .toEqual({ kind: 'present' });
    });

    it('6.3.3 returns present for a directory when declared directory', () => {
        const target = path.join(temporary_directory, 'subdir');
        fs.mkdirSync(target);
        expect(assert_artifact_filesystem_type(target, 'directory', PROVIDER, 'a'))
            .toEqual({ kind: 'present' });
    });

    it('6.3.4 returns mismatch with actual=directory when declared file but on-disk is directory', () => {
        const target = path.join(temporary_directory, 'as-dir');
        fs.mkdirSync(target);
        expect(assert_artifact_filesystem_type(target, 'file', PROVIDER, 'a'))
            .toEqual({ kind: 'mismatch', actual: 'directory' });
    });

    it('6.3.5 returns mismatch with actual=file when declared directory but on-disk is file', () => {
        const target = path.join(temporary_directory, 'as-file');
        fs.writeFileSync(target, 'content');
        expect(assert_artifact_filesystem_type(target, 'directory', PROVIDER, 'a'))
            .toEqual({ kind: 'mismatch', actual: 'file' });
    });

    it('6.3.6 returns mismatch with actual=symbolic_link when declared file but on-disk is symlink', () => {
        const target_file = path.join(temporary_directory, 'real.txt');
        const link_path = path.join(temporary_directory, 'link.txt');
        fs.writeFileSync(target_file, 'content');
        try {
            fs.symlinkSync(target_file, link_path);
        } catch (error) {
            // Windows without symlink permission — skip.
            if ((error as NodeJS.ErrnoException).code === 'EPERM') {
                return;
            }
            throw error;
        }
        expect(assert_artifact_filesystem_type(link_path, 'file', PROVIDER, 'a'))
            .toEqual({ kind: 'mismatch', actual: 'symbolic_link' });
    });

    it('6.3.7 returns mismatch with actual=symbolic_link when declared directory but on-disk is symlink', () => {
        const target_directory = path.join(temporary_directory, 'real-dir');
        const link_path = path.join(temporary_directory, 'link-dir');
        fs.mkdirSync(target_directory);
        try {
            fs.symlinkSync(target_directory, link_path, 'dir');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') {
                return;
            }
            throw error;
        }
        expect(assert_artifact_filesystem_type(link_path, 'directory', PROVIDER, 'a'))
            .toEqual({ kind: 'mismatch', actual: 'symbolic_link' });
    });

    // POSIX-only fifo/socket type-mismatch coverage lives in
    // test/posix/archive-validators.test.ts — Windows has no fifo/socket
    // filesystem objects to point lstat at.

    it('6.3.9 re-throws other lstat errors (not ENOENT) without translating them', () => {
        // A path containing a null byte triggers ERR_INVALID_ARG_VALUE (not ENOENT)
        // from `fs.lstatSync`. Verifies the helper re-throws non-ENOENT errors
        // rather than translating them to a `mismatch` result.
        const target = path.join(temporary_directory, 'with-null\0byte');
        expect(() =>
            assert_artifact_filesystem_type(target, 'file', PROVIDER, 'a')
        ).toThrow();
    });
});

describe('filter_valid_artifacts_for_injection', () => {
    const recording_handle = install_recording_logger_hooks();
    let recording_logger: RecordingLogger;

    beforeEach(() => {
        recording_logger = recording_handle.current();
    });

    it('returns every artifact unchanged when all are valid and unique', () => {
        const artifacts = [
            make_artifact('a', 'conversation'),
            make_artifact('b', 'messages'),
        ];
        const filtered = filter_valid_artifacts_for_injection(artifacts, PROVIDER);
        expect(filtered).toEqual(artifacts);
        expect(recording_logger.calls.filter((call) => call.method === 'warn')).toEqual([]);
    });

    it('drops both members of a subpath collision and logs the duplicate warning', () => {
        const artifacts = [
            make_artifact('a', 'shared'),
            make_artifact('b', 'shared'),
            make_artifact('c', 'unique'),
        ];
        const filtered = filter_valid_artifacts_for_injection(artifacts, PROVIDER);
        expect(filtered.map((artifact) => artifact.name)).toEqual(['c']);

        const warnings = recording_logger.calls.filter((call) => call.method === 'warn');
        expect(warnings.length).toBeGreaterThan(0);
        const messages = warnings.map((call) => String(call.message)).join('\n');
        expect(messages).toMatch(/(?:duplicate|collide|conflict)/i);
    });

    it('drops a single artifact with an invalid archive_subpath and lets the others proceed', () => {
        const artifacts = [
            make_artifact('a', 'nested/path'), // invalid: contains a separator
            make_artifact('b', 'valid'),
        ];
        const filtered = filter_valid_artifacts_for_injection(artifacts, PROVIDER);
        expect(filtered.map((artifact) => artifact.name)).toEqual(['b']);

        const skip_warning = recording_logger.calls.find(
            (call) => call.method === 'warn' && String(call.message).includes('skipping injection of "a"'),
        );
        expect(skip_warning).toBeDefined();
    });

    it('returns an empty array when every artifact is rejected', () => {
        const artifacts = [
            make_artifact('a', '..'),
            make_artifact('b', '/etc/passwd'),
        ];
        const filtered = filter_valid_artifacts_for_injection(artifacts, PROVIDER);
        expect(filtered).toEqual([]);
    });

    it('returns an empty array when given an empty input', () => {
        expect(filter_valid_artifacts_for_injection([], PROVIDER)).toEqual([]);
    });
});
