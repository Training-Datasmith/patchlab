import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
    copy_context_to_archive,
    merge_resume_context,
    resolve_context_paths,
} from '../../src/context.js';
import { build_session_path } from '../../src/archive.js';
import { install_isolated_home_hooks } from '../helpers/home_directory.js';

describe('resolve_context_paths', () => {
    let working_directory: string;

    beforeEach(() => {
        working_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-context-')));
    });

    afterEach(() => {
        fs.rmSync(working_directory, { recursive: true, force: true });
    });

    it('preserves relative directory structure for relative inputs (6.3)', () => {
        fs.mkdirSync(path.join(working_directory, 'docs'));
        fs.writeFileSync(path.join(working_directory, 'docs', 'task.md'), 'task content');

        const result = resolve_context_paths(['./docs/task.md'], working_directory);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].archive_relative_path).toBe('docs/task.md');
        expect(result.warnings).toEqual([]);
    });

    it('uses filename only for absolute inputs (6.3)', () => {
        const absolute = path.join(working_directory, 'notes.txt');
        fs.writeFileSync(absolute, 'notes');

        const result = resolve_context_paths([absolute], working_directory);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].archive_relative_path).toBe('notes.txt');
    });

    it('first-wins on archive-path conflicts and warns (6.3)', () => {
        const first = path.join(working_directory, 'a-notes.txt');
        const second_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-context-other-'));
        const second = path.join(second_dir, 'a-notes.txt');
        try {
            fs.writeFileSync(first, 'first');
            fs.writeFileSync(second, 'second');

            // Both absolute → both resolve to archive `a-notes.txt`.
            const result = resolve_context_paths([first, second], working_directory);
            expect(result.entries).toHaveLength(1);
            expect(result.entries[0].source_path).toBe(first);
            expect(result.warnings.some((warning) => warning.includes('conflict'))).toBe(true);
        } finally {
            fs.rmSync(second_dir, { recursive: true, force: true });
        }
    });

    it('warns and skips inputs that do not exist', () => {
        const result = resolve_context_paths(['./does-not-exist.txt'], working_directory);
        expect(result.entries).toEqual([]);
        expect(result.warnings.some((warning) => warning.includes('does not exist'))).toBe(true);
    });
});

describe('merge_resume_context', () => {
    let previous_directory: string;
    let working_directory: string;

    beforeEach(() => {
        previous_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-prev-')));
        working_directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-cwd-')));
    });

    afterEach(() => {
        fs.rmSync(previous_directory, { recursive: true, force: true });
        fs.rmSync(working_directory, { recursive: true, force: true });
    });

    it('merges previous session entries with new --context inputs (6.7)', () => {
        fs.writeFileSync(path.join(previous_directory, 'task.md'), 'old task');
        fs.writeFileSync(path.join(working_directory, 'new-task.md'), 'new task');

        const result = merge_resume_context(previous_directory, ['./new-task.md'], working_directory);
        const archive_paths = result.entries.map((entry) => entry.archive_relative_path).sort();
        expect(archive_paths).toEqual(['new-task.md', 'task.md']);
    });

    it('new --context entries replace previous entries on conflict (6.7)', () => {
        fs.writeFileSync(path.join(previous_directory, 'task.md'), 'old task');
        fs.writeFileSync(path.join(working_directory, 'task.md'), 'new task');

        const result = merge_resume_context(previous_directory, ['./task.md'], working_directory);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].source_path).toBe(path.join(working_directory, 'task.md'));
        expect(result.warnings.some((warning) => warning.includes('Context override'))).toBe(true);
    });

    it('returns only new entries when no previous directory exists', () => {
        fs.writeFileSync(path.join(working_directory, 'task.md'), 'new task');
        const result = merge_resume_context(null, ['./task.md'], working_directory);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].archive_relative_path).toBe('task.md');
    });

    it('warns on basename collisions across different archive paths', () => {
        // Previous session had a flat `notes.txt` (e.g., from an absolute --context input).
        fs.writeFileSync(path.join(previous_directory, 'notes.txt'), 'flat notes');
        // New --context input is a relative path that preserves structure.
        fs.mkdirSync(path.join(working_directory, 'subdir'));
        fs.writeFileSync(path.join(working_directory, 'subdir', 'notes.txt'), 'nested notes');

        const result = merge_resume_context(
            previous_directory,
            ['./subdir/notes.txt'],
            working_directory
        );

        // Both entries kept (different archive paths).
        const archive_paths = result.entries
            .map((entry) => entry.archive_relative_path)
            .sort((a, b) => a.localeCompare(b));
        expect(archive_paths).toEqual(['notes.txt', 'subdir/notes.txt']);

        // But a warning surfaces the basename collision so the user isn't surprised.
        expect(result.warnings.some((warning) =>
            warning.includes("multiple files named 'notes.txt'")
        )).toBe(true);
    });
});

describe('copy_context_to_archive', () => {
    install_isolated_home_hooks('patchlab-ctx-copy-home-');
    let working_directory: string;

    const PATCHLAB_ID = 'pl-ctx-copy';
    const SESSION_NUMBER = 1;

    beforeEach(() => {
        working_directory = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-ctx-copy-src-')),
        );
    });

    afterEach(() => {
        fs.rmSync(working_directory, { recursive: true, force: true });
    });

    it('copies a single file into the archive at its archive_relative_path', () => {
        fs.writeFileSync(path.join(working_directory, 'task.md'), 'task body');

        const resolved = resolve_context_paths(['./task.md'], working_directory);
        copy_context_to_archive(resolved.entries, PATCHLAB_ID, SESSION_NUMBER);

        const expected = build_session_path(PATCHLAB_ID, SESSION_NUMBER, 'context/task.md');
        expect(fs.readFileSync(expected, 'utf-8')).toBe('task body');
    });

    it('preserves nested directory structure when copying a relative subdirectory entry', () => {
        fs.mkdirSync(path.join(working_directory, 'docs'));
        fs.writeFileSync(path.join(working_directory, 'docs', 'plan.md'), 'plan body');

        const resolved = resolve_context_paths(['./docs/plan.md'], working_directory);
        copy_context_to_archive(resolved.entries, PATCHLAB_ID, SESSION_NUMBER);

        const expected = build_session_path(PATCHLAB_ID, SESSION_NUMBER, 'context/docs/plan.md');
        expect(fs.readFileSync(expected, 'utf-8')).toBe('plan body');
    });

    it('copies a directory recursively', () => {
        fs.mkdirSync(path.join(working_directory, 'notes'));
        fs.writeFileSync(path.join(working_directory, 'notes', 'a.txt'), 'aaa');
        fs.writeFileSync(path.join(working_directory, 'notes', 'b.txt'), 'bbb');

        const resolved = resolve_context_paths(['./notes'], working_directory);
        copy_context_to_archive(resolved.entries, PATCHLAB_ID, SESSION_NUMBER);

        const archive_directory = build_session_path(PATCHLAB_ID, SESSION_NUMBER, 'context/notes');
        expect(fs.readFileSync(path.join(archive_directory, 'a.txt'), 'utf-8')).toBe('aaa');
        expect(fs.readFileSync(path.join(archive_directory, 'b.txt'), 'utf-8')).toBe('bbb');
    });

    it('is a no-op (creates no archive directory) when given an empty entries list', () => {
        copy_context_to_archive([], PATCHLAB_ID, SESSION_NUMBER);
        const archive_root = build_session_path(PATCHLAB_ID, SESSION_NUMBER, 'context');
        expect(fs.existsSync(archive_root)).toBe(false);
    });
});
