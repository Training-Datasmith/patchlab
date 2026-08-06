// `validate_user_global_or_abort` at src/tools/index.ts:184. The strict
// re-validation entry point operational commands call before doing any
// container work. Reads `module_load_result`, a frozen-at-module-load
// snapshot of errors from `register_user_global_providers({ mode:
// 'collect-and-skip' })`. Because the snapshot is taken at IMPORT time, each
// test must reset the module cache and apply its own `vi.doMock` BEFORE
// dynamically importing `tools/index.js` — `vi.mock` (hoisted, file-scoped)
// would freeze the snapshot at the wrong time.
//
// Separate from `test/unit/register-user-global.test.ts` because that file
// covers the registration function itself (which can be invoked directly
// per-test) — this file covers the snapshot-then-validate contract, which
// requires per-test module-load isolation.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RecordingLogger } from '../helpers/recording_logger.js';

beforeEach(() => {
    // Drop any previously-loaded `tools/index.js` (and its transitively-loaded
    // graph) so the next dynamic `import` re-runs module-load with the mocks
    // about to be installed via `vi.doMock` in each test. The logger module
    // gets reset too — so each test that wants a recording logger must
    // dynamic-import `../../src/logger.js` AFTER this reset and call
    // `set_logger` on the FRESH module instance, otherwise the recording
    // logger ends up installed on a stale logger module that no other code
    // can see.
    vi.resetModules();
});

describe('validate_user_global_or_abort', () => {
    it('returns silently when module load discovered no manifests', async () => {
        vi.doMock('../../src/tools/configured_provider/index.js', async () => {
            const original = await vi.importActual<typeof import('../../src/tools/configured_provider/index.js')>(
                '../../src/tools/configured_provider/index.js',
            );
            return {
                ...original,
                discover_user_global_manifest_paths: () => [],
            };
        });

        const { validate_user_global_or_abort } = await import('../../src/tools/index.js');
        expect(() => validate_user_global_or_abort()).not.toThrow();
    });

    it('throws with the manifest_path of the first error when module load collected a parse error', async () => {
        // The collect-and-skip pass at module load records parse failures into
        // `module_load_result.errors`. Re-validation reads the FIRST error
        // (not all of them) and throws a self-describing message naming the
        // bad manifest's path. Without this throw, an operational command
        // would proceed into a degraded state where the broken manifest is
        // silently skipped instead of halting the operation.
        vi.doMock('../../src/tools/configured_provider/index.js', async () => {
            const original = await vi.importActual<typeof import('../../src/tools/configured_provider/index.js')>(
                '../../src/tools/configured_provider/index.js',
            );
            return {
                ...original,
                discover_user_global_manifest_paths: () => ['/fake/broken.yaml'],
                read_and_parse_manifest: () => ({
                    manifest_path: '/fake/broken.yaml',
                    field_path: 'name',
                    reason: 'name is required',
                }),
            };
        });

        const { validate_user_global_or_abort } = await import('../../src/tools/index.js');
        expect(() => validate_user_global_or_abort()).toThrow(
            /Aborting: invalid user-global manifest at \/fake\/broken\.yaml/,
        );
    });

    it('logs a format_warning record on the error channel before throwing', async () => {
        // The function logs BEFORE throwing so operators see the structured
        // warning even if their shell suppresses thrown stack traces. We
        // assert the error channel carries the manifest_path AND the
        // rejection reason so a future refactor that drops the log (or moves
        // it to info/warn) surfaces here.
        vi.doMock('../../src/tools/configured_provider/index.js', async () => {
            const original = await vi.importActual<typeof import('../../src/tools/configured_provider/index.js')>(
                '../../src/tools/configured_provider/index.js',
            );
            return {
                ...original,
                discover_user_global_manifest_paths: () => ['/fake/broken.yaml'],
                read_and_parse_manifest: () => ({
                    manifest_path: '/fake/broken.yaml',
                    field_path: 'name',
                    reason: 'name is required',
                }),
            };
        });

        // The logger module must be re-imported AFTER `vi.resetModules()` so
        // the recording logger lands on the same fresh logger instance that
        // `tools/index.js` will pull in via its own re-import.
        const recording = new RecordingLogger();
        const logger_module = await import('../../src/logger.js');
        logger_module.set_logger(recording);

        const { validate_user_global_or_abort } = await import('../../src/tools/index.js');
        expect(() => validate_user_global_or_abort()).toThrow();

        const error_messages = recording.calls
            .filter((call) => call.method === 'error')
            .map((call) => (call.message instanceof Error ? call.message.message : call.message));
        const joined = error_messages.join('\n');
        expect(joined).toContain('/fake/broken.yaml');
        expect(joined).toContain('name is required');
    });

    it('uses errors[0] only when multiple manifests failed (the rest are silently dropped from the throw message)', async () => {
        // Documented contract: the message names the FIRST bad manifest. The
        // rest were already logged at module-load time via the
        // collect-and-skip path. A future change that paged the user through
        // every error would surface here as an unexpected match against the
        // second manifest_path.
        vi.doMock('../../src/tools/configured_provider/index.js', async () => {
            const original = await vi.importActual<typeof import('../../src/tools/configured_provider/index.js')>(
                '../../src/tools/configured_provider/index.js',
            );
            return {
                ...original,
                discover_user_global_manifest_paths: () => ['/fake/first.yaml', '/fake/second.yaml'],
                read_and_parse_manifest: (manifest_path: string) => ({
                    manifest_path,
                    field_path: 'name',
                    reason: 'name is required',
                }),
            };
        });

        const { validate_user_global_or_abort } = await import('../../src/tools/index.js');
        try {
            validate_user_global_or_abort();
            expect.unreachable('expected validate_user_global_or_abort() to throw');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            expect(message).toContain('/fake/first.yaml');
            expect(message).not.toContain('/fake/second.yaml');
        }
    });
});
