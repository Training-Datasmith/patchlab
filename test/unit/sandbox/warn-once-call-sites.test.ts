/**
 * Regression test: both `create_sandbox` and `resume_sandbox` SHALL invoke
 * `warn_once_if_unsupported()` so users on hosts without delegated cgroup
 * controllers see the warning regardless of which command they ran first.
 *
 * A behavior-level test that proves resume calls the helper requires fully
 * standing up a patchlab archive (sandbox directory + manifest + git branch
 * + podman) just to reach the call site — too heavy for the coverage value.
 * Instead we do a source-text regression: if a future refactor accidentally
 * removes the call from either function body, this test fails and points at
 * the responsible line.
 *
 * The migration-invariant test (injectable-logger) uses the same source-scan
 * pattern for its no-direct-console.* invariant.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PROVISIONING_SOURCE_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'sandbox', 'provisioning.ts');

/**
 * Crude function-body extraction. Locates the `export async function <name>(`
 * line, then walks until brace depth returns to zero. Good enough for a
 * static check; produces a string we can grep within.
 */
function extract_function_body(source: string, function_name: string): string {
    const declaration = `export async function ${function_name}(`;
    const start = source.indexOf(declaration);
    if (start === -1) {
        throw new Error(`Could not find declaration for ${function_name}`);
    }

    // Find the opening `{` after the parameter list.
    const open_brace = source.indexOf('{', start);
    if (open_brace === -1) {
        throw new Error(`Could not find opening brace for ${function_name}`);
    }

    let depth = 1;
    let cursor = open_brace + 1;
    while (cursor < source.length && depth > 0) {
        const character = source[cursor];
        if (character === '{') {
            depth++;
        } else if (character === '}') {
            depth--;
        }
        cursor++;
    }

    return source.slice(open_brace, cursor);
}

describe('provisioning.ts — warn_once_if_unsupported call sites', () => {
    const source = fs.readFileSync(PROVISIONING_SOURCE_PATH, 'utf-8');

    it('create_sandbox calls warn_once_if_unsupported', () => {
        const body = extract_function_body(source, 'create_sandbox');
        expect(body).toContain('warn_once_if_unsupported()');
    });

    it('resume_sandbox calls warn_once_if_unsupported', () => {
        // Locks the second call site. The warn-once latch (set by create) can
        // mask a missing resume-side call when create and resume share a
        // process — but on a fresh process starting at resume, an absent call
        // would silently skip the warning. This assertion guarantees the call
        // exists regardless of process history.
        const body = extract_function_body(source, 'resume_sandbox');
        expect(body).toContain('warn_once_if_unsupported()');
    });

    it('warn_once_if_unsupported is imported from src/cgroups.js', () => {
        // Locks the import too: a future refactor that drops the import but
        // leaves the call site would fail at module load, not at this test —
        // but a removed import + removed call would silently pass the body
        // check above. Asserting the import directly closes that loophole.
        expect(source).toMatch(/import\s*\{[^}]*\bwarn_once_if_unsupported\b[^}]*\}\s*from\s*['"]\.\.\/cgroups\.js['"]/);
    });
});
