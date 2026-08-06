import { describe, it, expect } from 'vitest';
import { inspect_sandbox, destroy_sandbox } from '../../../src/sandbox/index.js';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';

/**
 * Host-side manifest-lookup paths for the sandbox lifecycle. Tests in this
 * file exercise the BRANCHES of `inspect_sandbox` / `destroy_sandbox` that
 * never reach podman:
 *
 *   - `inspect_sandbox` throws BEFORE any podman call when the archive
 *     directory doesn't exist (the `Sandbox not found:` branch in
 *     [src/sandbox/inspect.ts](../../src/sandbox/inspect.ts)).
 *   - `destroy_sandbox` is idempotent on a missing archive: it catches every
 *     podman / branch-cleanup failure and returns cleanly. The `force: true`
 *     option suppresses interactive prompts (relevant for the worktree-clean
 *     check that can otherwise gate destroy).
 *
 * Originally lived in `test/integration/sandbox.test.ts`. Moved here per
 * [documents/testing-strategy.md](../../documents/testing-strategy.md)
 * "Choosing a project for a new test" — host-side validation and
 * archive-lookup are unit territory; only the positive sandbox-lifecycle
 * paths (create-then-inspect, create-then-destroy where the container DOES
 * exist) stay in integration.
 *
 * HOME isolation: each test redirects HOME (POSIX) and USERPROFILE (Windows)
 * to a tempdir so we never read or modify the developer's real
 * `~/.patchlab/` archive.
 */

describe('sandbox lifecycle — host-side manifest-lookup paths', () => {
    install_isolated_home_hooks('patchlab-sandbox-unit-');

    it('throws when inspecting a non-existent sandbox', () => {
        // `inspect_sandbox` throws `Sandbox not found: <id>` BEFORE any
        // podman call — the `fs.existsSync` check at the top of the function
        // is host-side. A regression that re-ordered the existence check
        // after the podman calls would force podman to be installed even for
        // the negative-lookup path.
        expect(() => inspect_sandbox('nonexistent')).toThrow(/not found/i);
    });

    it('destroy is idempotent on a non-existent sandbox id', async () => {
        // `destroy_sandbox` catches every podman / branch-cleanup failure
        // and returns cleanly so partial destruction (or destruction-of-
        // already-destroyed) is safe to retry. The `force: true` option
        // suppresses the worktree-clean interactive prompt that would
        // otherwise gate destroy.
        await expect(destroy_sandbox('nonexistent-id', { force: true })).resolves.not.toThrow();
    });
});
