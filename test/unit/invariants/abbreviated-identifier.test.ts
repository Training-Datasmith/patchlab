/**
 * Structural lock against unambiguously-abbreviated identifier names at
 * declaration sites under `src/` and `test/`.
 *
 * The patchlab CLAUDE.md (and the [[naming]] feedback memory) calls for
 * the full word at every name we introduce: `directory` not `dir`,
 * `argument` not `arg`, `command` not `cmd`, `environment` not `env`,
 * `index` not `idx`, `error` not `err`, `package` not `pkg`. Established
 * external identifiers keep their canonical form (`process.env`,
 * `--git-dir`, `argv`, `errno`, `.idx` git pack-index files, etc.); those
 * appear in property accesses or string literals, not at OUR declaration
 * sites, so the scanner naturally excludes them.
 *
 * `args` (plural) is also exempt: it's the documented parameter name in
 * Node's `child_process.execFileSync(file[, args][, options])` /
 * `execFile` / `spawn` / `spawnSync` API surface. Our wrappers around
 * those calls name their input arrays `args` to match — same exemption
 * category as `git` / `URL` / `HTTP` / `id`. The singular `arg` is NOT
 * exempt because Node only documents the plural; a single iteration
 * variable is just an abbreviation of `argument`.
 *
 * The scope is deliberately narrow:
 *   - Only the SEVEN unambiguous abbreviations above. Words that may also
 *     be valid English nouns in some domain (`cap`, `config`, `repo`,
 *     `temp`) are NOT covered — those need judgment and a manual review
 *     pass.
 *   - Only DECLARATION sites: `const|let|var`, `catch (...)` parameters,
 *     the first parameter of a named `function` declaration on its
 *     opening line, and single-argument arrow lambdas (`(name) => ...`
 *     and `(name: type) => ...`). Multi-line parameter lists and
 *     multi-argument arrow lambdas are NOT covered — false-positive risk
 *     from function-call sites is too high to detect reliably without a
 *     real parser. These are accepted false negatives.
 *
 * The tokenizer is the same shape as the sibling code-quality invariants:
 * walk character-by-character, skip comment and string regions so
 * declaration-shaped text mentioned in JSDoc or in test fixture strings is
 * not flagged.
 *
 * Ratchet pattern: KNOWN_ABBREVIATED_DECLARATIONS lists the (file, name)
 * pairs that exist today. New violations not on the ratchet fail the test;
 * entries on the ratchet that have been fixed (no longer match) also fail
 * (so the ratchet self-shrinks). The goal is to drive the set to empty.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    collect_typescript_files,
    line_number_at,
    strip_to_code_only,
} from '../../helpers/typescript_source_tokenizer.js';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCAN_DIRECTORIES = ['src', 'test'].map((name) => path.join(REPOSITORY_ROOT, name));
const SELF_FILE = path.join(__dirname, 'abbreviated-identifier.test.ts');

const ABBREVIATED_NAMES = [
    'dir', 'dirs',
    'arg',
    'cmd', 'cmds',
    'env', 'envs',
    'idx',
    'err', 'errs',
    'pkg', 'pkgs',
] as const;

const NAME_GROUP = ABBREVIATED_NAMES.join('|');

const DECLARATION_PATTERNS: { kind: string; pattern: RegExp }[] = [
    {
        kind: 'const/let/var binding',
        pattern: new RegExp(String.raw`\b(?:const|let|var)\s+(${NAME_GROUP})\b`, 'g'),
    },
    {
        kind: 'catch parameter',
        pattern: new RegExp(String.raw`\bcatch\s*\(\s*(${NAME_GROUP})\b`, 'g'),
    },
    {
        kind: 'named function first parameter',
        pattern: new RegExp(String.raw`\bfunction\s+\w+\s*\(\s*(${NAME_GROUP})\s*[:,)]`, 'g'),
    },
    {
        kind: 'single-argument arrow lambda',
        // `(name) => ...` or `(name: type) => ...`. The `\)\s*=>` tail
        // anchors it to an arrow lambda — never matches a function call.
        pattern: new RegExp(
            String.raw`\(\s*(${NAME_GROUP})\s*(?::\s*[^,)]+)?\s*\)\s*=>`,
            'g',
        ),
    },
];

function find_abbreviated_declarations(
    code_only_source: string,
): { kind: string; name: string; line: number }[] {
    const found: { kind: string; name: string; line: number }[] = [];
    for (const { kind, pattern } of DECLARATION_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null = pattern.exec(code_only_source);
        while (match !== null) {
            found.push({
                kind,
                name: match[1],
                line: line_number_at(code_only_source, match.index),
            });
            match = pattern.exec(code_only_source);
        }
    }

    return found;
}

/**
 * Ratchet — declaration sites that exist today with abbreviated names.
 * Each entry is `<relative-file>::<abbreviated-name>`; multiple violations
 * of the same name in the same file collapse into one entry (deliberately —
 * line numbers drift with edits and would make this set flaky).
 *
 * Drive this set to empty over time. Rename a declaration → remove its
 * entry in the same PR. Adding a new entry here requires explicit
 * "ratchet exception" review.
 */
