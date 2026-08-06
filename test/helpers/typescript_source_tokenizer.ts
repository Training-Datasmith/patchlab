/**
 * Shared TypeScript source tokenizing helpers for the structural-invariant
 * scanners under `test/unit/`.
 *
 * Six sibling scanners (`import-path-resolution`,
 * `focused-and-skipped-tests-invariant`, `typescript-escape-hatches-invariant`,
 * `logger-migration-invariant`, `cli-handler-test-reference-invariant`, and
 * `abbreviated-identifier-invariant`) all need to walk TypeScript source
 * character by character, classifying each position as code / comment /
 * string literal / template literal. This module is the single canonical
 * implementation each scanner imports from.
 *
 * The tokenizer is deliberately not a full TypeScript parser:
 *   - It tracks `//` line comments, `/* *​/` block comments, `'...'` and
 *     `"..."` string literals, and `` `...` `` template literals (recursing
 *     into balanced `${...}` expressions).
 *   - It distinguishes regex literals from divisions via the standard
 *     "preceding token" heuristic: a `/` opens a regex when the previous
 *     non-whitespace code character is one that cannot end an expression
 *     (an operator, `(`, `,`, `;`, `:`, `=`, `{`, `[`, `!`, `?`, etc.) or
 *     when `/` is the first non-whitespace character in the file. After a
 *     value-producing token (identifier, number, `)`, `]`) `/` is division.
 *   - It does NOT validate string escapes beyond skipping the two characters
 *     after `\\`. Acceptable because the scanners only consume the result;
 *     they don't reconstruct semantics.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Skip past a `// ...` line comment starting at `start` (the first `/`).
 * Returns the index one past the newline, or `source.length` if the comment
 * runs to end of file.
 */
export function skip_line_comment(source: string, start: number): number {
    const newline_at = source.indexOf('\n', start);

    return (newline_at === -1) ? source.length : newline_at + 1;
}

/**
 * Skip past a `/* ... *​/` block comment starting at `start` (the first `/`).
 * Returns the index one past the closing `*​/`, or `source.length` if the
 * comment is unterminated.
 */
export function skip_block_comment(source: string, start: number): number {
    const close_at = source.indexOf('*/', start + 2);

    return (close_at === -1) ? source.length : close_at + 2;
}

/**
 * Walk a single-quoted or double-quoted string starting at `open_at` (the
 * opening quote). Returns the literal content (without surrounding quotes)
 * and the index one past the closing quote. Handles `\\<char>` escapes;
 * stops at a newline if the string is unterminated.
 */
export function consume_quoted_string(
    source: string,
    open_at: number,
): { content: string; end: number } {
    const quote = source[open_at];
    let i = open_at + 1;
    const content_start = i;
    while (i < source.length) {
        const c = source[i];
        if (c === '\\') {
            i += 2;
            continue;
        }
        if (c === quote || c === '\n') {
            break;
        }
        i++;
    }

    const content = source.substring(content_start, i);
    const end = source[i] === quote ? i + 1 : i;
    return { content, end };
}

/**
 * Convenience wrapper around `consume_quoted_string` for callers that don't
 * need the captured content — returns only the end index.
 */
export function skip_quoted_string(source: string, open_at: number): number {
    return consume_quoted_string(source, open_at).end;
}

/**
 * Skip a `${...}` expression inside a template literal. `start` points at
 * the `$`; the returned index is one past the matching `}`. Walks balanced
 * braces; ignores quoting inside the expression (acceptable because no
 * scanner currently inspects template-expression contents).
 */
export function skip_template_expression(source: string, start: number): number {
    let depth = 1;
    let i = start + 2;
    while (i < source.length && depth > 0) {
        const c = source[i];
        if (c === '{') {
            depth++;
        } else if (c === '}') {
            depth--;
        }
        i++;
    }
    return i;
}

/**
 * Walk a `` `...` `` template literal starting at `open_at` (the opening
 * backtick). Returns the index one past the closing backtick (or
 * `source.length` if unterminated). Recurses into `${...}` expressions via
 * `skip_template_expression`.
 */
export function skip_template_literal(source: string, open_at: number): number {
    let i = open_at + 1;
    while (i < source.length && source[i] !== '`') {
        const c = source[i];
        if (c === '\\') {
            i += 2;
            continue;
        }
        if (c === '$' && source[i + 1] === '{') {
            i = skip_template_expression(source, i);
            continue;
        }
        i++;
    }

    return (source[i] === '`') ? i + 1 : i;
}

/**
 * Walk a regex literal starting at `open_at` (the opening `/`). Returns the
 * index one past the closing `/` and any trailing flag characters. Handles
 * `\\<char>` escapes and `[...]` character classes (where `/` is literal,
 * not a terminator). Stops at a newline if the literal is unterminated.
 */
export function skip_regex_literal(source: string, open_at: number): number {
    let i = open_at + 1;
    let in_character_class = false;
    while (i < source.length) {
        const c = source[i];
        if (c === '\\') {
            i += 2;
            continue;
        }
        if (c === '\n') {
            return i;
        }
        if (c === '[') {
            in_character_class = true;
            i++;
            continue;
        }
        if (c === ']' && in_character_class) {
            in_character_class = false;
            i++;
            continue;
        }
        if (c === '/' && !in_character_class) {
            i++;
            break;
        }
        i++;
    }
    // Consume trailing regex flag characters (a-z).
    while (i < source.length && /[a-z]/.test(source[i])) {
        i++;
    }
    return i;
}

