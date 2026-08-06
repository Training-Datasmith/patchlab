/**
 * Structural lock guaranteeing every CLI handler exported from src/cli.ts
 * is referenced by at least one test file.
 *
 * The CLI handler extraction (commit history: "2 CLI Handler") split the
 * commander `.action(...)` bodies into named, exported `handle_<verb>_command`
 * functions specifically so they could be invoked from tests without running
 * the whole commander pipeline. Adding a new handler without a corresponding
 * test reference makes that exercise easy to forget — the next refactor
 * silently breaks behaviour the user can hit but no test guards.
 *
 * The test is a coarse coverage check, not an exhaustive behavioural one:
 *   - It enforces that the handler's identifier appears somewhere in */
//     `test/**/*.test.ts` as real code (not inside a comment or string).
/*   - An identifier reference can be an import, a direct call, a spy, or
 *     a static type query — any of these proves a test has at least seen
 *     the handler.
 *   - Pure comment mentions or string-literal mentions don't count; the
 *     point is to catch genuine orphans, not to penalise documentation.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    collect_typescript_test_files,
    strip_to_code_only,
} from '../../helpers/typescript_source_tokenizer.js';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI_FILE = path.join(REPOSITORY_ROOT, 'src', 'cli.ts');
const TEST_DIRECTORY = path.join(REPOSITORY_ROOT, 'test');

const HANDLER_DECLARATION = /^export\s+(?:async\s+)?function\s+(handle_\w+_command)\b/gm;

function extract_handler_names(cli_source: string): string[] {
    const names: string[] = [];
    HANDLER_DECLARATION.lastIndex = 0;
    let match: RegExpExecArray | null = HANDLER_DECLARATION.exec(cli_source);
    while (match !== null) {
        names.push(match[1]);
        match = HANDLER_DECLARATION.exec(cli_source);
    }

    return names;
}


function identifier_matches(stripped_source: string, identifier: string): boolean {
    // Substring + boundary check — handler names are unique enough that a
    // pure indexOf is reliable, but we still confirm the boundary to avoid
    // matching a hypothetical `handle_create_command_helper`.
    let start = 0;
    while (start < stripped_source.length) {
        const at = stripped_source.indexOf(identifier, start);
        if (at === -1) {
            return false;
        }

        const before = at > 0 ? stripped_source[at - 1] : '';
        const after = stripped_source[at + identifier.length] ?? '';
        const boundary_before = !/[A-Za-z0-9_$]/.test(before);
        const boundary_after = !/[A-Za-z0-9_$]/.test(after);
        if (boundary_before && boundary_after) {
            return true;
        }

        start = at + identifier.length;
    }

    return false;
}

/**
 * Ratchet — handlers exported during the CLI extraction that lack any test
 * reference. Initially this set held 12 entries (the full extraction minus
 * `handle_apply_command`); it was driven to empty by
 * `test/unit/cli-handler-input-validation.test.ts`, which supplies a
 * minimum-coverage test reference for every handler.
 *
 * Leave this set empty unless a new handler is added without a test and a
 * deliberate "ratchet exception" review accepts it. Adding any entry here
 * requires that review.
 */
const KNOWN_ORPHAN_HANDLERS = new Set<string>([]);

describe('CLI handler test-reference', () => {
    it('every handle_X_command exported from src/cli.ts is referenced by at least one test file (or is on the known-orphan ratchet)', () => {
        const cli_source = fs.readFileSync(CLI_FILE, 'utf8');
        const handler_names = extract_handler_names(cli_source);
        expect(
            handler_names.length,
            'extract_handler_names returned no handlers — regex broken?',
        ).toBeGreaterThan(0);

        const test_files: string[] = [];
        collect_typescript_test_files(TEST_DIRECTORY, test_files);

        const stripped_per_file = test_files.map((file_path) => ({
            file: file_path,
            stripped: strip_to_code_only(fs.readFileSync(file_path, 'utf8')),
        }));

        const handler_is_referenced = new Map<string, boolean>();
        for (const handler of handler_names) {
            const referenced = stripped_per_file.some(({ stripped }) =>
                identifier_matches(stripped, handler),
            );
            handler_is_referenced.set(handler, referenced);
        }

        const new_orphans = handler_names.filter(
            (handler) =>
                !handler_is_referenced.get(handler) && !KNOWN_ORPHAN_HANDLERS.has(handler),
        );
        expect(
            new_orphans,
            `Handlers exported from src/cli.ts that no test file references and that are NOT on the known-orphan ratchet — add a test or (with review) extend KNOWN_ORPHAN_HANDLERS:\n${new_orphans
                .map((name) => `  ${name}`)
                .join('\n')}`,
        ).toEqual([]);

        const ratchet_drift = [...KNOWN_ORPHAN_HANDLERS].filter(
            (handler) =>
                handler_is_referenced.get(handler) === true
                || !handler_names.includes(handler),
        );
        expect(
            ratchet_drift,
            `Entries on KNOWN_ORPHAN_HANDLERS that now have a test reference (or no longer exist) — remove them from the set so the ratchet shrinks:\n${ratchet_drift
                .map((name) => `  ${name}`)
                .join('\n')}`,
        ).toEqual([]);
    });
});