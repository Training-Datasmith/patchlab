import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Unit-suite slice of the `--verbose` flag acceptance tests. Originally lived
 * in `test/integration/cli-verbose-flag.test.ts` but two tests don't reach
 * the `preAction → ensure_podman()` gate at
 * [src/cli.ts:423](../../src/cli.ts#L423) and don't need the integration
 * suite's serialized podman runtime:
 *
 *   - `cli.js exists in dist/` is a pure `fs.existsSync` probe.
 *   - `--help lists --verbose` short-circuits in Commander before `preAction`
 *     fires.
 *
 * The remaining tests in `test/integration/cli-verbose-flag.test.ts`
 * (including `--verbose --strict-trust list`, which DOES hit
 * `ensure_podman()`) stay there.
 *
 * Build dependency: assumes `npm run build` has produced `dist/cli.js`.
 */

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI_PATH = path.join(REPOSITORY_ROOT, 'dist', 'cli.js');

interface Spawn_Result {
    stdout: string;
    stderr: string;
    exit_code: number | null;
}

function run_cli(
    home_directory: string,
    command_arguments: string[],
    extra_environment: Record<string, string> = {},
): Spawn_Result {
    const result = spawnSync(process.execPath, [CLI_PATH, ...command_arguments], {
        env: {
            ...process.env,
            HOME: home_directory,
            USERPROFILE: home_directory,
            PATCHLAB_ALLOW_UNTRUSTED_MANIFESTS: '0',
            ...extra_environment,
        },
        encoding: 'utf-8',
        timeout: 60_000,
    });

    return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exit_code: result.status,
    };
}

describe('CLI --verbose flag — pre-gate tests', () => {
    let home_directory: string;

    beforeEach(() => {
        home_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-verbose-flag-unit-'));
    });

    afterEach(() => {
        fs.rmSync(home_directory, { recursive: true, force: true });
    });

    it('cli.js exists in dist/ (the test suite assumes a current build)', () => {
        expect(fs.existsSync(CLI_PATH)).toBe(true);
    });

    it('--help lists --verbose as a program-level option', () => {
        // Task 2.1: registered at program level so `--help` enumerates it.
        // This is also the surface that future users discover the flag from.
        // Commander short-circuits `--help` before `preAction` fires, so this
        // test does not need a working podman runtime.
        const result = run_cli(home_directory, ['--help']);

        expect(result.exit_code).toBe(0);
        expect(result.stdout).toContain('--verbose');
        // Description from src/cli.ts; locks the wording so a casual rename
        // would break this test and force a deliberate update.
        expect(result.stdout).toContain('enable verbose diagnostic output');
        // No parse error on stderr
        expect(result.stderr).not.toMatch(/error:/i);
    });
});
