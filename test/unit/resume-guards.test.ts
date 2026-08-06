import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';

import { ConsoleLogger, set_logger } from '../../src/logger.js';
import { RecordingLogger } from '../helpers/recording_logger.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { initialize_repository_with_initial_commit } from '../helpers/git_repository.js';
import { resume_sandbox, check_required_for_resume } from '../../src/sandbox/index.js';
import { create_patchlab_branch } from '../../src/branch/index.js';
import {
    ARCHIVE_ARTIFACTS_DIRECTORY,
    build_archive_path,
    build_session_path,
    write_session_metadata,
    type Session_Metadata,
} from '../../src/archive.js';
import type { Extractable_Artifact } from '../../src/extractable_artifact.js';
import { create_manifest, write_manifest } from '../../src/manifest.js';
import type { Authentication_Method, Tool_Provider } from '../../src/tools/types.js';
import * as tools_index from '../../src/tools/index.js';

import { install_isolated_home_hooks } from '../helpers/home_directory.js';

function build_fake_provider(
    artifacts: Extractable_Artifact[],
    overrides: Partial<Tool_Provider> = {}
): Tool_Provider {
    return {
        name: 'fake-provider',
        display_name: 'Fake Provider',
        image_specification: {
            base_image: 'node:22-slim',
            image_user: 'patchlab',
            image_home: '/home/patchlab',
            configuration_directory_name: '.fake',
            async prepare_build_assets() { return new Map(); },
            get_dockerfile_lines() { return []; },
            get_dockerfile_environment() { return {}; },
            get_base_preparation_lines() { return { lines: [] }; },
        },
        inject_authentication() { return { type: 'none' }; },
        get_launch_command() { return ['fake']; },
        validate_image() { return { valid: true, reasons: [] }; },
        get_cached_version() { return null; },
        get_openspec_tool_name() { return 'fake'; },
        get_authentication_method(): Authentication_Method { return 'none'; },
        get_extractable_artifacts: () => artifacts,
        async inject_session_state() { /* no-op */ },
        ...overrides,
    };
}

function make_artifact(
    archive_subpath: string,
    type: 'file' | 'directory' = 'directory',
    required_for_resume: boolean = true,
    name?: string
): Extractable_Artifact {
    return {
        name: name ?? archive_subpath,
        container_path: `/tmp/${archive_subpath}`,
        type,
        archive_subpath,
        required_for_resume,
    };
}

