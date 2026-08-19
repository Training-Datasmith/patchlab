import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    resolve_prompt_file_staging,
    Prompt_File_Staging_Error,
} from '../../../src/context.js';

describe('resolve_prompt_file_staging', () => {
    let base_directory: string;
    let cleanup: string[] = [];

    beforeEach(() => {
        base_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-prompt-file-'));
        cleanup.push(base_directory);
    });

    afterEach(() => {
        for (const directory of cleanup) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
        cleanup = [];
    });

    it('maps prompt files to container context paths', () => {
        const file_path = path.join(base_directory, 'spec.md');
        fs.writeFileSync(file_path, '# spec\n');

        const result = resolve_prompt_file_staging(
            ['spec.md'],
            [],
            '/home/patchlab',
            base_directory,
        );

        expect(result.merged_context_paths).toEqual([file_path]);
        expect(result.container_files).toEqual(['/home/patchlab/context/spec.md']);
    });

    it('rejects missing prompt files', () => {
        expect(() => resolve_prompt_file_staging(
            ['missing.md'],
            [],
            '/home/patchlab',
            base_directory,
        )).toThrow(Prompt_File_Staging_Error);
    });

    it('rejects directories', () => {
        const directory_path = path.join(base_directory, 'docs');
        fs.mkdirSync(directory_path);

        expect(() => resolve_prompt_file_staging(
            ['docs'],
            [],
            '/home/patchlab',
            base_directory,
        )).toThrow(/must be a file/);
    });

    it('rejects destination collisions with --context', () => {
        const context_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-prompt-file-ctx-'));
        const prompt_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-prompt-file-prm-'));
        cleanup.push(context_dir, prompt_dir);
        const file_a = path.join(context_dir, 'foo.txt');
        const file_b = path.join(prompt_dir, 'foo.txt');
        fs.writeFileSync(file_a, 'a');
        fs.writeFileSync(file_b, 'b');

        expect(() => resolve_prompt_file_staging(
            [file_b],
            [file_a],
            '/home/patchlab',
            base_directory,
        )).toThrow(Prompt_File_Staging_Error);
    });
});
