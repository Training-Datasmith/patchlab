import { describe, it, expect } from 'vitest';
import {
    PATCHLAB_BRANCH_PREFIX,
    patchlab_branch_name,
    patchlab_id_from_branch_name,
} from '../../../src/branch/naming.js';

describe('patchlab_branch_name', () => {
    it('prefixes the id with PATCHLAB_BRANCH_PREFIX', () => {
        expect(patchlab_branch_name('abc-123')).toBe('patchlab/abc-123');
    });

    it('exposes the prefix as a string constant', () => {
        expect(PATCHLAB_BRANCH_PREFIX).toBe('patchlab/');
    });

    it('throws when the id contains path separators (assert_safe_patchlab_id)', () => {
        expect(() => patchlab_branch_name('with/slash')).toThrow();
        expect(() => patchlab_branch_name('with\\backslash')).toThrow();
    });

    it('throws on .. and .', () => {
        expect(() => patchlab_branch_name('..')).toThrow();
        expect(() => patchlab_branch_name('.')).toThrow();
    });

    it('throws on the empty id', () => {
        expect(() => patchlab_branch_name('')).toThrow();
    });
});

describe('patchlab_id_from_branch_name', () => {
    it('strips the patchlab/ prefix', () => {
        expect(patchlab_id_from_branch_name('patchlab/abc-123')).toBe('abc-123');
    });

    it('returns empty string when the input is exactly the prefix', () => {
        // Caller is expected to have already filtered to prefixed names; this
        // documents the boundary behavior rather than endorsing the input.
        expect(patchlab_id_from_branch_name('patchlab/')).toBe('');
    });

    it('round-trips with patchlab_branch_name', () => {
        const id = 'session-99-abcdef';
        expect(patchlab_id_from_branch_name(patchlab_branch_name(id))).toBe(id);
    });
});
