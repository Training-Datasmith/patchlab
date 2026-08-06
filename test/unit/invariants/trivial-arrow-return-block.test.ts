/**
 * Structural lock against block-form arrow bodies whose only statement is a
 * single `return <expression>;`. The expression-body form is shorter and
 * matches the rest of the codebase's `.filter((r) => r.x)` / `.map((r) =>
 * r.y)` style. Multi-statement blocks, blocks with intermediate `const`, or
 * blocks with two `return` statements (early-exit branches) stay as-is —
 * those are the cases where block form pulls its weight.
 *
 * What is flagged:
 *   `(r) => { return foo; }`             // single return, expression-body wins
 *   `(r) => {\n    return foo.bar();\n}` // same — multiline doesn't justify it
 *
 * What is NOT flagged:
 *   `(r) => { return; }`                            // bare return: not 1:1 with expression form
 *   `(r) => { if (r.x) return true; return r.y; }`  // two statements
 *   `(r) => { const x = compute(r); return x.y; }`  // intermediate binding
 *   `() => { foo(); }`                              // side-effect body, no return
 *
 * Note on object-literal returns: `(r) => { return { x: r }; }` IS flagged,
 * but the rewrite requires parens — `(r) => ({ x: r })`. The scanner doesn't
 * auto-fix; the human applies the parens.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    collect_typescript_files,
    find_matching_brace,
    line_number_at,
    skip_to_next_blanked_region,
    skip_whitespace_in_code,
    strip_to_code_only,
} from '../../helpers/typescript_source_tokenizer.js';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCAN_DIRECTORIES = ['src', 'test'].map((name) => path.join(REPOSITORY_ROOT, name));
const SELF_FILE = path.join(__dirname, 'trivial-arrow-return-block.test.ts');

function body_is_trivial_return(body: string): boolean {
    // Blank out comments/strings/templates/regex so e.g. `return /* x */ y;`
    // still classifies as a trivial single-return.
    const code = strip_to_code_only(body).trim();
    if (!code.startsWith('return')) {
        return false;
    }
    const after_return = code.substring('return'.length);
    if (after_return.length === 0) {
        // Bare `return` with no expression — not flaggable (no 1:1 rewrite).
        return false;
    }
    // The character after `return` must not extend it into an identifier
    // (`returns`, `returnType`) or a property key (`return:` inside a type
    // literal like `() => { return: T }`).
    const next_char = after_return[0];
    if (/[A-Za-z0-9_$:]/.test(next_char)) {
        return false;
    }
    // Walk forward to find the first top-level `;`. The expression is what
    // precedes it; anything after must be only whitespace.
    let depth = 0;
    let semicolon_at = -1;
    for (let i = 0; i < after_return.length; i++) {
        const c = after_return[i];
        if (c === '(' || c === '[' || c === '{') {
            depth++;
        } else if (c === ')' || c === ']' || c === '}') {
            depth--;
        } else if (c === ';' && depth === 0) {
            semicolon_at = i;
            break;
        }
    }
    const expression = (semicolon_at === -1
        ? after_return
        : after_return.substring(0, semicolon_at)).trim();
    const trailing = (semicolon_at === -1
        ? ''
        : after_return.substring(semicolon_at + 1)).trim();
    if (expression === '') {
        return false;
    }

    return trailing === '';
}

function find_trivial_arrow_blocks(source: string): { line: number }[] {
    const findings: { line: number }[] = [];
    let i = 0;
    while (i < source.length) {
        const blanked = skip_to_next_blanked_region(source, i);
        if (blanked !== null) {
            i = blanked;
            continue;
        }
        if (source[i] === '=' && source[i + 1] === '>') {
            const arrow_at = i;
            const body_start = skip_whitespace_in_code(source, i + 2);
            if (source[body_start] === '{') {
                const close_at = find_matching_brace(source, body_start);
                const body = source.substring(body_start + 1, close_at);
                if (body_is_trivial_return(body)) {
                    findings.push({ line: line_number_at(source, arrow_at) });
                }
                i = close_at + 1;
                continue;
            }
        }
        i++;
    }

    return findings;
}

describe('trivial arrow-return block discipline', () => {
    it('no `=> { return X; }` arrow bodies in src/ or test/', () => {
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
            for (const finding of find_trivial_arrow_blocks(contents)) {
                violations.push({
                    file: path.relative(REPOSITORY_ROOT, file_path),
                    line: finding.line,
                });
            }
        }

        expect(
            violations,
            `Trivial \`=> { return X; }\` arrow bodies — rewrite as expression body \`=> X\`:\n${violations
                .map((v) => `  ${v.file}:${v.line}`)
                .join('\n')}`,
        ).toEqual([]);
    });

    it('positive control: flags a trivial arrow block placed after a string literal', () => {
        const source = [
            'const decoy = "a string a broken tokenizer might run past";',
            'const f = (a) => { return a + 1; };',
        ].join('\n');
        expect(find_trivial_arrow_blocks(source)).toEqual([{ line: 2 }]);
    });
});
