/**
 * Structural lock against committed test-focus markers.
 *
 * `it.only(...)` / `describe.only(...)` / `test.only(...)` silently narrow a
 * file's execution to a single block — when accidentally committed, the file
 * appears to pass CI while skipping every other test it contains.
 *
 * `it.skip(...)` / `describe.skip(...)` / `test.skip(...)` are valid for
 * runtime-conditional skipping (e.g. the EPERM gate in
 * `configuration-loader.test.ts` that no-ops on hosts without symlink
 * privileges) but NOT for top-of-file "skip this test" markers committed
 * during local debugging. The scanner distinguishes by call site: a static
 * `it.skip('...', () => ...)` in the source text is a leftover; a
 * `let runner = should_skip ? it.skip : it; runner(...)` is not.
 *
 * `it.todo(...)` / `test.todo(...)` are similar — they pass green while
 * leaving the named behavior unimplemented; not appropriate in committed
 * code where the change wasn't actually delivered.
 *
 * The tokenizer-based extraction (same shape as
 * `import-path-resolution.test.ts`) avoids false positives from string
 * literals and comments mentioning these patterns.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    collect_typescript_test_files,
    line_number_at,
    skip_block_comment,
    skip_line_comment,
    skip_quoted_string,
    skip_template_literal,
} from '../../helpers/typescript_source_tokenizer.js';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_DIRECTORY = path.join(REPOSITORY_ROOT, 'test');
const SELF_FILE = path.join(__dirname, 'focused-and-skipped-tests.test.ts');

type Marker_Kind = '.only' | '.skip' | '.todo';

const MARKER_PATTERN = /\b(?:describe|it|test)\.(only|skip|todo)\s*\(/g;

function find_focus_markers(
    source: string,
): { kind: Marker_Kind; line: number }[] {
    // Walk the source, skipping comment and string regions, collecting any
    // direct `.only`/`.skip`/`.todo` call sites that appear in real code.
    const found: { kind: Marker_Kind; line: number }[] = [];
    let i = 0;
    while (i < source.length) {
        const c = source[i];
        const next = source[i + 1];
        if (c === '/' && next === '/') {
            i = skip_line_comment(source, i);
            continue;
        }
        if (c === '/' && next === '*') {
            i = skip_block_comment(source, i);
            continue;
        }
        if (c === '`') {
            i = skip_template_literal(source, i);
            continue;
        }
        if (c === '"' || c === "'") {
            i = skip_quoted_string(source, i);
            continue;
        }
        MARKER_PATTERN.lastIndex = i;
        const match = MARKER_PATTERN.exec(source);
        if (match && match.index === i) {
            found.push({
                kind: `.${match[1]}` as Marker_Kind,
                line: line_number_at(source, i),
            });
            i = match.index + match[0].length;
            continue;
        }
        i++;
    }
    return found;
}

describe('no committed test-focus or test-skip leftovers', () => {
    it('no `.only` / `.skip` / `.todo` call sites in test/**/*.test.ts', () => {
        const all_test_files: string[] = [];
        collect_typescript_test_files(TEST_DIRECTORY, all_test_files);

        const leftovers: { file: string; line: number; kind: Marker_Kind }[] = [];

        for (const file_path of all_test_files) {
            if (file_path === SELF_FILE) {
                continue;
            }

            const contents = fs.readFileSync(file_path, 'utf8');
            for (const marker of find_focus_markers(contents)) {
                leftovers.push({
                    file: path.relative(REPOSITORY_ROOT, file_path),
                    line: marker.line,
                    kind: marker.kind,
                });
            }
        }

        expect(
            leftovers,
            `Committed test-focus / test-skip markers found:\n${leftovers
                .map((l) => `  ${l.file}:${l.line}  ${l.kind}`)
                .join('\n')}`,
        ).toEqual([]);
    });

    it('positive control: flags a focus marker placed after a string literal', () => {
        const source = [
            'const decoy = "a string a broken tokenizer might run past";',
            'it.only("x", () => {});',
        ].join('\n');
        expect(find_focus_markers(source)).toEqual([{ kind: '.only', line: 2 }]);
    });
});
