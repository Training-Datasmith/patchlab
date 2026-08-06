/**
 * Structural lock: prefer single-quoted string literals.
 *
 * The codebase uses single quotes for all string literals by convention
 * (~98% of cases). A double-quoted string is allowed ONLY when its content
 * contains a single quote, since converting it would require backslash-
 * escaping. Empty doubles `""` and otherwise-convertible doubles are
 * flagged.
 *
 * What is flagged:
 *   `"foo"`            // convertible to 'foo'
 *   `""`               // convertible to ''
 *   `"4g"`             // convertible to '4g'
 *
 * What is NOT flagged:
 *   `"don't"`          // single quote inside — escaping would be needed
 *   `'foo'`            // already single-quoted
 *   `` `foo` ``        // template literal
 *   `'shell with "$x"'`// double quote inside a single-quoted string — fine
 *
 * The tokenizer (shared with other invariant scanners) walks character by
 * character, tracking single-quoted, double-quoted, template, and comment
 * regions. Only double-quoted strings that appear as code-position literals
 * are inspected.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    collect_typescript_files,
    consume_quoted_string,
    line_number_at,
    skip_to_next_blanked_region,
} from '../../helpers/typescript_source_tokenizer.js';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCAN_DIRECTORIES = ['src', 'test'].map((name) => path.join(REPOSITORY_ROOT, name));
const SELF_FILE = path.join(__dirname, 'quote-consistency.test.ts');

function inspect_double_quoted_at(
    source: string,
    open_at: number,
    findings: { line: number }[],
): number {
    const { content, end } = consume_quoted_string(source, open_at);
    if (!content.includes("'")) {
        findings.push({ line: line_number_at(source, open_at) });
    }

    return end;
}

function find_convertible_double_quoted_strings(source: string): { line: number }[] {
    const findings: { line: number }[] = [];
    let i = 0;

    while (i < source.length) {
        if (source[i] === '"') {
            i = inspect_double_quoted_at(source, i, findings);
            continue;
        }
        const region_end = skip_to_next_blanked_region(source, i);
        i = region_end ?? i + 1;
    }

    return findings;
}

describe('quote-consistency discipline', () => {
    it('no convertible double-quoted strings in src/ or test/', () => {
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
            for (const finding of find_convertible_double_quoted_strings(contents)) {
                violations.push({
                    file: path.relative(REPOSITORY_ROOT, file_path),
                    line: finding.line,
                });
            }
        }

        expect(
            violations,
            `Convertible double-quoted strings — rewrite as single-quoted:\n${violations
                .map((v) => `  ${v.file}:${v.line}`)
                .join('\n')}`,
        ).toEqual([]);
    });

    it('positive control: flags a convertible double-quoted string, ignores one containing a single quote', () => {
        const source = [
            'const keep = "it\'s not convertible";',
            'const change = "convertible";',
        ].join('\n');
        expect(find_convertible_double_quoted_strings(source)).toEqual([{ line: 2 }]);
    });
});
