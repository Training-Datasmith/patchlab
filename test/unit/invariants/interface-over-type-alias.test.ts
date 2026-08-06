/**
 * Structural lock: a `type X = { ... };` declaration whose RHS is a single
 * object shape must be written as `interface X { ... }`. The two forms are
 * functionally equivalent for plain object shapes, so the codebase picks
 * one — `interface` wins by a 5:1 majority.
 *
 * What is flagged:
 *   `type X = { a: T; b: U };`           // single object shape
 *   `type X = {\n    a: T;\n    b: U;\n};`
 *   `export type X = { ... };`
 *
 * What is NOT flagged:
 *   `type X = 'a' | 'b';`                // union of literals
 *   `type X = A | B;`                    // union of types
 *   `type X = { a: T } | { b: T };`      // discriminated union
 *   `type X = A & { b: T };`             // intersection
 *   `type X = (args: A) => R;`           // function type
 *   `type X = typeof Y;`                 // typeof alias
 *   `type X = Readonly<{ ... }>;`        // wrapped type
 *   `type X = { [K in keyof T]: V };`    // mapped type — interfaces can't express
 *
 * The heuristic: RHS starts with `{`, the matching `}` is followed only by
 * whitespace before the next `;`, and the body contains no mapped-type
 * pattern `[<UpperIdent> in `.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    collect_typescript_files,
    find_matching_brace,
    line_number_at,
    skip_whitespace_in_code,
    strip_to_code_only,
} from '../../helpers/typescript_source_tokenizer.js';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCAN_DIRECTORIES = ['src', 'test'].map((name) => path.join(REPOSITORY_ROOT, name));
const SELF_FILE = path.join(__dirname, 'interface-over-type-alias.test.ts');

const TYPE_DECLARATION_PATTERN = /\btype\s+([A-Z]\w*)\s*(?:<[^>]*>)?\s*=\s*/g;
const MAPPED_TYPE_PATTERN = /\[\s*[A-Z]\w*\s+in\s+/;

function find_object_shape_type_aliases(source: string): { name: string; line: number }[] {
    const blanked = strip_to_code_only(source);
    const findings: { name: string; line: number }[] = [];
    TYPE_DECLARATION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TYPE_DECLARATION_PATTERN.exec(blanked)) !== null) {
        const name = match[1];
        const rhs_start = skip_whitespace_in_code(source, match.index + match[0].length);
        if (source[rhs_start] !== '{') {
            continue;
        }
        const close_at = find_matching_brace(source, rhs_start);
        // Everything between `}` and the next `;` must be whitespace.
        const after_close = source.substring(close_at + 1);
        const semicolon_at = after_close.indexOf(';');
        if (semicolon_at === -1) {
            continue;
        }
        const between = after_close.substring(0, semicolon_at);
        if (between.trim() !== '') {
            continue;
        }
        // Exclude mapped types — interfaces can't express them.
        const body = source.substring(rhs_start + 1, close_at);
        const body_code = strip_to_code_only(body);
        if (MAPPED_TYPE_PATTERN.test(body_code)) {
            continue;
        }
        findings.push({ name, line: line_number_at(source, match.index) });
    }

    return findings;
}

describe('interface-over-type-alias discipline', () => {
    it('object-shape `type X = { ... }` aliases must be `interface X { ... }`', () => {
        const all_files: string[] = [];
        for (const directory of SCAN_DIRECTORIES) {
            collect_typescript_files(directory, all_files);
        }

        const violations: { file: string; line: number; name: string }[] = [];

        for (const file_path of all_files) {
            if (file_path === SELF_FILE) {
                continue;
            }
            const contents = fs.readFileSync(file_path, 'utf8');
            for (const finding of find_object_shape_type_aliases(contents)) {
                violations.push({
                    file: path.relative(REPOSITORY_ROOT, file_path),
                    line: finding.line,
                    name: finding.name,
                });
            }
        }

        expect(
            violations,
            `Object-shape \`type\` aliases — rewrite as \`interface\`:\n${violations
                .map((v) => `  ${v.file}:${v.line}  ${v.name}`)
                .join('\n')}`,
        ).toEqual([]);
    });

    it('positive control: flags an object-shape type alias placed after a string literal', () => {
        const source = [
            'const decoy = "a string a broken tokenizer might run past";',
            'type Point = { x: number };',
        ].join('\n');
        expect(find_object_shape_type_aliases(source)).toEqual([{ name: 'Point', line: 2 }]);
    });
});
