/**
 * Structural lock for control-structure formatting in `src/` and `test/`.
 *
 * The project's house style (see the [[control-structure-blocks]] feedback
 * memory) requires every `if`, `else`, `for`, `while`, `do`, `try`, `catch`,
 * and `finally` to use the canonical block form:
 *
 * ```ts
 * if (condition) {
 *     body;
 * }
 * ```
 *
 * Not the braceless statement form (`if (cond) body;`) and not the same-line
 * block form (`if (cond) { body; }` / `try { ... } catch { ... }`).
 *
 * This scanner walks each TypeScript file via the shared tokenizer (so
 * keywords inside string literals or comments are not flagged), classifies
 * every control-structure occurrence into one of:
 *   - **statement-form** — header followed by a non-brace body on the same
 *     or next line (`if (x) return;`)
 *   - **one-line-block** — opening `{` and closing `}` of the body on the
 *     same line (`try { ... } catch { ... }`)
 *   - canonical block form (the rest — not reported)
 *
 * Both non-canonical forms fail the test. There is no allowlist: the
 * codebase was cleaned to zero before this scanner landed; new violations
 * MUST be rewritten to block form.
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
} from '../../helpers/typescript_source_tokenizer.js';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCAN_DIRECTORIES = ['src', 'test'].map((name) => path.join(REPOSITORY_ROOT, name));
const SELF_FILE = path.join(__dirname, 'control-structure-block-form.test.ts');

type Violation_Kind = 'statement-form' | 'one-line-block';

type Header_Kind = 'parenthesised' | 'bare';

const PARENTHESISED_KEYWORDS = ['if', 'for', 'while', 'catch'] as const;
const BARE_KEYWORDS = ['else', 'do', 'try', 'finally'] as const;

function is_identifier_char(c: string | undefined): boolean {
    if (c === undefined) {
        return false;
    }
    return /[A-Za-z0-9_$]/.test(c);
}

function keyword_at(source: string, position: number): { keyword: string; kind: Header_Kind } | null {
    // Word-boundary check: the char before `position` (if any) must not be
    // an identifier char.
    if (is_identifier_char(source[position - 1])) {
        return null;
    }
    for (const keyword of PARENTHESISED_KEYWORDS) {
        if (source.startsWith(keyword, position)
            && !is_identifier_char(source[position + keyword.length])) {
            return { keyword, kind: 'parenthesised' };
        }
    }
    for (const keyword of BARE_KEYWORDS) {
        if (source.startsWith(keyword, position)
            && !is_identifier_char(source[position + keyword.length])) {
            return { keyword, kind: 'bare' };
        }
    }
    return null;
}

function skip_balanced_parens(source: string, open_at: number): number {
    // `open_at` points at `(`. Walk until the matching `)`. Skip non-code
    // regions inside the parens (string literals, comments) so e.g.
    // `if (x === ')')` is handled correctly.
    let depth = 0;
    let i = open_at;
    while (i < source.length) {
        const blanked = skip_to_next_blanked_region(source, i);
        if (blanked !== null) {
            i = blanked;
            continue;
        }
        const c = source[i];
        if (c === '(') {
            depth++;
        } else if (c === ')') {
            depth--;
            if (depth === 0) {
                return i + 1;
            }
        }
        i++;
    }
    return i;
}

function find_header_end(source: string, after_keyword: number, kind: Header_Kind): number {
    if (kind === 'bare') {
        return after_keyword;
    }
    // `parenthesised`: skip whitespace, expect `(`, then balanced parens.
    const paren_open = skip_whitespace_in_code(source, after_keyword);
    if (source[paren_open] !== '(') {
        // Defensive: shouldn't happen for valid TS, but don't crash.
        return after_keyword;
    }
    return skip_balanced_parens(source, paren_open);
}

function classify_at_keyword(
    source: string,
    keyword_position: number,
    keyword_length: number,
    header_kind: Header_Kind,
): { violation: Violation_Kind | null; advance_to: number } {
    const after_keyword = keyword_position + keyword_length;
    const header_end = find_header_end(source, after_keyword, header_kind);
    const body_start = skip_whitespace_in_code(source, header_end);
    if (body_start >= source.length) {
        return { violation: null, advance_to: source.length };
    }
    if (source[body_start] !== '{') {
        // Statement form. The body is whatever follows; advance to end of
        // line so we don't double-count the body's own keywords.
        const newline_at = source.indexOf('\n', body_start);
        const advance_to = newline_at === -1 ? source.length : newline_at + 1;
        return { violation: 'statement-form', advance_to };
    }
    // Block form. Find the matching `}` and check whether it's on the same
    // line as the opening `{`.
    const close_at = find_matching_brace(source, body_start);
    const open_line = line_number_at(source, body_start);
    const close_line = line_number_at(source, close_at);
    const violation: Violation_Kind | null = open_line === close_line ? 'one-line-block' : null;
    return { violation, advance_to: close_at + 1 };
}

function find_control_structure_violations(
    source: string,
): { keyword: string; kind: Violation_Kind; line: number }[] {
    const findings: { keyword: string; kind: Violation_Kind; line: number }[] = [];
    let i = 0;
    while (i < source.length) {
        const blanked = skip_to_next_blanked_region(source, i);
        if (blanked !== null) {
            i = blanked;
            continue;
        }
        const at_keyword = keyword_at(source, i);
        if (at_keyword === null) {
            i++;
            continue;
        }
        // Special handling for `else`: if it's followed by ` if`, the
        // `else if` chain is a canonical idiom; let the inner `if` get its
        // own classification at the next iteration.
        if (at_keyword.keyword === 'else') {
            const after = skip_whitespace_in_code(source, i + 'else'.length);
            if (source.startsWith('if', after) && !is_identifier_char(source[after + 2])) {
                i = i + 'else'.length;
                continue;
            }
        }
        // Special handling for `do`: the `do { ... } while (...)` form
        // classifies the `do` block by the `{...}` it opens; the trailing
        // `while (...)` is part of the construct, not an independent
        // keyword. Skip past the entire construct.
        const { violation, advance_to } = classify_at_keyword(
            source,
            i,
            at_keyword.keyword.length,
            at_keyword.kind,
        );
        if (violation !== null) {
            findings.push({
                keyword: at_keyword.keyword,
                kind: violation,
                line: line_number_at(source, i),
            });
        }
        i = advance_to > i ? advance_to : i + 1;
    }
    return findings;
}

describe('control-structure block-form discipline', () => {
    it('no statement-form (braceless) or same-line block forms in src/ or test/', () => {
        const all_files: string[] = [];
        for (const directory of SCAN_DIRECTORIES) {
            collect_typescript_files(directory, all_files);
        }

        const violations: {
            file: string; line: number; keyword: string; kind: Violation_Kind;
        }[] = [];

        for (const file_path of all_files) {
            if (file_path === SELF_FILE) {
                continue;
            }
            const contents = fs.readFileSync(file_path, 'utf8');
            for (const finding of find_control_structure_violations(contents)) {
                violations.push({
                    file: path.relative(REPOSITORY_ROOT, file_path),
                    line: finding.line,
                    keyword: finding.keyword,
                    kind: finding.kind,
                });
            }
        }

        expect(
            violations,
            `Non-canonical control-structure forms — rewrite to block form on separate lines:\n${violations
                .map((v) => `  ${v.file}:${v.line}  ${v.keyword}  ${v.kind}`)
                .join('\n')}`,
        ).toEqual([]);
    });

    it('positive control: flags a braceless control body placed after a string literal', () => {
        const source = [
            'const decoy = "a string a broken tokenizer might run past";',
            'if (decoy) return 1;',
        ].join('\n');
        expect(find_control_structure_violations(source))
            .toEqual([{ keyword: 'if', kind: 'statement-form', line: 2 }]);
    });
});
