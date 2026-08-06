/**
 * Structural lock: `node:readline` is imported in exactly one place in
 * `src/` — `src/cli_prompter.ts`. Everything else uses the `Prompter`
 * interface (defined in `src/prompts.ts`) and a callback parameter; the
 * library cannot reach a real terminal without a caller-supplied
 * implementation. This is what makes a future VS Code / GUI / AI-skill
 * consumer of the library possible: there is one prompter implementation
 * to swap, not a tangle of `confirm()` calls.
 *
 * A regression that adds `import * as readline from 'node:readline'`
 * (or any equivalent form) to ANY other src module fails this test.
 * The right response is almost always to thread a `Prompter` into the
 * caller instead — see `documents/...` or the design notes in
 * `openspec/changes/archive/isolate-cli-prompter/` once that change
 * archives.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '..', '..', '..', 'src');
const ALLOWED_FILE = path.join(SRC_ROOT, 'cli_prompter.ts');

function collect_source_files(directory: string, accumulator: string[]): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entry_path = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            collect_source_files(entry_path, accumulator);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            accumulator.push(entry_path);
        }
    }
}

// Matches `import ... from 'node:readline'` or `from 'node:readline/promises'`
// or `require('node:readline')` — covers the practical variants. We DON'T
// match the bare string `'node:readline'` because docs/comments may
// legitimately reference it.
const READLINE_IMPORT = /(?:^|\n)\s*import[^;]*from\s*['"]node:readline(?:\/[^'"]+)?['"]/;
const READLINE_REQUIRE = /require\s*\(\s*['"]node:readline(?:\/[^'"]+)?['"]\s*\)/;

describe('readline-import invariant', () => {
    it('node:readline is imported in exactly one src/ module, and that module is cli_prompter.ts', () => {
        const source_files: string[] = [];
        collect_source_files(SRC_ROOT, source_files);

        const offenders: string[] = [];
        let allowed_file_imports_readline = false;

        for (const absolute of source_files) {
            const contents = fs.readFileSync(absolute, 'utf-8');
            const has_import = READLINE_IMPORT.test(contents) || READLINE_REQUIRE.test(contents);
            if (!has_import) {
                continue;
            }
            if (absolute === ALLOWED_FILE) {
                allowed_file_imports_readline = true;
            } else {
                offenders.push(path.relative(SRC_ROOT, absolute).split(path.sep).join('/'));
            }
        }

        expect(
            offenders,
            `Modules other than src/cli_prompter.ts import node:readline:\n${offenders
                .map((p) => `  src/${p}`)
                .join('\n')}\n\nThread a Prompter into the caller instead.`,
        ).toEqual([]);

        expect(
            allowed_file_imports_readline,
            'src/cli_prompter.ts must remain the project\'s readline owner — '
            + 'its absence means the Readline_Prompter has been removed or '
            + 'split out, which would break the spec invariant.',
        ).toBe(true);
    });
});