describe('required_for_resume check (6.8 — full resume_sandbox path)', () => {
    install_isolated_home_hooks('patchlab-required-home-');
    let repository: string;
    const patchlab_id = 'pl-required';

    // The repo + branch are host-side and persist across tests; the manifest
    // is HOME-scoped and must be re-written per test because
    // `install_isolated_home_hooks` swaps HOME between tests.
    beforeAll(() => {
        repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-required-repo-')));
        initialize_repository_with_initial_commit(repository);
        create_patchlab_branch(repository, patchlab_id);
    });

    afterAll(() => {
        fs.rmSync(repository, { recursive: true, force: true });
    });

    beforeEach(() => {
        vi.spyOn(tools_index, 'get_provider').mockReturnValue(
            build_fake_provider([make_artifact('conversation', 'directory', true, 'conversation')]),
        );

        const archive_directory = build_archive_path(patchlab_id);
        fs.mkdirSync(archive_directory, { recursive: true });
        const manifest = create_manifest(
            patchlab_id,
            [{ host_path: repository, repository_root: repository, source_prefix: '', mount_name: '' }],
            'patchlab-test',
            'patchlab/test:latest',
        );
        manifest.tool = 'gemini-cli-oauth';
        write_manifest(archive_directory, manifest);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    function seed_session(
        session_number: number,
        options: { status: 'completed' | 'interrupted'; create_fence: boolean }
    ): void {
        const metadata: Session_Metadata = {
            session_number,
            created_at: '2026-04-29T00:00:00.000Z',
            completed_at: options.status === 'completed' ? '2026-04-29T01:00:00.000Z' : null,
            status: options.status,
            tool: 'gemini-cli-oauth',
            container_name: 'patchlab-test',
            commit_shas: { [repository]: null },
            fallback_patches: { [repository]: null },
            resource_limits: null,
        };
        write_session_metadata(patchlab_id, session_number, metadata);
        if (options.create_fence) {
            const fence_directory = build_session_path(patchlab_id, session_number, ARCHIVE_ARTIFACTS_DIRECTORY);
            fs.mkdirSync(fence_directory, { recursive: true });
            // Note: NOT creating the per-artifact `conversation/` subdirectory under the fence —
            // simulates the "tool was used but the required artifact is missing" case.
        }
    }

    it('fails fast when prior session reports completed but the required artifact is missing', async () => {
        seed_session(1, { status: 'completed', create_fence: true });
        // Add a sibling populated artifact so the sentinel pass fires; this exposes
        // the required-presence pass missing the declared `conversation` artifact.
        const fence_directory = build_session_path(patchlab_id, 1, ARCHIVE_ARTIFACTS_DIRECTORY);
        fs.mkdirSync(path.join(fence_directory, 'sibling'), { recursive: true });

        // Use a fake provider with a populated optional sibling so the sentinel fires
        // but the required artifact is still missing.
        const fake_provider = build_fake_provider([
            make_artifact('sibling', 'directory', false, 'optional-sentinel'),
            make_artifact('conversation', 'directory', true, 'conversation'),
        ]);
        expect(() => check_required_for_resume(patchlab_id, 1, fake_provider))
            .toThrow(/required artifact\(s\) missing/);
    });

    it('proceeds past the required check when prior session is interrupted but no artifacts were extracted', async () => {
        seed_session(1, { status: 'interrupted', create_fence: false });

        // No artifacts were extracted, so the interrupted status does not block
        // resume — without any on-disk artifacts there is nothing partial to
        // protect against. resume_sandbox will fail later (no podman in unit
        // tests) but NOT on the status check.
        await expect(resume_sandbox(patchlab_id)).rejects.not.toThrow(/status "interrupted"/);
    });

    it('fails fast when prior session is interrupted and artifacts were extracted', async () => {
        seed_session(1, { status: 'interrupted', create_fence: true });
        // Write the conversation artifact so the sentinel pass fires.
        const fence_directory = build_session_path(patchlab_id, 1, ARCHIVE_ARTIFACTS_DIRECTORY);
        fs.mkdirSync(path.join(fence_directory, 'conversation'), { recursive: true });

        await expect(resume_sandbox(patchlab_id)).rejects.toThrow(/status "interrupted"/);
    });

    it('proceeds past the required check when prior session is completed and the fence is absent', async () => {
        seed_session(1, { status: 'completed', create_fence: false });

        // resume_sandbox will fail later (no podman / no container) but not on the required-artifact
        // check. We assert the error is NOT the required-artifact error.
        await expect(resume_sandbox(patchlab_id)).rejects.not.toThrow(/required artifact/);
        await expect(resume_sandbox(patchlab_id)).rejects.not.toThrow(/status "interrupted"/);
    });
});

describe('resume_sandbox — pre-flight throws (early rejections)', () => {
    install_isolated_home_hooks('patchlab-resume-preflight-home-');

    it('throws "Patchlab not found" when the archive directory does not exist', async () => {
        // The `fs.existsSync(sandbox_directory)` check at the top of
        // `resume_sandbox` fires BEFORE any podman call. Symmetric to
        // `inspect_sandbox`'s "Sandbox not found" branch covered at
        // `test/unit/sandbox-lifecycle.test.ts:59`. Without this, a typo on
        // the patchlab id would surface as a cryptic downstream manifest-
        // read error instead of a clear "not found" message.
        await expect(resume_sandbox('nonexistent-id')).rejects.toThrow(/Patchlab not found/);
    });

    it('throws reachability pre-flight error when a spanned repository is no longer a git directory', async () => {
        // Multi-repository pre-flight: when any repository spanned by the
        // patchlab is no longer reachable (deleted, moved, or had its `.git`
        // removed), resume_sandbox throws BEFORE creating any container. The
        // message names the unreachable repository so the operator can
        // restore it or run with `--force` (if added later).
        const patchlab_id = 'pl-reachability';

        // Set up two real git repositories, then create the archive +
        // manifest pointing at both. Delete the SECOND repository's
        // .git directory after the manifest is written to simulate
        // post-create relocation.
        const repository_a = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-reach-a-')),
        );
        const repository_b = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-reach-b-')),
        );
        try {
            for (const repository of [repository_a, repository_b]) {
                initialize_repository_with_initial_commit(repository);
            }

            create_patchlab_branch(repository_a, patchlab_id);
            create_patchlab_branch(repository_b, patchlab_id);

            const archive_directory = build_archive_path(patchlab_id);
            fs.mkdirSync(archive_directory, { recursive: true });
            const manifest = create_manifest(
                patchlab_id,
                [
                    { host_path: repository_a, repository_root: repository_a, source_prefix: '', mount_name: 'a' },
                    { host_path: repository_b, repository_root: repository_b, source_prefix: '', mount_name: 'b' },
                ],
                'patchlab-test',
                'patchlab/test:latest',
            );
            manifest.tool = 'gemini-cli-oauth';
            write_manifest(archive_directory, manifest);

            // Sabotage repository_b post-write: remove its .git directory so
            // `is_git_repository(repository_b)` returns false. The pre-flight
            // aggregates failures across every spanned repository, so the
            // thrown message must name repository_b explicitly.
            fs.rmSync(path.join(repository_b, '.git'), { recursive: true, force: true });

            await expect(resume_sandbox(patchlab_id)).rejects.toThrow(/not a git repository|reachability/i);
        } finally {
            fs.rmSync(repository_a, { recursive: true, force: true });
            fs.rmSync(repository_b, { recursive: true, force: true });
        }
    });
});

