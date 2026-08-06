import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../../src/podman.js', () => ({
    copy_to_container: vi.fn(),
    exec_container: vi.fn(),
}));

import {
    inject_context_bundle,
    inject_resume_context,
} from '../../../src/sandbox/context_injection.js';
import { build_session_path } from '../../../src/archive.js';
import { copy_to_container, exec_container } from '../../../src/podman.js';
import { install_isolated_home_hooks } from '../../helpers/home_directory.js';
import {
    install_recording_logger_hooks,
    filter_recorded_messages,
} from '../../helpers/recording_logger.js';

const CONTAINER_NAME = 'patchlab-test-container';
const IMAGE_HOME = '/home/patchlab';

const mocked_copy_to_container = vi.mocked(copy_to_container);
const mocked_exec_container = vi.mocked(exec_container);

function seed_source_directory(prefix: string): string {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function seed_previous_session_context(
    patchlab_id: string,
    session_number: number,
    files: Record<string, string>,
): string {
    const directory = build_session_path(patchlab_id, session_number, 'context');
    fs.mkdirSync(directory, { recursive: true });
    for (const [relative_path, contents] of Object.entries(files)) {
        const absolute_path = path.join(directory, relative_path);
        fs.mkdirSync(path.dirname(absolute_path), { recursive: true });
        fs.writeFileSync(absolute_path, contents);
    }

    return directory;
}

describe('inject_context_bundle', () => {
    install_isolated_home_hooks('patchlab-inject-bundle-');
    const logger_handle = install_recording_logger_hooks();

    beforeEach(() => {
        mocked_copy_to_container.mockReset();
        mocked_exec_container.mockReset();
    });

    it('returns without writing or copying when context_paths is empty', () => {
        inject_context_bundle('pl-empty', 1, CONTAINER_NAME, IMAGE_HOME, []);

        expect(mocked_copy_to_container).not.toHaveBeenCalled();
        expect(mocked_exec_container).not.toHaveBeenCalled();
        const archive_root = build_session_path('pl-empty', 1, 'context');
        expect(fs.existsSync(archive_root)).toBe(false);
    });

    it('returns without copying when every supplied path fails to resolve', () => {
        const source_directory = seed_source_directory('patchlab-bundle-missing-');

        inject_context_bundle(
            'pl-missing',
            1,
            CONTAINER_NAME,
            IMAGE_HOME,
            [path.join(source_directory, 'does-not-exist.txt')],
        );

        expect(mocked_copy_to_container).not.toHaveBeenCalled();
        expect(mocked_exec_container).not.toHaveBeenCalled();
        const warnings = filter_recorded_messages(logger_handle.current(), 'warn');
        expect(warnings.some((message) => message.includes('does not exist'))).toBe(true);
    });

    it('writes a resolved file into the archive context directory', () => {
        const source_directory = seed_source_directory('patchlab-bundle-file-');
        const source_file = path.join(source_directory, 'notes.md');
        fs.writeFileSync(source_file, 'task notes');

        inject_context_bundle('pl-one', 1, CONTAINER_NAME, IMAGE_HOME, [source_file]);

        const archive_root = build_session_path('pl-one', 1, 'context');
        expect(fs.existsSync(path.join(archive_root, 'notes.md'))).toBe(true);
        expect(fs.readFileSync(path.join(archive_root, 'notes.md'), 'utf-8')).toBe('task notes');
    });

    it('copies the archive context directory into the container after writing', () => {
        const source_directory = seed_source_directory('patchlab-bundle-copy-');
        const source_file = path.join(source_directory, 'plan.md');
        fs.writeFileSync(source_file, 'plan');

        inject_context_bundle('pl-copy', 1, CONTAINER_NAME, IMAGE_HOME, [source_file]);

        expect(mocked_exec_container).toHaveBeenCalledWith(
            CONTAINER_NAME,
            ['mkdir', '-p', `${IMAGE_HOME}/context`],
        );
        expect(mocked_copy_to_container).toHaveBeenCalledTimes(1);
        const [container, source_argument, destination_argument] = mocked_copy_to_container.mock.calls[0];
        expect(container).toBe(CONTAINER_NAME);
        expect(source_argument).toMatch(/[\\/]context[\\/]\.$/);
        expect(destination_argument).toBe(`${IMAGE_HOME}/context`);
    });

    it('surfaces resolution warnings through logger().warn', () => {
        const first_directory = seed_source_directory('patchlab-bundle-warn-first-');
        const second_directory = seed_source_directory('patchlab-bundle-warn-second-');
        const first = path.join(first_directory, 'shared.txt');
        const second = path.join(second_directory, 'shared.txt');
        fs.writeFileSync(first, 'first content');
        fs.writeFileSync(second, 'second content');

        inject_context_bundle('pl-warn', 1, CONTAINER_NAME, IMAGE_HOME, [first, second]);

        const warnings = filter_recorded_messages(logger_handle.current(), 'warn');
        expect(warnings.some((message) => message.includes('conflict'))).toBe(true);
    });

    it('writes multiple resolved entries to the archive directory', () => {
        const source_directory = seed_source_directory('patchlab-bundle-multi-');
        const first = path.join(source_directory, 'a.txt');
        const second = path.join(source_directory, 'b.txt');
        fs.writeFileSync(first, 'a');
        fs.writeFileSync(second, 'b');

        inject_context_bundle('pl-multi', 1, CONTAINER_NAME, IMAGE_HOME, [first, second]);

        const archive_root = build_session_path('pl-multi', 1, 'context');
        expect(fs.readFileSync(path.join(archive_root, 'a.txt'), 'utf-8')).toBe('a');
        expect(fs.readFileSync(path.join(archive_root, 'b.txt'), 'utf-8')).toBe('b');
    });
});

describe('inject_resume_context', () => {
    install_isolated_home_hooks('patchlab-inject-resume-');
    const logger_handle = install_recording_logger_hooks();

    beforeEach(() => {
        mocked_copy_to_container.mockReset();
        mocked_exec_container.mockReset();
    });

    it('returns without materializing when no previous context and no new paths', () => {
        inject_resume_context(
            'pl-resume-empty',
            2,
            1,
            CONTAINER_NAME,
            IMAGE_HOME,
            [],
        );

        expect(mocked_copy_to_container).not.toHaveBeenCalled();
        expect(mocked_exec_container).not.toHaveBeenCalled();
        const new_session = build_session_path('pl-resume-empty', 2, 'context');
        expect(fs.existsSync(new_session)).toBe(false);
    });

    it('carries previous session context forward when no new inputs are supplied', () => {
        seed_previous_session_context('pl-resume-carry', 1, {
            'plan.md': 'session 1 plan',
            'notes/details.md': 'session 1 details',
        });

        inject_resume_context(
            'pl-resume-carry',
            2,
            1,
            CONTAINER_NAME,
            IMAGE_HOME,
            [],
        );

        const new_session = build_session_path('pl-resume-carry', 2, 'context');
        expect(fs.readFileSync(path.join(new_session, 'plan.md'), 'utf-8')).toBe('session 1 plan');
        expect(fs.readFileSync(
            path.join(new_session, 'notes', 'details.md'),
            'utf-8',
        )).toBe('session 1 details');
    });

    it('walks back to the most recent non-empty session when the immediate prior is empty', () => {
        seed_previous_session_context('pl-resume-walk', 1, { 'origin.md': 'origin' });
        // Session 2 directory exists, but `context/` is missing — walk-back must skip it.
        fs.mkdirSync(build_session_path('pl-resume-walk', 2), { recursive: true });

        inject_resume_context(
            'pl-resume-walk',
            3,
            2,
            CONTAINER_NAME,
            IMAGE_HOME,
            [],
        );

        const new_session = build_session_path('pl-resume-walk', 3, 'context');
        expect(fs.readFileSync(path.join(new_session, 'origin.md'), 'utf-8')).toBe('origin');
    });

    it('walks past an empty (zero-entry) context directory', () => {
        seed_previous_session_context('pl-resume-empty-dir', 1, { 'kept.md': 'kept' });
        // Session 2 has a context/ directory but it's empty — walk back to session 1.
        const empty_dir = build_session_path('pl-resume-empty-dir', 2, 'context');
        fs.mkdirSync(empty_dir, { recursive: true });

        inject_resume_context(
            'pl-resume-empty-dir',
            3,
            2,
            CONTAINER_NAME,
            IMAGE_HOME,
            [],
        );

        const new_session = build_session_path('pl-resume-empty-dir', 3, 'context');
        expect(fs.readFileSync(path.join(new_session, 'kept.md'), 'utf-8')).toBe('kept');
    });

    it('returns null walk-back when no session in the patchlab has context', () => {
        inject_resume_context(
            'pl-resume-none',
            2,
            1,
            CONTAINER_NAME,
            IMAGE_HOME,
            [],
        );

        expect(mocked_copy_to_container).not.toHaveBeenCalled();
        expect(mocked_exec_container).not.toHaveBeenCalled();
    });

    it('overlays new --context inputs on top of previous session context', () => {
        seed_previous_session_context('pl-resume-overlay', 1, { 'plan.md': 'session 1 plan' });
        const new_source = seed_source_directory('patchlab-overlay-new-');
        const additional_file = path.join(new_source, 'extra.md');
        fs.writeFileSync(additional_file, 'session 2 extra');

        inject_resume_context(
            'pl-resume-overlay',
            2,
            1,
            CONTAINER_NAME,
            IMAGE_HOME,
            [additional_file],
        );

        const new_session = build_session_path('pl-resume-overlay', 2, 'context');
        expect(fs.readFileSync(path.join(new_session, 'plan.md'), 'utf-8')).toBe('session 1 plan');
        expect(fs.readFileSync(path.join(new_session, 'extra.md'), 'utf-8')).toBe('session 2 extra');
    });

    it('replaces previous file when new --context collides on archive path and warns', () => {
        seed_previous_session_context('pl-resume-replace', 1, { 'shared.md': 'old' });
        const new_source = seed_source_directory('patchlab-replace-new-');
        const replacement = path.join(new_source, 'shared.md');
        fs.writeFileSync(replacement, 'new');

        inject_resume_context(
            'pl-resume-replace',
            2,
            1,
            CONTAINER_NAME,
            IMAGE_HOME,
            [replacement],
        );

        const new_session = build_session_path('pl-resume-replace', 2, 'context');
        expect(fs.readFileSync(path.join(new_session, 'shared.md'), 'utf-8')).toBe('new');
        const warnings = filter_recorded_messages(logger_handle.current(), 'warn');
        expect(warnings.some((message) => message.includes('override'))).toBe(true);
    });

    it('writes nested directory entries from previous context recursively', () => {
        seed_previous_session_context('pl-resume-nested', 1, {
            'a/b/c/deep.md': 'deep content',
        });

        inject_resume_context(
            'pl-resume-nested',
            2,
            1,
            CONTAINER_NAME,
            IMAGE_HOME,
            [],
        );

        const new_session = build_session_path('pl-resume-nested', 2, 'context');
        expect(fs.readFileSync(
            path.join(new_session, 'a', 'b', 'c', 'deep.md'),
            'utf-8',
        )).toBe('deep content');
    });

    it('writes a directory entry recursively from a --context input', () => {
        const new_source = seed_source_directory('patchlab-resume-dir-input-');
        const directory_input = path.join(new_source, 'docs');
        fs.mkdirSync(path.join(directory_input, 'nested'), { recursive: true });
        fs.writeFileSync(path.join(directory_input, 'top.md'), 'top');
        fs.writeFileSync(path.join(directory_input, 'nested', 'inner.md'), 'inner');

        inject_resume_context(
            'pl-resume-dir-input',
            1,
            0,
            CONTAINER_NAME,
            IMAGE_HOME,
            [directory_input],
        );

        const new_session = build_session_path('pl-resume-dir-input', 1, 'context');
        expect(fs.readFileSync(path.join(new_session, 'docs', 'top.md'), 'utf-8')).toBe('top');
        expect(fs.readFileSync(
            path.join(new_session, 'docs', 'nested', 'inner.md'),
            'utf-8',
        )).toBe('inner');
    });

    it('preserves file mode when materializing entries', () => {
        if (process.platform === 'win32') {
            // chmod is a no-op on Windows; the assertion is platform-specific.
            return;
        }
        const new_source = seed_source_directory('patchlab-resume-mode-');
        const executable_input = path.join(new_source, 'run.sh');
        fs.writeFileSync(executable_input, '#!/bin/sh\necho hi\n');
        fs.chmodSync(executable_input, 0o755);

        inject_resume_context(
            'pl-resume-mode',
            1,
            0,
            CONTAINER_NAME,
            IMAGE_HOME,
            [executable_input],
        );

        const new_session = build_session_path('pl-resume-mode', 1, 'context');
        const destination_stat = fs.statSync(path.join(new_session, 'run.sh'));
        expect(destination_stat.mode & 0o777).toBe(0o755);
    });

    it('replaces a pre-existing entry at the destination when materializing', () => {
        const new_source = seed_source_directory('patchlab-resume-prewrite-');
        const source_file = path.join(new_source, 'sole.md');
        fs.writeFileSync(source_file, 'fresh');

        // Pre-populate the new session's destination so the write must overwrite.
        const new_session = build_session_path('pl-resume-prewrite', 1, 'context');
        fs.mkdirSync(new_session, { recursive: true });
        fs.writeFileSync(path.join(new_session, 'sole.md'), 'stale');

        inject_resume_context(
            'pl-resume-prewrite',
            1,
            0,
            CONTAINER_NAME,
            IMAGE_HOME,
            [source_file],
        );

        expect(fs.readFileSync(path.join(new_session, 'sole.md'), 'utf-8')).toBe('fresh');
    });

    it('copies the materialized new session context into the container', () => {
        seed_previous_session_context('pl-resume-container-copy', 1, { 'plan.md': 'plan' });

        inject_resume_context(
            'pl-resume-container-copy',
            2,
            1,
            CONTAINER_NAME,
            IMAGE_HOME,
            [],
        );

        expect(mocked_exec_container).toHaveBeenCalledWith(
            CONTAINER_NAME,
            ['mkdir', '-p', `${IMAGE_HOME}/context`],
        );
        expect(mocked_copy_to_container).toHaveBeenCalledTimes(1);
        const [container, source_argument, destination_argument] = mocked_copy_to_container.mock.calls[0];
        expect(container).toBe(CONTAINER_NAME);
        expect(source_argument).toMatch(/[\\/]context[\\/]\.$/);
        expect(destination_argument).toBe(`${IMAGE_HOME}/context`);
    });

    it('surfaces basename-collision warnings when previous and new entries share a basename at different paths', () => {
        seed_previous_session_context('pl-resume-basename', 1, { 'docs/shared.md': 'old docs' });
        const new_source = seed_source_directory('patchlab-resume-basename-new-');
        const colliding = path.join(new_source, 'shared.md');
        fs.writeFileSync(colliding, 'new top-level');

        inject_resume_context(
            'pl-resume-basename',
            2,
            1,
            CONTAINER_NAME,
            IMAGE_HOME,
            [colliding],
        );

        const warnings = filter_recorded_messages(logger_handle.current(), 'warn');
        expect(warnings.some((message) => message.includes('multiple files named'))).toBe(true);
    });
});

describe('inject_resume_context (symlink handling)', () => {
    install_isolated_home_hooks('patchlab-inject-resume-symlink-');
    install_recording_logger_hooks();

    beforeEach(() => {
        mocked_copy_to_container.mockReset();
        mocked_exec_container.mockReset();
    });

    it('materializes symlink entries (or falls back to dereferenced copy on filesystems that reject them)', () => {
        const new_source = seed_source_directory('patchlab-resume-symlink-');
        const target = path.join(new_source, 'target.md');
        fs.writeFileSync(target, 'target content');
        const link = path.join(new_source, 'link.md');
        try {
            fs.symlinkSync('./target.md', link);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'ENOTSUP') {
                // Filesystem rejects symlink creation (Windows without Developer
                // Mode, some network mounts). The fallback path is not reachable
                // when we can't even seed the fixture.
                return;
            }
            throw error;
        }

        inject_resume_context(
            'pl-resume-symlink',
            1,
            0,
            CONTAINER_NAME,
            IMAGE_HOME,
            // Pass the target alongside the link so the relative in-root link
            // resolves in the archive: on platforms that replicate it as a link
            // (rather than dereferencing it), the co-located target is what the
            // link points at.
            [link, target],
        );

        const new_session = build_session_path('pl-resume-symlink', 1, 'context');
        const destination = path.join(new_session, 'link.md');
        // Either the link survived as a symlink, or the dereference fallback
        // copied the target content. Both are acceptable per
        // `copy_symlink_with_dereference_fallback`'s contract.
        expect(fs.existsSync(destination)).toBe(true);
        expect(fs.readFileSync(destination, 'utf-8')).toBe('target content');
    });

    it('materializes a symlink nested inside a directory entry (directory-walk branch)', () => {
        const new_source = seed_source_directory('patchlab-resume-dir-symlink-');
        const directory_input = path.join(new_source, 'bundle');
        fs.mkdirSync(directory_input);
        const target = path.join(directory_input, 'target.md');
        fs.writeFileSync(target, 'target content');
        const nested_link = path.join(directory_input, 'link.md');
        try {
            fs.symlinkSync('./target.md', nested_link);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'ENOTSUP') {
                return;
            }
            throw error;
        }

        inject_resume_context(
            'pl-resume-dir-symlink',
            1,
            0,
            CONTAINER_NAME,
            IMAGE_HOME,
            [directory_input],
        );

        const new_session = build_session_path('pl-resume-dir-symlink', 1, 'context');
        const destination = path.join(new_session, 'bundle', 'link.md');
        expect(fs.existsSync(destination)).toBe(true);
        expect(fs.readFileSync(destination, 'utf-8')).toBe('target content');
    });

    it('replaces a pre-existing destination file with a symlink (unlink-then-link path)', () => {
        const new_source = seed_source_directory('patchlab-resume-symlink-replace-');
        const target = path.join(new_source, 'target.md');
        fs.writeFileSync(target, 'symlink target');
        const link = path.join(new_source, 'link.md');
        try {
            fs.symlinkSync('./target.md', link);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'ENOTSUP') {
                return;
            }
            throw error;
        }

        // Pre-populate the destination so the materializer must unlink before linking.
        const new_session = build_session_path('pl-resume-symlink-replace', 1, 'context');
        fs.mkdirSync(new_session, { recursive: true });
        fs.writeFileSync(path.join(new_session, 'link.md'), 'stale content');

        inject_resume_context(
            'pl-resume-symlink-replace',
            1,
            0,
            CONTAINER_NAME,
            IMAGE_HOME,
            // Pass the target alongside the link so the relative in-root link
            // resolves in the archive: on platforms that replicate it as a link
            // (rather than dereferencing it), the co-located target is what the
            // link points at.
            [link, target],
        );

        const destination = path.join(new_session, 'link.md');
        expect(fs.existsSync(destination)).toBe(true);
        expect(fs.readFileSync(destination, 'utf-8')).toBe('symlink target');
    });
});
