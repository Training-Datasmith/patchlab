/**
 * Structural lock against TypeScript's non-null assertion operator (`x!`).
 *
 * The `!` postfix is an escape hatch in the same family as `as any` and bare
 * `@ts-expect-error`: it tells the compiler "trust me, this isn't null" with
 * no runtime check. When the assumption fails, the error surfaces deep inside
 * whatever expression dereferenced the value — far from the place the cast
 * was made. Production code in `src/` does not use `!` at all (zero
 * occurrences). Test code uses `assert_present(x)` (which narrows AND throws
 * a useful message on failure) or `import { strict as assert } from 'node:assert'`
 * (when the original assertion was `toBeTruthy`, not just non-null).
 *
 * What is flagged:
 *   `obj!.field`             // dereference after assertion
 *   `obj!.method()`
 *   `arr[0]!.x`              // assertion after index
 *   `result.commit_sha!`     // bare assertion (last in an expression)
 *   `foo!`                   // same
 *   `foo!,` / `foo!;` / `foo!)` / `foo!]` / `foo!}`  // expression-position
 *   `private foo!: string;`  // definite-assignment assertion (also an escape hatch)
 *
 * What is NOT flagged:
 *   `foo != bar`             // comparison
 *   `foo !== bar`            // strict comparison
 *   `!flag`                  // logical NOT (no preceding identifier)
 *   `arr[!flag]`             // logical NOT in expression position
 *
 * The classifier: a `!` whose preceding code character is in
 * `[A-Za-z0-9_$)\]]` (identifier or closing bracket/paren) and whose
 * following character is NOT `=` (which would make it `!=` / `!==`). Comments,
 * strings, and template literals are blanked by `strip_to_code_only` before
 * the regex pass, so docstrings mentioning `x!` are not flagged.
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
const SELF_FILE = path.join(__dirname, 'non-null-assertion.test.ts');

const NON_NULL_ASSERTION_PATTERN = /[A-Za-z0-9_$\)\]]!(?!=)/g;

function find_non_null_assertions(source: string): { line: number }[] {
    const blanked = strip_to_code_only(source);
    const findings: { line: number }[] = [];
    NON_NULL_ASSERTION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = NON_NULL_ASSERTION_PATTERN.exec(blanked)) !== null) {
        findings.push({ line: line_number_at(source, match.index + 1) });
    }

    return findings;
}

describe('non-null-assertion discipline', () => {
    it('no `x!` postfix assertions in src/ or test/', () => {
        const all_files: string[] = [];
        for (const directory of SCAN_DIRECTORIES) {
            collect_typescript_files(directory, all_files);
        }

        const violations: { file: string; line: number }[] = [];

        for (const file_path of all_files) {
            if (file_path === SELF_FILE) {
                continue;
            }
            const contents = fs.readFileSync(file_path, 'utf8');
            for (const finding of find_non_null_assertions(contents)) {
                violations.push({
                    file: path.relative(REPOSITORY_ROOT, file_path),
                    line: finding.line,
                });
            }
        }

        expect(
            violations,
            `Non-null assertions found — replace with \`assert_present(x)\` (for null/undefined narrowing) or \`import { strict as assert } from 'node:assert'\` (for truthy assertions):\n${violations
                .map((v) => `  ${v.file}:${v.line}`)
                .join('\n')}`,
        ).toEqual([]);
    });

    it('positive control: flags a non-null assertion placed after a string literal', () => {
        const source = [
            'const decoy = "a string a broken tokenizer might run past";',
            'const y = decoy.length!;',
        ].join('\n');
        expect(find_non_null_assertions(source)).toEqual([{ line: 2 }]);
    });
});
