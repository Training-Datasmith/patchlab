import { describe, it, expect } from 'vitest';
import { parse_name_status } from '../../src/changes.js';

describe('parse_name_status', () => {
    it('maps A / M / D status codes to add / modify / delete', () => {
        const output = 'A\tnew.ts\nM\tchanged.ts\nD\tgone.ts';
        expect(parse_name_status(output)).toEqual([
            { relative_path: 'new.ts', type: 'add' },
            { relative_path: 'changed.ts', type: 'modify' },
            { relative_path: 'gone.ts', type: 'delete' },
        ]);
    });

    it('falls back to modify for an unrecognized status code', () => {
        // e.g. a copy ('C90') or type-change ('T') row — treated as a modify
        // rather than dropped, so the change is never silently lost.
        expect(parse_name_status('T\tmode-changed.sh')).toEqual([
            { relative_path: 'mode-changed.sh', type: 'modify' },
        ]);
    });

    it('skips blank lines and lines with no tab separator', () => {
        const output = '\nA\tkept.ts\n\ngarbage-without-tab\n  \nM\talso-kept.ts';
        expect(parse_name_status(output)).toEqual([
            { relative_path: 'kept.ts', type: 'add' },
            { relative_path: 'also-kept.ts', type: 'modify' },
        ]);
    });

    it('represents a --no-renames rename as a delete + add pair', () => {
        // diff_sandbox passes --no-renames, so git emits the old path as a
        // delete and the new path as an add (two two-field rows) rather than a
        // three-field R row the parser would mishandle.
        const output = 'D\tsrc/old_name.ts\nA\tsrc/new_name.ts';
        expect(parse_name_status(output)).toEqual([
            { relative_path: 'src/old_name.ts', type: 'delete' },
            { relative_path: 'src/new_name.ts', type: 'add' },
        ]);
    });

    it('preserves paths that themselves contain spaces', () => {
        expect(parse_name_status('M\tsrc/a file.ts')).toEqual([
            { relative_path: 'src/a file.ts', type: 'modify' },
        ]);
    });

    it('returns an empty list for empty output', () => {
        expect(parse_name_status('')).toEqual([]);
    });
});
