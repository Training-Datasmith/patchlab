/**
 * Per-handler minimum-coverage tests for every `handle_X_command` exported
 * from src/cli.ts. Pairs with cli-handler-test-reference-invariant — that
 * scanner enforces the structural rule "every handler must be referenced
 * by some test"; this file supplies the references.
 *
 * Two patterns appear here:
 *
 *   - Defense-in-depth input validation for handlers that gate on a
 *     patchlab id at the top of the body: pass a syntactically invalid id
 *     and assert the handler rejects before any downstream work could fire.
 *     The point is not to re-test `assert_valid_patchlab_id` (which has its
 *     own tests) but to lock the contract that the validator runs FIRST in
 *     each handler — a regression that moved the validator below a destructive
 *     call would fail this test even though the validator's unit tests stay
 *     green.
 *
 *   - Minimal id-less behavior for the handlers that take no patchlab id
 *     (`list`, `gc`, `list-tools`, `images`, `build-image`, `create`). Each
 *     exercises one observable early branch: an empty-archive no-op, the
 *     mount-count gate at the top of `create`, or a mocked-out leaf call.
 *
 * These tests are intentionally narrow. Behavioral coverage of the
 * downstream subsystems (sandbox lifecycle, branch operations, image
 * registry) lives in their own test files; this file is the surface-area
 * latch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';
import { DEFAULT_TEST_TOOL, register_default_test_tool } from '../../helpers/stub_tool_provider.js';

vi.mock('../../../src/images.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/images.js')>();
    return {
        ...actual,
        list_images: vi.fn(() => []),
        build_image: vi.fn(async () => 'patchlab/mock-test-image:latest'),
    };
});

import {
    handle_create_command,
    handle_destroy_command,
    handle_resume_command,
    handle_build_image_command,
    handle_gc_command,
    handle_list_command,
    handle_inspect_command,
    handle_diff_command,
    handle_patch_command,
    handle_exec_command,
    handle_list_tools_command,
    handle_images_command,
} from '../../../src/cli.js';

const INVALID_PATCHLAB_ID = 'not a uuid';

describe('CLI handlers — input-validation defense-in-depth', () => {
    install_isolated_home_hooks('patchlab-handler-validation-');

    beforeEach(() => {
        register_default_test_tool();
    });

    it('handle_inspect_command rejects an invalid patchlab id', () => {
        expect(() => handle_inspect_command(INVALID_PATCHLAB_ID))
            .toThrow(/Invalid patchlab id/);
    });

    it('handle_diff_command rejects an invalid patchlab id', () => {
        expect(() => handle_diff_command(INVALID_PATCHLAB_ID))
            .toThrow(/Invalid patchlab id/);
    });

    it('handle_patch_command rejects an invalid patchlab id', () => {
        expect(() => handle_patch_command(INVALID_PATCHLAB_ID, {}))
            .toThrow(/Invalid patchlab id/);
    });

    it('handle_exec_command rejects an invalid patchlab id', () => {
        expect(() => handle_exec_command(INVALID_PATCHLAB_ID, ['ls']))
            .toThrow(/Invalid patchlab id/);
    });

    it('handle_destroy_command rejects an invalid patchlab id', async () => {
        await expect(handle_destroy_command(INVALID_PATCHLAB_ID, { force: true }))
            .rejects.toThrow(/Invalid patchlab id/);
    });

    it('handle_resume_command rejects an invalid patchlab id', async () => {
        await expect(handle_resume_command(INVALID_PATCHLAB_ID, {}))
            .rejects.toThrow(/Invalid patchlab id/);
    });

    it('handle_create_command rejects more --mount flags than sources', async () => {
        // `validate_mount_count` is the very first gate inside the handler
        // body — the test locks the property that it runs BEFORE any source
        // resolution, container creation, or trust registration could fire.
        await expect(
            handle_create_command('/tmp/handle-create-validation-only', {
                tool: DEFAULT_TEST_TOOL,
                mount: ['extra-mount-a', 'extra-mount-b'],
            }),
        ).rejects.toThrow(/--mount supplied 2 times but only 1/);
    });
});

describe('CLI handlers — id-less behavior in isolated HOME', () => {
    install_isolated_home_hooks('patchlab-handler-behavior-');

    beforeEach(() => {
        register_default_test_tool();
    });

    it('handle_list_command returns without throwing when no sandboxes exist', () => {
        // Isolated HOME has no ~/.patchlab/ directory; `list_sandboxes`
        // short-circuits to [] without any podman call. Handler logs
        // "No active sandboxes." and returns.
        expect(() => handle_list_command()).not.toThrow();
    });

    it('handle_gc_command(dry_run) returns without throwing when no sandboxes exist', async () => {
        // Preview-only path: garbage_collect_sandboxes returns
        // { destroyed: [] }; handler logs "Nothing to clean up." and
        // returns before the second (real) gc invocation.
        await expect(handle_gc_command({ dry_run: true })).resolves.toBeUndefined();
    });

    it('handle_list_tools_command(undefined) iterates registered providers without throwing', () => {
        // With no source argument, the handler dispatches to `run_list_tools()`
        // which iterates `list_registrations()` (built-in providers + any
        // user-global manifests under the isolated HOME — none here). No
        // per-source registration is attempted, so no filesystem walk runs.
        expect(() => handle_list_tools_command(undefined)).not.toThrow();
    });

    it('handle_images_command logs the (mocked-empty) image list without throwing', () => {
        // `list_images` is mocked at module scope to return []. Handler
        // takes the "No patchlab-compatible images found." branch and
        // suggests `patchlab build-image`.
        expect(() => handle_images_command()).not.toThrow();
    });

    it('handle_build_image_command routes through the mocked build_image and completes', async () => {
        // `--base` is supplied, so the handler skips `detect_project` (which
        // would otherwise shell out for project detection). The
        // requirements-detection + override-merge layers run against the
        // current cwd — host-only filesystem reads, no podman. Finally
        // `build_image` resolves to the mocked tag, the handler logs the
        // result, and returns.
        await expect(handle_build_image_command({ base: 'node:22-slim', tools: [DEFAULT_TEST_TOOL] }))
            .resolves.toBeUndefined();
    });
});
