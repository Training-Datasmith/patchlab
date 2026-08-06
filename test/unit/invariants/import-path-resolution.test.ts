/**
 * Structural lock for relative-path module specifiers across `src/` and
 * `test/`. Every `from '...'`, `import('...')`, and `vi.mock/unmock/doMock/
 * doUnmock('...')` specifier that begins with `./` or `../` must point at a
 * file that actually exists on disk under Node16/NodeNext ESM resolution
 * rules — no directory fallback, no extension fallback.
 *
 * Why this is a unit test and not a tsc invariant: the test pass runs under
 * `moduleResolution: Bundler` (see `tsconfig.tests.json` for the rationale —
 * bundler mode is the only setting that handles vitest's `await import(...)`
 * after `vi.mock(...)` pattern cleanly). Bundler resolution silently falls
 * back from `foo.js` to `foo/index.ts` when the sibling file is absent, but
 * Node's runtime resolver does NOT. A stale `.js` specifier that points at
 * what used to be a sibling file but is now a directory typechecks green and
 * fails at runtime.
 *
 * The concrete bug that motivated this test: after the `branch.ts` split
 * moved the module into `branch/index.ts`, two dynamic
 * `await import(...)` calls in `test/integration/multi-source.test.ts` were
 * missed by the rename sweep (which grepped `from '...branch.js'` but not
 * `import('...branch.js')`). The integration suite caught it ~27 minutes
 * into the run. This unit test finishes in ~50ms.
 *
 * Why a hand-written tokenizer instead of `RegExp.matchAll`: an earlier
 * regex-only version produced false positives on three classes of input:
 *   1. JSDoc / line comments containing import syntax as documentation
 *      examples.
 *   2. Shell command strings (`'echo \'... from "./foo";\' > ...'`) that
 *      embed `from '...'` as plain text inside a code string literal.
 *   3. This file's own docstring (the one you're reading) mentions
 *      `'../../src/branch.js'` as the historical buggy path.
 * The tokenizer tracks string and comment state so only specifiers that are
 * genuinely module-loading positions get captured.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    collect_typescript_files,
    consume_quoted_string,
    skip_block_comment,
    skip_line_comment,
    skip_template_literal,
} from '../../helpers/typescript_source_tokenizer.js';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCAN_DIRECTORIES = ['src', 'test'].map((name) => path.join(REPOSITORY_ROOT, name));

type Specifier_Kind = 'static import/export' | 'dynamic import' | 'vi.mock specifier';

function preceded_by_module_keyword(source: string, at: number): Specifier_Kind | null {
    // Look back at most 80 characters — enough to span
    // `vi.doUnmock\n    (\n    ` plus whitespace, but bounded so the regex
    // tests stay constant-time per match.
    const window = source.substring(Math.max(0, at - 80), at);
    if (/\bfrom\s+$/.test(window)) {
        return 'static import/export';
    }
    if (/\bimport\s*\(\s*$/.test(window)) {
        return 'dynamic import';
    }
    if (/\bvi\s*\.\s*(?:mock|unmock|doMock|doUnmock)\s*\(\s*$/.test(window)) {
        return 'vi.mock specifier';
    }
    return null;
}

function extract_module_specifiers(
    source: string,
): { kind: Specifier_Kind; specifier: string }[] {
    // Single-pass character walker. Each branch delegates the actual
    // consumption to a tiny helper, so this function stays a dispatcher.
    // Tracks `//`, `/* */`, `'...'`, `"..."`, and `` `...` `` regions.
    // Regex literals are not distinguished — acceptable because no real
    // regex literal can be preceded by `from`/`import(`/`vi.X(`.
    const found: { kind: Specifier_Kind; specifier: string }[] = [];
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
            const string_open = i;
            const { content, end } = consume_quoted_string(source, i);
            i = end;
            const kind = preceded_by_module_keyword(source, string_open);
            if (kind && (content.startsWith('./') || content.startsWith('../'))) {
                found.push({ kind, specifier: content });
            }
            continue;
        }

        i++;
    }

    return found;
}

function source_exists_for_specifier(importer_file: string, specifier: string): boolean {
    const importer_directory = path.dirname(importer_file);
    const resolved = path.resolve(importer_directory, specifier);

    if (specifier.endsWith('.js')) {
        // Under Node16/NodeNext ESM the `.js` specifier maps to a `.ts`
        // source file at the same relative path (tsc emits `.js` at build
        // time but tests run the `.ts` directly via vitest's esbuild). There
        // is NO directory fallback — `foo.js` does not silently resolve to
        // `foo/index.ts` / `foo/index.js`.
        const typescript_source = resolved.slice(0, -'.js'.length) + '.ts';
        return fs.existsSync(typescript_source) || fs.existsSync(resolved);
    }
    if (specifier.endsWith('.ts') || specifier.endsWith('.json')
        || specifier.endsWith('.mjs') || specifier.endsWith('.cjs')) {
        return fs.existsSync(resolved);
    }
    // Extensionless specifier — accept both the file form and the directory
    // form. Rare in this codebase but handled for completeness.
    return (
        fs.existsSync(resolved + '.ts')
        || fs.existsSync(path.join(resolved, 'index.ts'))
        || fs.existsSync(resolved)
    );
}

describe('relative import specifiers resolve to real source files (Node ESM rules)', () => {
    it('every relative `from` / `import(...)` / `vi.mock(...)` path under src/ and test/ resolves', () => {
        const all_files: string[] = [];
        for (const directory of SCAN_DIRECTORIES) {
            collect_typescript_files(directory, all_files);
        }

        const stale: { importer: string; kind: string; specifier: string }[] = [];

        for (const file_path of all_files) {
            const contents = fs.readFileSync(file_path, 'utf8');
            for (const { kind, specifier } of extract_module_specifiers(contents)) {
                if (!source_exists_for_specifier(file_path, specifier)) {
                    stale.push({
                        importer: path.relative(REPOSITORY_ROOT, file_path),
                        kind,
                        specifier,
                    });
                }
            }
        }

        expect(
            stale,
            `Relative module specifiers that don't resolve to a real source file:\n${stale
                .map((s) => `  ${s.importer}  (${s.kind})  ->  ${s.specifier}`)
                .join('\n')}`,
        ).toEqual([]);
    });
});
