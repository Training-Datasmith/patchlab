// Windows-only: `merge_resume_workspace_copies` folds destination paths with
// `host_is_case_insensitive()` so a new `--copy` input replaces a previous
// session archive entry when the destinations differ only by case.
//
// Self-gates on win32; no-ops on POSIX runners.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { merge_resume_workspace_copies } from '../../src/sandbox/workspace_copies.js';
import { build_session_path } from '../../src/archive.js';
import { install_isolated_home_hooks } from '../helpers/home_directory.js';

const IS_WINDOWS = process.platform === 'win32';
const describe_on_windows = describe.runIf(IS_WINDOWS);

describe_on_windows('merge_resume_workspace_copies — case-insensitive destination dedup', () => {
    install_isolated_home_hooks('patchlab-wcopy-dedup-');
    const patchlab_id = '00000000-0000-4000-8000-000000000010';
    let previous_session_directory: string;
    let new_source_file: string;

    beforeEach(() => {
        previous_session_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-wcopy-prev-'));
        const previous_file = path.join(previous_session_directory, 'Out', 'settings.json');
        fs.mkdirSync(path.dirname(previous_file), { recursive: true });
        fs.writeFileSync(previous_file, 'from-previous-session\n');

        new_source_file = path.join(os.tmpdir(), `patchlab-wcopy-new-${Date.now()}.json`);
        fs.writeFileSync(new_source_file, 'from-new-copy\n');
    });

    afterEach(() => {
        fs.rmSync(previous_session_directory, { recursive: true, force: true });
        fs.rmSync(new_source_file, { force: true });
    });

    it('treats Out/ and out/ destinations as the same conflict key on NTFS', () => {
        const result = merge_resume_workspace_copies(
            previous_session_directory,
            [{
                source_path: new_source_file,
                destination: 'out/settings.json',
            }],
            patchlab_id,
            2,
        );

        expect(result.warnings.some((warning) => warning.includes('Workspace copy override'))).toBe(true);
        expect(result.warnings.some((warning) => warning.includes('Out/settings.json'))).toBe(true);

        const archive_root = build_session_path(patchlab_id, 2, 'workspace-copies');
        // New copy wins; on NTFS both spellings address the same file.
        expect(fs.readFileSync(path.join(archive_root, 'out', 'settings.json'), 'utf-8'))
            .toBe('from-new-copy\n');
        expect(fs.readFileSync(path.join(archive_root, 'Out', 'settings.json'), 'utf-8'))
            .toBe('from-new-copy\n');

        const archived_relative_paths: string[] = [];
        function walk(relative_directory: string): void {
            for (const entry of fs.readdirSync(path.join(archive_root, relative_directory), { withFileTypes: true })) {
                const relative_path = relative_directory ? `${relative_directory}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    walk(relative_path);
                } else if (entry.isFile()) {
                    archived_relative_paths.push(relative_path);
                }
            }
        }
        walk('');
        expect(archived_relative_paths).toHaveLength(1);
        expect(archived_relative_paths[0]?.toLowerCase()).toBe('out/settings.json');
    });
});
