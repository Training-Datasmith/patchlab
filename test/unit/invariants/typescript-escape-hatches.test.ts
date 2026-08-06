/**
 * Structural lock against TypeScript escape hatches in src/ and test/.
 *
 * Forbidden outright:
 *   - `// @ts-ignore` — suppresses ALL errors on the next line, including
 *     ones unrelated to whatever the author was working around. Use
 *     `@ts-expect-error` (which fails if there's no error to suppress) or
 *     fix the type.
 *   - `// @ts-nocheck` — disables type-checking for the whole file. Never
 *     appropriate in a strictly-typed codebase.
 *   - `as any` — defeats inference end-to-end. The few real escape hatches
 *     in this repo use `as unknown as <Specific_Type>` to scope the cast.
 *
 * Permitted with structural requirement:
 *   - `// @ts-expect-error` — must carry on-line justification text. A bare
 *     directive with no comment makes the cast invisible at review time;
 *     requiring "// @ts-expect-error: <reason>" keeps each use deliberate.
 *
 * Why a unit test instead of an ESLint rule: there's no eslint dependency
 * in this project. The cost-vs-coverage tradeoff favors a 100-LOC vitest
 * scan over importing a lint toolchain.
 *
 * The tokenizer (shared shape with the other code-quality invariants in
 * this directory) walks character-by-character so directives mentioned in
 * block comments or string literals — including this docstring — are not
 * falsely flagged.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    collect_typescript_files,
    line_number_at,
    skip_block_comment,
    skip_quoted_string,
    skip_template_literal,
} from '../../helpers/typescript_source_tokenizer.js';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCAN_DIRECTORIES = ['src', 'test'].map((name) => path.join(REPOSITORY_ROOT, name));
const SELF_FILE = path.join(__dirname, 'typescript-escape-hatches.test.ts');

type Violation_Kind =
    | '@ts-ignore'
    | '@ts-nocheck'
    | '@ts-expect-error without justification'
    | 'as any';

const LINE_COMMENT_DIRECTIVE = /^\s*(@ts-ignore|@ts-nocheck|@ts-expect-error)\b\s*(.*)$/;
const AS_ANY_PATTERN = /\bas\s+any\b/g;

function inspect_line_comment(
    source: string,
    start: number,
): { kind: Violation_Kind; line: number } | null {
    // `start` points at the first `/` of `//`. Find end of line and isolate
    // the comment body (text after the `//`).
    const newline_at = source.indexOf('\n', start);
    const end = newline_at === -1 ? source.length : newline_at;
    const body = source.substring(start + 2, end);
    const match = LINE_COMMENT_DIRECTIVE.exec(body);
    if (!match) {
        return null;
    }

    const directive = match[1];
    const trailing = match[2].trim();
    if (directive === '@ts-ignore') {
        return { kind: '@ts-ignore', line: line_number_at(source, start) };
    }

    if (directive === '@ts-nocheck') {
        return { kind: '@ts-nocheck', line: line_number_at(source, start) };
    }

    if (directive === '@ts-expect-error' && trailing.length === 0) {
        return {
            kind: '@ts-expect-error without justification',
            line: line_number_at(source, start),
        };
    }

    return null;
}

function try_consume_position_at(
    source: string,
    i: number,
    found: { kind: Violation_Kind; line: number }[],
): number | null {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
        const directive = inspect_line_comment(source, i);
        if (directive) {
            found.push(directive);
        }
        const newline_at = source.indexOf('\n', i);
        return newline_at === -1 ? source.length : newline_at + 1;
    }

    if (c === '/' && next === '*') {
        return skip_block_comment(source, i);
    }

    if (c === '`') {
        return skip_template_literal(source, i);
    }

    if (c === '"' || c === "'") {
        return skip_quoted_string(source, i);
    }

    AS_ANY_PATTERN.lastIndex = i;
    const match = AS_ANY_PATTERN.exec(source);
    if (match?.index === i) {
        found.push({ kind: 'as any', line: line_number_at(source, i) });
        return match.index + match[0].length;
    }

    return null;
}

function find_escape_hatches(
    source: string,
): { kind: Violation_Kind; line: number }[] {
    const found: { kind: Violation_Kind; line: number }[] = [];
    let i = 0;
    while (i < source.length) {
        const advanced = try_consume_position_at(source, i, found);
        i = advanced ?? i + 1;
    }

    return found;
}

describe('TypeScript escape hatches', () => {
    it('no @ts-ignore / @ts-nocheck / bare @ts-expect-error / `as any` in src/ or test/', () => {
        const all_files: string[] = [];
        for (const directory of SCAN_DIRECTORIES) {
            collect_typescript_files(directory, all_files);
        }

        const violations: { file: string; line: number; kind: Violation_Kind }[] = [];

        for (const file_path of all_files) {
            if (file_path === SELF_FILE) {
                continue;
            }

            const contents = fs.readFileSync(file_path, 'utf8');
            for (const hatch of find_escape_hatches(contents)) {
                violations.push({
                    file: path.relative(REPOSITORY_ROOT, file_path),
                    line: hatch.line,
                    kind: hatch.kind,
                });
            }
        }

        expect(
            violations,
            `TypeScript escape hatches found:\n${violations
                .map((v) => `  ${v.file}:${v.line}  ${v.kind}`)
                .join('\n')}`,
        ).toEqual([]);
    });

    it('positive control: flags `as any` placed after a string literal', () => {
        const source = [
            'const decoy = "a string a broken tokenizer might run past";',
            'const x = decoy as any;',
        ].join('\n');
        expect(find_escape_hatches(source)).toEqual([{ kind: 'as any', line: 2 }]);
    });
});
