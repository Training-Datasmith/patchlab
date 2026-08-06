/**
 * Structural lock against ASCII-art section dividers (`// -----------`).
 *
 * The project removed every divider in favor of one-of-two patterns:
 *   - **Short files** carry a file-level JSDoc summarizing the module's
 *     concerns; sections are just `describe` blocks or function groups.
 *   - **Long files** get split into smaller files (one responsibility per
 *     file) rather than internally annotated.
 *
 * Either way, dividers are an anti-signal — they mark a file that should
 * have been split. The scanner enforces zero dividers (top-level OR indented)
 * so the rule self-enforces.
 *
 * Allowed: comment lines containing `----` as part of prose
 *   (e.g. `// see foo --- bar`), HTML separators, or rule-of-X patterns.
 *   Only the divider shape — a comment line that is ONLY `// ----` — is
 *   flagged.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    collect_typescript_files,
    line_number_at,
} from '../../helpers/typescript_source_tokenizer.js';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCAN_DIRECTORIES = ['src', 'test'].map((name) => path.join(REPOSITORY_ROOT, name));
const SELF_FILE = path.join(__dirname, 'section-divider.test.ts');

// A divider line is a comment that contains ONLY whitespace, `//`, and four
// or more dashes (optional trailing whitespace). Matches both top-level and
// indented dividers. `m` flag so `^` and `$` match line boundaries.
const DIVIDER_LINE_PATTERN = /^\s*\/\/\s*-{4,}\s*$/m;

function find_dividers(source: string): { line: number }[] {
    const findings: { line: number }[] = [];
    const pattern = new RegExp(DIVIDER_LINE_PATTERN.source, 'gm');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
        findings.push({ line: line_number_at(source, match.index) });
    }

    return findings;
}

describe('section-divider discipline', () => {
    it('no `// ----` divider lines (top-level or indented) anywhere in src/ or test/', () => {
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
            for (const finding of find_dividers(contents)) {
                violations.push({
                    file: path.relative(REPOSITORY_ROOT, file_path),
                    line: finding.line,
                });
            }
        }

        expect(
            violations,
            `Section dividers detected — drop them and rely on file-level JSDoc / split:\n${violations
                .map((v) => `  ${v.file}:${v.line}`)
                .join('\n')}`,
        ).toEqual([]);
    });

    it('positive control: flags a `// ----` divider line', () => {
        const source = [
            'const x = 1;',
            '// --------',
        ].join('\n');
        expect(find_dividers(source)).toEqual([{ line: 2 }]);
    });
});
