import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Detected_Requirements } from '../../src/detect/index.js';
import { make_fake_prompter, Prompter_Exhausted } from '../helpers/fake_prompter.js';

// Task 6.2: Unit tests for interactive opt-in prompt logic

describe('socket mount resolution logic', () => {
    let temporary_directory: string;

    beforeEach(() => {
        temporary_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-prompts-'));
    });

    afterEach(() => {
        fs.rmSync(temporary_directory, { recursive: true, force: true });
    });

    function write_config(content: object): void {
        fs.writeFileSync(path.join(temporary_directory, '.patchlab.json'), JSON.stringify(content));
    }

    const requirements_with_socket: Detected_Requirements = {
        system_packages: [],
        volume_mounts: [
            { type: 'volume_mount', host_path: '/run/podman/podman.sock', container_path: '/run/podman/podman.sock', source: 'source_code' },
        ],
        environment_variables: [],
        services: [],
        npm_packages: [],
    };

    const requirements_without_socket: Detected_Requirements = {
        system_packages: [],
        volume_mounts: [],
        environment_variables: [],
        services: [],
        npm_packages: [],
    };

    // We test the logic paths that don't require interactive input

    it('returns not approved when no socket mounts detected', async () => {
        // resolve_socket_mount should return { approved: false } when no mounts
        const { resolve_socket_mount } = await import('../../src/prompts.js');
        const result = await resolve_socket_mount(temporary_directory, requirements_without_socket, {}, null);
        expect(result.approved).toBe(false);
    });

    it('returns approved when CLI flag --allow-socket-mount', async () => {
        const { resolve_socket_mount } = await import('../../src/prompts.js');
        const result = await resolve_socket_mount(temporary_directory, requirements_with_socket, { allow_socket_mount: true }, null);
        expect(result.approved).toBe(true);
    });

    it('returns not approved when CLI flag --deny-socket-mount', async () => {
        const { resolve_socket_mount } = await import('../../src/prompts.js');
        const result = await resolve_socket_mount(temporary_directory, requirements_with_socket, { deny_socket_mount: true }, null);
        expect(result.approved).toBe(false);
    });

    it('returns approved when .patchlab.json has allow_socket_mount: true', async () => {
        write_config({ allow_socket_mount: true });
        const { resolve_socket_mount } = await import('../../src/prompts.js');
        const result = await resolve_socket_mount(temporary_directory, requirements_with_socket, {}, null);
        expect(result.approved).toBe(true);
    });

    it('returns not approved when .patchlab.json has allow_socket_mount: false', async () => {
        write_config({ allow_socket_mount: false });
        const { resolve_socket_mount } = await import('../../src/prompts.js');
        const result = await resolve_socket_mount(temporary_directory, requirements_with_socket, {}, null);
        expect(result.approved).toBe(false);
    });

    it('CLI deny flag takes precedence over .patchlab.json allow', async () => {
        write_config({ allow_socket_mount: true });
        const { resolve_socket_mount } = await import('../../src/prompts.js');
        const result = await resolve_socket_mount(temporary_directory, requirements_with_socket, { deny_socket_mount: true }, null);
        expect(result.approved).toBe(false);
    });
});

// Prompter-driven tests for the interactive branch. These were previously
// unreachable because `confirm`'s readline path needs TTY mocking;
// `Fake_Prompter` replaces the whole prompter, so the policy function's
// own branches become directly exercisable.
describe('resolve_socket_mount — interactive branch via Fake_Prompter', () => {
    let temporary_directory: string;

    beforeEach(() => {
        temporary_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-prompts-fake-'));
    });

    afterEach(() => {
        fs.rmSync(temporary_directory, { recursive: true, force: true });
    });

    const requirements_with_socket: Detected_Requirements = {
        system_packages: [],
        volume_mounts: [
            { type: 'volume_mount', host_path: '/run/podman/podman.sock', container_path: '/run/podman/podman.sock', source: 'source_code' },
        ],
        environment_variables: [],
        services: [],
        npm_packages: [],
    };

    it('approves AND persists `allow_socket_mount: true` to .patchlab.json when user accepts both prompts', async () => {
        // Two confirms: (1) "Allow the socket mount?", (2) "Save to
        // .patchlab.json?". Both true → approved + persistence.
        const prompter = make_fake_prompter({ confirm: [true, true] });
        const { resolve_socket_mount } = await import('../../src/prompts.js');

        const result = await resolve_socket_mount(temporary_directory, requirements_with_socket, {}, prompter);

        expect(result.approved).toBe(true);
        const persisted = JSON.parse(fs.readFileSync(path.join(temporary_directory, '.patchlab.json'), 'utf-8'));
        expect(persisted).toEqual({ allow_socket_mount: true });
    });

    it('approves but SKIPS persistence when user accepts the mount and declines the save offer', async () => {
        // Approve mount, decline save — the function still returns approved,
        // but .patchlab.json is not written. A regression that conflated the
        // two confirms would surface as either a missed save (false-then-true
        // queued) or an unexpected write (true-then-false).
        const prompter = make_fake_prompter({ confirm: [true, false] });
        const { resolve_socket_mount } = await import('../../src/prompts.js');

        const result = await resolve_socket_mount(temporary_directory, requirements_with_socket, {}, prompter);

        expect(result.approved).toBe(true);
        expect(fs.existsSync(path.join(temporary_directory, '.patchlab.json'))).toBe(false);
    });

    it('returns not approved AND does NOT prompt for save when user declines the mount', async () => {
        // Decline → function returns early; the save-offer confirm is never
        // consumed. We queue only ONE answer: if a regression added a second
        // confirm call, `Fake_Prompter` would throw `Prompter_Exhausted` and
        // this test would fail with that signal instead of a silent pass.
        const prompter = make_fake_prompter({ confirm: [false] });
        const { resolve_socket_mount } = await import('../../src/prompts.js');

        const result = await resolve_socket_mount(temporary_directory, requirements_with_socket, {}, prompter);

        expect(result.approved).toBe(false);
        expect(fs.existsSync(path.join(temporary_directory, '.patchlab.json'))).toBe(false);
    });

    it('propagates `Prompter_Exhausted` when the queue runs dry mid-policy', async () => {
        // Approve mount → policy calls `confirm` a second time for save.
        // Queue has only one answer → second call throws and the policy
        // function does NOT catch. The throw IS the test signal that the
        // expected prompt count changed.
        const prompter = make_fake_prompter({ confirm: [true] });
        const { resolve_socket_mount } = await import('../../src/prompts.js');

        await expect(
            resolve_socket_mount(temporary_directory, requirements_with_socket, {}, prompter),
        ).rejects.toBeInstanceOf(Prompter_Exhausted);
    });
});

// The former `confirm()` non-TTY-default-semantics test moved to
// test/unit/cli-prompter.test.ts (the `Readline_Prompter` non-TTY
// behavior) and is enforced at the factory level by
// `resolve_runtime_prompter()` returning `null` when stdin is not a TTY.