describe('check_required_for_resume — direct invocation (6.4)', () => {
    install_isolated_home_hooks('patchlab-direct-home-');
    let recording_logger: RecordingLogger;
    const patchlab_id = 'pl-direct';
    const session_number = 1;

    beforeEach(() => {
        recording_logger = new RecordingLogger();
        set_logger(recording_logger);
    });

    afterEach(() => {
        set_logger(new ConsoleLogger());
    });

    const DIRECT_TEST_REPO = '/host/direct-resume-repo';

    function seed(metadata_overrides: Omit<Partial<Session_Metadata>, 'resource_limits'> = {}): void {
        // `check_required_for_resume` reads the manifest to derive primary_repo
        // for legacy-shape synthesis. Write a minimal manifest so the lookup
        // succeeds without exercising the runtime create flow.
        const archive_directory = build_archive_path(patchlab_id);
        fs.mkdirSync(archive_directory, { recursive: true });
        const manifest = create_manifest(
            patchlab_id,
            [{ host_path: DIRECT_TEST_REPO, repository_root: DIRECT_TEST_REPO, source_prefix: '', mount_name: '' }],
            'unused',
            'unused',
        );
        write_manifest(archive_directory, manifest);

        const metadata: Session_Metadata = {
            session_number,
            created_at: '2026-04-29T00:00:00.000Z',
            completed_at: '2026-04-29T01:00:00.000Z',
            status: 'completed',
            tool: 'gemini-cli-oauth',
            container_name: 'patchlab-test',
            commit_shas: { [DIRECT_TEST_REPO]: null },
            fallback_patches: { [DIRECT_TEST_REPO]: null },
            resource_limits: null,
            ...metadata_overrides,
        };
        write_session_metadata(patchlab_id, session_number, metadata);
    }

    function fence_path(): string {
        return build_session_path(patchlab_id, session_number, ARCHIVE_ARTIFACTS_DIRECTORY);
    }

    function write_artifact_directory(archive_subpath: string): string {
        const directory = path.join(fence_path(), archive_subpath);
        fs.mkdirSync(directory, { recursive: true });
        return directory;
    }

    function write_artifact_file(archive_subpath: string, content: string = ''): string {
        fs.mkdirSync(fence_path(), { recursive: true });
        const filename = path.join(fence_path(), archive_subpath);
        fs.writeFileSync(filename, content);
        return filename;
    }

    it('6.4.1 fake provider with archive_subpath=messages is checked under sessions/{n}/artifacts/messages', () => {
        seed();
        write_artifact_directory('messages');
        const provider = build_fake_provider([
            make_artifact('messages', 'directory', true, 'messages'),
        ]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .not.toThrow();
    });

    it('6.4.2 provider with no declared artifacts skips the check entirely', () => {
        seed();
        const provider = build_fake_provider([]);
        // The fence directory is never created — no lstat is called.
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .not.toThrow();
    });

    it('6.4.3 empty artifacts/<archive_subpath>/ directory IS treated as populated', () => {
        seed();
        write_artifact_directory('messages'); // empty directory
        const provider = build_fake_provider([make_artifact('messages', 'directory', true)]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .not.toThrow();
    });

    it('6.4.4 0-byte file artifact IS treated as populated', () => {
        seed();
        write_artifact_file('state.json', '');
        const provider = build_fake_provider([make_artifact('state.json', 'file', true)]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .not.toThrow();
    });

    it('6.4.5 success-flag-directory pattern: empty required directory passes', () => {
        seed();
        write_artifact_directory('flag'); // empty directory acts as success flag
        const provider = build_fake_provider([make_artifact('flag', 'directory', true)]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .not.toThrow();
    });

    it('6.4.6 the check uses lstatSync for type=file (does not traverse contents)', () => {
        // We cannot spy on `fs.readdirSync` directly (ESM module namespace is
        // non-configurable), so we exercise this behaviorally: a non-empty file
        // artifact must succeed. If the implementation used `readdirSync`, it
        // would throw ENOTDIR on the file path. The 0-byte test (6.4.4) covers
        // the symmetric case where a `readdir`-based implementation would also
        // fail.
        seed();
        write_artifact_file('state.bin', 'binary content');
        const provider = build_fake_provider([make_artifact('state.bin', 'file', true)]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .not.toThrow();
    });

    it('6.4.7 missing-artifact error lists by name when name and archive_subpath differ', () => {
        seed();
        // Sentinel: an unrelated populated artifact so the required-presence pass runs.
        write_artifact_directory('other-data');
        const provider = build_fake_provider([
            make_artifact('other-data', 'directory', false, 'sentinel'),
            make_artifact('messages', 'directory', true, 'chat-history'),
        ]);
        try {
            check_required_for_resume(patchlab_id, session_number, provider);
            throw new Error('expected to throw');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            expect(message).toContain('chat-history');
            expect(message).not.toContain('messages');
        }
    });

    it('6.4.8 resume check throws when an archive_subpath fails validation', () => {
        seed();
        const provider = build_fake_provider([
            make_artifact('../../etc/passwd', 'directory', true, 'malicious'),
        ]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .toThrow();
    });

    it('6.4.9 resume check throws when the artifact array has duplicate archive_subpath', () => {
        seed();
        const provider = build_fake_provider([
            make_artifact('shared', 'directory', true, 'first'),
            make_artifact('shared', 'directory', true, 'second'),
        ]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .toThrow(/duplicate archive_subpath/);
    });

    it('6.4.10 REQUIRED + type mismatch fails fast (declared directory, on-disk file)', () => {
        seed();
        write_artifact_file('state', 'should be a directory');
        const provider = build_fake_provider([
            make_artifact('state', 'directory', true),
        ]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .toThrow(/type directory.*on-disk entry/);
    });

    it('6.4.11 OPTIONAL + type mismatch logs a warning and is treated as absent', () => {
        seed();
        write_artifact_file('optional-state', 'should be a directory');
        const provider = build_fake_provider([
            make_artifact('optional-state', 'directory', false, 'opt'),
        ]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .not.toThrow();
        const captured_warnings = recording_logger.calls
            .filter((call) => call.method === 'warn')
            .map((call) => String(call.message));
        expect(captured_warnings.some((message) => message.includes('opt'))).toBe(true);
    });

    it('6.4.12 OPTIONAL mismatch alone — sentinel does not fire, resume proceeds', () => {
        seed();
        write_artifact_file('opt-state', 'wrong-type');
        const provider = build_fake_provider([
            make_artifact('opt-state', 'directory', false, 'opt'),
        ]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .not.toThrow();
    });

    it('6.4.13 OPTIONAL mismatch + populated REQUIRED — resume succeeds', () => {
        seed();
        write_artifact_file('opt-state', 'wrong-type');
        write_artifact_directory('required-data');
        const provider = build_fake_provider([
            make_artifact('opt-state', 'directory', false, 'optional'),
            make_artifact('required-data', 'directory', true, 'required'),
        ]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .not.toThrow();
    });

    it('6.4.14 OPTIONAL mismatch + missing REQUIRED — sentinel does not fire, resume proceeds', () => {
        seed();
        write_artifact_file('opt-state', 'wrong-type');
        // required is absent (not written)
        const provider = build_fake_provider([
            make_artifact('opt-state', 'directory', false, 'optional'),
            make_artifact('required-data', 'directory', true, 'required'),
        ]);
        // The optional mismatch warns, the required is absent, so is_used stays
        // false ("tool wasn't used"). Required-presence pass is skipped.
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .not.toThrow();
    });

    it('6.4.15 REQUIRED mismatch shadows otherwise-passing optional — fails fast', () => {
        seed();
        write_artifact_directory('opt-data'); // populated optional
        write_artifact_file('required-state', 'wrong-type');
        const provider = build_fake_provider([
            make_artifact('opt-data', 'directory', false, 'optional'),
            make_artifact('required-state', 'directory', true, 'required'),
        ]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .toThrow(/required artifact "required"/);
    });

    it('6.4.16 status check refuses interrupted prior session when artifacts are populated', () => {
        seed({ status: 'interrupted' });
        write_artifact_directory('messages'); // populated; sentinel fires, then status check throws
        const provider = build_fake_provider([make_artifact('messages', 'directory', true)]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .toThrow(/status "interrupted"/);
    });

    it('6.4.17 status precheck does NOT fire on completed', () => {
        seed({ status: 'completed' });
        write_artifact_directory('messages');
        const provider = build_fake_provider([make_artifact('messages', 'directory', true)]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .not.toThrow();
    });

    it('6.4.18 sentinel pass evaluates an OPTIONAL artifact and fires when only it is populated', () => {
        seed();
        write_artifact_directory('opt-data'); // optional populated
        // No required artifacts in the array — sentinel-only behavior.
        const provider = build_fake_provider([
            make_artifact('opt-data', 'directory', false, 'optional-only'),
        ]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .not.toThrow();
    });

    it('6.4.19 optional alone, populated, no required — sentinel fires, resume proceeds', () => {
        seed();
        write_artifact_directory('opt-data');
        const provider = build_fake_provider([
            make_artifact('opt-data', 'directory', false, 'optional'),
        ]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .not.toThrow();
    });

    it('6.4.20 optional alone, NOT populated, no required — sentinel does not fire, resume proceeds', () => {
        seed();
        // do NOT create any artifact
        const provider = build_fake_provider([
            make_artifact('opt-data', 'directory', false, 'optional'),
        ]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .not.toThrow();
    });

    it('6.4.21 one required + one optional, optional populated, required absent — required-presence FAILS', () => {
        seed();
        write_artifact_directory('opt-data'); // optional present
        // required absent
        const provider = build_fake_provider([
            make_artifact('opt-data', 'directory', false, 'optional'),
            make_artifact('required-data', 'directory', true, 'required'),
        ]);
        expect(() => check_required_for_resume(patchlab_id, session_number, provider))
            .toThrow(/required.*missing/);
    });
});
