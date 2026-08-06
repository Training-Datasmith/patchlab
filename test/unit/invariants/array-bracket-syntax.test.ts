/**
 * Structural lock against the generic `Array<T>` / `ReadonlyArray<T>` syntax.
 * The project's convention is the bracket-suffix form: `T[]` for mutable
 * arrays, `readonly T[]` for read-only arrays. Both forms are functionally
 * equivalent, so the choice is purely stylistic — pick one and stick to it
 * everywhere.
 *
 * What is flagged:
 *   `Array<T>` anywhere in real code (type positions, casts, generics)
 *   `ReadonlyArray<T>` anywhere in real code
 *
 * What is NOT flagged:
 *   `Array.from(...)` / `Array.isArray(...)` — the `Array` constructor object,
 *     distinguishable by the trailing `.` rather than `<`.
 *   Comments / string literals / template literals / regex literals — blanked
 *     by the shared tokenizer before pattern matching.
 *
 * Rewrites:
 *   `Array<Foo>`                 → `Foo[]`
 *   `Array<Foo | null>`          → `(Foo | null)[]`
 *   `Array<{ k: V }>`            → `{ k: V }[]`
 *   `ReadonlyArray<Foo>`         → `readonly Foo[]`
 *   `ReadonlyArray<Foo | null>`  → `readonly (Foo | null)[]`
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    collect_typescript_files,
    line_number_at,
    strip_to_code_only,
} from '../../helpers/typescript_source_tokenizer.js';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCAN_DIRECTORIES = ['src', 'test'].map((name) => path.join(REPOSITORY_ROOT, name));
const SELF_FILE = path.join(__dirname, 'array-bracket-syntax.test.ts');

type Generic_Form = 'Array<...>' | 'ReadonlyArray<...>';

const GENERIC_PATTERNS: { form: Generic_Form; pattern: RegExp }[] = [
    { form: 'Array<...>', pattern: /\bArray</g },
    { form: 'ReadonlyArray<...>', pattern: /\bReadonlyArray</g },
];

function find_generic_array_uses(source: string): { form: Generic_Form; line: number }[] {
    const blanked = strip_to_code_only(source);
    const findings: { form: Generic_Form; line: number }[] = [];
    for (const { form, pattern } of GENERIC_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(blanked)) !== null) {
            findings.push({ form, line: line_number_at(blanked, match.index) });
        }
    }

    return findings;
}

describe('array bracket-suffix discipline', () => {
    it('no `Array<T>` or `ReadonlyArray<T>` in src/ or test/ — use `T[]` / `readonly T[]`', () => {
        const all_files: string[] = [];
        for (const directory of SCAN_DIRECTORIES) {
            collect_typescript_files(directory, all_files);
        }

        const violations: { file: string; line: number; form: Generic_Form }[] = [];

        for (const file_path of all_files) {
            if (file_path === SELF_FILE) {
                continue;
            }
            const contents = fs.readFileSync(file_path, 'utf8');
            for (const finding of find_generic_array_uses(contents)) {
                violations.push({
                    file: path.relative(REPOSITORY_ROOT, file_path),
                    line: finding.line,
                    form: finding.form,
                });
            }
        }

        expect(
            violations,
            `Generic-form array syntax — rewrite as bracket suffix:\n${violations
                .map((v) => `  ${v.file}:${v.line}  ${v.form}`)
                .join('\n')}`,
        ).toEqual([]);
    });

    it('positive control: flags Array<...> placed after a string literal', () => {
        const source = [
            'const decoy = "a string a broken tokenizer might run past";',
            'let xs: Array<string> = [];',
        ].join('\n');
        expect(find_generic_array_uses(source)).toEqual([{ form: 'Array<...>', line: 2 }]);
    });
});