const KNOWN_ABBREVIATED_DECLARATIONS = new Set<string>([]);

function violation_key(relative_file: string, name: string): string {
    return `${relative_file.replaceAll('\\', '/')}::${name}`;
}

describe('abbreviated-identifier discipline (unambiguous abbreviations only)', () => {
    it('no declaration site under src/ or test/ uses dir/arg/cmd/env/idx/err/pkg (or their plurals)', () => {
        const all_files: string[] = [];
        for (const directory of SCAN_DIRECTORIES) {
            collect_typescript_files(directory, all_files);
        }

        const violations: { file: string; line: number; kind: string; name: string }[] = [];
        for (const file_path of all_files) {
            if (file_path === SELF_FILE) {
                continue;
            }
            const contents = fs.readFileSync(file_path, 'utf8');
            const code_only = strip_to_code_only(contents);
            for (const declaration of find_abbreviated_declarations(code_only)) {
                violations.push({
                    file: path.relative(REPOSITORY_ROOT, file_path),
                    line: declaration.line,
                    kind: declaration.kind,
                    name: declaration.name,
                });
            }
        }

        const observed_keys = new Set(violations.map((v) => violation_key(v.file, v.name)));

        const new_violations = violations.filter(
            (v) => !KNOWN_ABBREVIATED_DECLARATIONS.has(violation_key(v.file, v.name)),
        );
        expect(
            new_violations,
            `Abbreviated-name declarations NOT on the ratchet — rename to the full word (or, with review, add to KNOWN_ABBREVIATED_DECLARATIONS):\n${new_violations
                .map((v) => `  ${v.file}:${v.line}  ${v.kind}  -> ${v.name}`)
                .join('\n')}`,
        ).toEqual([]);

        const ratchet_drift = [...KNOWN_ABBREVIATED_DECLARATIONS].filter(
            (key) => !observed_keys.has(key),
        );
        expect(
            ratchet_drift,
            `Entries on KNOWN_ABBREVIATED_DECLARATIONS that no longer appear — the rename landed; remove them from the set so the ratchet shrinks:\n${ratchet_drift
                .map((key) => `  ${key}`)
                .join('\n')}`,
        ).toEqual([]);
    });

    it('positive control: flags an abbreviated binding placed after a string literal', () => {
        // A no-op scanner (e.g. a tokenizer that over-consumes the preceding
        // string to EOF) would return [] here too; this asserts a real hit.
        const source = [
            'const decoy = "a string a broken tokenizer might run past";',
            'const dir = decoy;',
        ].join('\n');
        expect(find_abbreviated_declarations(strip_to_code_only(source)))
            .toEqual([{ kind: 'const/let/var binding', name: 'dir', line: 2 }]);
    });
});
