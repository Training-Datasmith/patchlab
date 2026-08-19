import { describe, it, expect } from 'vitest';
import {
    assert_safe_patchlab_id,
    assert_valid_patchlab_id,
    build_archive_path,
} from '../../../src/archive.js';
import { container_name_for } from '../../../src/container_runtime.js';
import { make_temporary_index_path, patchlab_branch_name } from '../../../src/branch/index.js';

describe('assert_valid_patchlab_id (CLI trust boundary)', () => {
    it('accepts canonical UUIDs from crypto.randomUUID()', () => {
        expect(() =>
            assert_valid_patchlab_id('11111111-2222-3333-4444-555555555555')
        ).not.toThrow();
    });

    it.each([
        '..',
        '../etc',
        '../.ssh',
        '/etc/passwd',
        '\\Windows',
        '.hidden',
        '',
        'pl-test',                            // tests use this — not a UUID
        'abc',
        'not-a-uuid',
        '11111111-2222-3333-4444-55555555555',  // one digit short
    ])('rejects %s', (bad) => {
        expect(() => assert_valid_patchlab_id(bad)).toThrow();
    });
});

describe('assert_safe_patchlab_id (defense-in-depth in build paths)', () => {
    it('accepts UUIDs and test ids alike', () => {
        expect(() => assert_safe_patchlab_id('11111111-2222-3333-4444-555555555555')).not.toThrow();
        expect(() => assert_safe_patchlab_id('pl-test')).not.toThrow();
        expect(() => assert_safe_patchlab_id('abc-123')).not.toThrow();
    });

    it.each(['..', '../etc', 'foo/bar', 'foo\\bar', '.hidden', '', '\0', 'with\0null'])(
        'rejects traversal-prone id %s',
        (bad) => {
            expect(() => assert_safe_patchlab_id(bad)).toThrow();
        }
    );

    it('build_archive_path refuses traversal-prone ids', () => {
        expect(() => build_archive_path('..')).toThrow();
        expect(() => build_archive_path('../foo')).toThrow();
        expect(() => build_archive_path('foo/bar')).toThrow();
    });

    it('container_name_for refuses traversal-prone ids', () => {
        expect(() => container_name_for('../foo')).toThrow();
    });

    it('container_name_for composes the patchlab- prefix for a safe id', () => {
        expect(container_name_for('abc-123')).toBe('patchlab-abc-123');
    });

    it('patchlab_branch_name refuses traversal-prone ids', () => {
        expect(() => patchlab_branch_name('..')).toThrow();
    });

    it('make_temporary_index_path refuses traversal-prone ids', () => {
        expect(() => make_temporary_index_path('foo/../bar', 'session-1')).toThrow();
    });
});
