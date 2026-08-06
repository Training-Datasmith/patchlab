/**
 * Structural lock for output-channel discipline in src/.
 *
 * All user-facing output SHALL flow through `logger()` from src/logger.ts.
 * The four supported channels (`result` / `info` / `warn` / `error`) map
 * onto the appropriate stdio handle internally; everything else is a
 * bypass and gets flagged by this test:
 *
 *   - `console.log/warn/error/info/debug(...)`  — the original target of
 *     the migration; locks the contract that motivated the logger seam.
 *   - `process.stdout.write(...)` / `process.stderr.write(...)`  — same
 *     bypass at one layer below `console.*`. The logger itself uses these
 *     internally, so src/logger.ts is exempt.
 *   - `fs.writeSync(1, ...)` / `fs.writeSync(2, ...)`  — same bypass at
 *     the lowest layer.
 *
 * The tokenizer (same shape as the sibling code-quality invariants) walks
 * the source so the patterns mentioned in JSDoc / line comments — e.g. the
 * comment in src/cgroups.ts:133 that documents "NOT process.stderr.write"
 * as the rule — are not flagged. Only real call sites count.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    collect_typescript_files,
    line_number_at,
    skip_block_comment,
    skip_line_comment,
    skip_quoted_string,
    skip_template_literal,
} from '../../helpers/typescript_source_tokenizer.js';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const SRC_DIRECTORY = path.join(REPOSITORY_ROOT, 'src');
const LOGGER_FILE = path.join(SRC_DIRECTORY, 'logger.ts');

type Violation_Kind =
    | 'console.*'
    | 'process.stdout.write'
    | 'process.stderr.write'
    | 'fs.writeSync(1|2, ...)';

const BYPASS_PATTERNS: { kind: Violation_Kind; pattern: RegExp }[] = [
    { kind: 'console.*', pattern: /\bconsole\.(?:log|warn|error|info|debug)\s*\(/g },
    { kind: 'process.stdout.write', pattern: /\bprocess\.stdout\.write\s*\(/g },
    { kind: 'process.stderr.write', pattern: /\bprocess\.stderr\.write\s*\(/g },
    { kind: 'fs.writeSync(1|2, ...)', pattern: /\bfs\.writeSync\s*\(\s*[12]\s*[,)]/g },
];

function try_match_bypass_at(
    source: string,
    i: number,
): { kind: Violation_Kind; consumed: number } | null {
    for (const { kind, pattern } of BYPASS_PATTERNS) {
        pattern.lastIndex = i;
        const match = pattern.exec(source);
        if (match?.index === i) {
            return { kind, consumed: match[0].length };
        }
    }

    return null;
}

function find_bypass_call_sites(
    source: string,
): { kind: Violation_Kind; line: number }[] {
    const found: { kind: Violation_Kind; line: number }[] = [];
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

        const bypass = try_match_bypass_at(source, i);
        if (bypass) {
            found.push({ kind: bypass.kind, line: line_number_at(source, i) });
            i += bypass.consumed;
            continue;
        }
        i++;
    }

    return found;
}

describe('output channel discipline: no logger bypasses in src/', () => {
    it('no console.* / process.stdout.write / process.stderr.write / fs.writeSync(1|2, ...) outside src/logger.ts', () => {
        const all_files: string[] = [];
        collect_typescript_files(SRC_DIRECTORY, all_files);

        const offenders: { file: string; line: number; kind: Violation_Kind }[] = [];

        for (const file_path of all_files) {
            if (file_path === LOGGER_FILE) {
                continue;
            }
            const contents = fs.readFileSync(file_path, 'utf8');
            for (const call_site of find_bypass_call_sites(contents)) {
                offenders.push({
                    file: path.relative(REPOSITORY_ROOT, file_path),
                    line: call_site.line,
                    kind: call_site.kind,
                });
            }
        }

        expect(
            offenders,
            `Direct stdio bypass calls found in src/ outside logger.ts:\n${offenders
                .map((o) => `  ${o.file}:${o.line}  ${o.kind}`)
                .join('\n')}`,
        ).toEqual([]);
    });

    it('positive control: flags a real bypass in code, ignores look-alikes in strings/comments/templates', () => {
        // Without this control an empty offender list is ambiguous: a tokenizer
        // over-consumption bug (shared across all invariants) would scan nothing
        // and also produce `[]`. This asserts the scanner DOES fire on a genuine
        // call and does NOT fire on the same text quoted, commented, or templated.
        const source = [
            'const value = 1;',
            'console.log(value);',                  // line 2 — the only real violation
            'const text = "console.log(value)";',   // inside a string — must be ignored
            '// console.log(value)',                // line comment — must be ignored
            '/* console.log(value) */',             // block comment — must be ignored
            'const tpl = `console.log(${value})`;', // template literal — must be ignored
        ].join('\n');

        expect(find_bypass_call_sites(source)).toEqual([{ kind: 'console.*', line: 2 }]);
    });
});