/**
 * Apply the standard JavaScript "preceding token" heuristic to decide
 * whether a `/` at `slash_at` starts a regex literal or a division. Walks
 * backwards over whitespace and line/block comments to find the last code
 * character; returns true when that character is one that cannot terminate
 * an expression (so `/` must begin a regex), or when there is no preceding
 * code character at all.
 */
function is_regex_literal_start(source: string, slash_at: number): boolean {
    let i = slash_at - 1;
    while (i >= 0) {
        const c = source[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
            i--;
            continue;
        }
        // Walk over a preceding `// ...` line comment by detecting its `\n`
        // already handled above; preceding block comments `/* ... */` need
        // explicit handling here.
        if (c === '/' && source[i - 1] === '*') {
            const open_at = source.lastIndexOf('/*', i - 2);
            if (open_at === -1) {
                return true;
            }
            i = open_at - 1;
            continue;
        }
        // Identifier / number / closing bracket / closing paren produce a
        // value: `/` after them is division.
        if (/[A-Za-z0-9_$)\]]/.test(c)) {
            // Keywords like `return`, `throw`, `typeof`, `in`, `of`, `new`,
            // `delete`, `void`, `instanceof`, `yield`, `await` are followed
            // by an expression, so `/` after them begins a regex.
            const word_end = i + 1;
            let word_start = i;
            while (word_start > 0 && /[A-Za-z0-9_$]/.test(source[word_start - 1])) {
                word_start--;
            }
            const word = source.substring(word_start, word_end);
            const expression_keywords = new Set([
                'return', 'throw', 'typeof', 'in', 'of', 'new', 'delete',
                'void', 'instanceof', 'yield', 'await', 'case',
            ]);
            return expression_keywords.has(word);
        }
        // Any operator / punctuator that introduces an expression context.
        return true;
    }
    return true;
}

/**
 * Probe whether position `i` opens a comment / string-literal / template-
 * literal / regex-literal region; return the index just past it, or null
 * when it doesn't. Used by `strip_to_code_only` and by scanners that walk
 * source one position at a time.
 */
export function skip_to_next_blanked_region(source: string, i: number): number | null {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
        return skip_line_comment(source, i);
    }
    if (c === '/' && next === '*') {
        return skip_block_comment(source, i);
    }
    if (c === '/' && is_regex_literal_start(source, i)) {
        return skip_regex_literal(source, i);
    }
    if (c === '`') {
        return skip_template_literal(source, i);
    }
    if (c === '"' || c === "'") {
        return skip_quoted_string(source, i);
    }
    return null;
}

/**
 * Walk forward from `from`, skipping whitespace and blanked regions (comments,
 * string literals, template literals, regex literals). Returns the index of
 * the next non-whitespace code character, or `source.length` if the file
 * ends in whitespace.
 */
export function skip_whitespace_in_code(source: string, from: number): number {
    let i = from;
    while (i < source.length) {
        const blanked = skip_to_next_blanked_region(source, i);
        if (blanked !== null) {
            i = blanked;
            continue;
        }
        const c = source[i];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
            i++;
            continue;
        }
        break;
    }

    return i;
}

/**
 * Given `open_at` pointing at a `{`, walk forward (skipping blanked regions)
 * until the matching `}`. Returns the index of that `}`, or `source.length`
 * if unbalanced.
 */
export function find_matching_brace(source: string, open_at: number): number {
    let depth = 0;
    let i = open_at;
    while (i < source.length) {
        const blanked = skip_to_next_blanked_region(source, i);
        if (blanked !== null) {
            i = blanked;
            continue;
        }
        const c = source[i];
        if (c === '{') {
            depth++;
        } else if (c === '}') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
        i++;
    }

    return i;
}

/**
 * Return the 1-based line number that contains character offset `position`.
 * O(position) — fine for the position counts the scanners produce, but
 * callers that need many line numbers per file should batch via a single
 * walk.
 */
export function line_number_at(source: string, position: number): number {
    let line = 1;
    for (let i = 0; i < position; i++) {
        if (source[i] === '\n') {
            line++;
        }
    }

    return line;
}

/**
 * Replace every comment, string-literal, and template-literal region in
 * `source` with spaces (newlines preserved). The returned string has the
 * SAME character length as the input — identifier searches against it
 * surface only at real code positions, but offsets stay comparable to the
 * original (so `line_number_at` against the stripped source returns the
 * same line as the input).
 */
export function strip_to_code_only(source: string): string {
    const out: string[] = [];
    let i = 0;
    while (i < source.length) {
        const region_end = skip_to_next_blanked_region(source, i);
        if (region_end !== null) {
            for (let position = i; position < region_end; position++) {
                out.push(source[position] === '\n' ? '\n' : ' ');
            }
            i = region_end;
            continue;
        }
        out.push(source[i]);
        i++;
    }

    return out.join('');
}

/**
 * Recursively walk `directory` and push every `.ts` file path into
 * `accumulator`. Used by scanners that scope over `src/` or `test/`.
 */
export function collect_typescript_files(directory: string, accumulator: string[]): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entry_path = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            collect_typescript_files(entry_path, accumulator);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            accumulator.push(entry_path);
        }
    }
}

/**
 * Recursively walk `directory` and push every `.test.ts` file path into
 * `accumulator`. Used by scanners that scope over committed test files
 * only (focused-and-skipped, cli-handler-test-reference).
 */
export function collect_typescript_test_files(directory: string, accumulator: string[]): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entry_path = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            collect_typescript_test_files(entry_path, accumulator);
        } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
            accumulator.push(entry_path);
        }
    }
}
