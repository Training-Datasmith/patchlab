import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { safe_unlink, atomic_write_file } from '../../src/safe_filesystem.js';
import { install_recording_logger_hooks, type RecordingLogger } from '../helpers/recording_logger.js';

describe('safe_unlink', () => {
    const recording_handle = install_recording_logger_hooks();
    let temporary_directory: string;
    let recording_logger: RecordingLogger;

    beforeEach(() => {
        temporary_directory = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-safe-unlink-')),
        );
        recording_logger = recording_handle.current();
    });

    afterEach(() => {
        fs.rmSync(temporary_directory, { recursive: true, force: true });
    });

    it('removes a file that exists and emits no warning', () => {
        const target = path.join(temporary_directory, 'present.txt');
        fs.writeFileSync(target, 'payload');

        safe_unlink(target);

        expect(fs.existsSync(target)).toBe(false);
        expect(recording_logger.calls.filter((call) => call.method === 'warn')).toEqual([]);
    });

    it('returns silently when the file is already absent (ENOENT)', () => {
        const missing = path.join(temporary_directory, 'missing.txt');

        expect(() => safe_unlink(missing)).not.toThrow();
        expect(recording_logger.calls.filter((call) => call.method === 'warn')).toEqual([]);
    });

    it('emits a warning (but does not throw) for non-ENOENT failures', () => {
        // Passing a directory path to `unlinkSync` triggers EISDIR (POSIX) or
        // EPERM (Windows) — both are non-ENOENT codes the helper must surface.
        const directory_target = path.join(temporary_directory, 'a-directory');
        fs.mkdirSync(directory_target);

        expect(() => safe_unlink(directory_target)).not.toThrow();
        const warnings = recording_logger.calls.filter((call) => call.method === 'warn');
        expect(warnings).toHaveLength(1);
        expect(warnings[0].message).toBeInstanceOf(Error);
        // Directory still present — the helper did not silently delete it.
        expect(fs.existsSync(directory_target)).toBe(true);
    });
});

describe('atomic_write_file', () => {
    install_recording_logger_hooks();
    let temporary_directory: string;

    beforeEach(() => {
        temporary_directory = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-atomic-write-')),
        );
    });

    afterEach(() => {
        fs.rmSync(temporary_directory, { recursive: true, force: true });
    });

    function leftover_tempfiles(target: string): string[] {
        const base = path.basename(target);
        return fs
            .readdirSync(path.dirname(target))
            .filter((entry) => entry.startsWith(`${base}.tmp.`));
    }

    it('writes string contents and leaves no tempfile behind', () => {
        const target = path.join(temporary_directory, 'config.json');

        atomic_write_file(target, '{"a":1}');

        expect(fs.readFileSync(target, 'utf-8')).toBe('{"a":1}');
        expect(leftover_tempfiles(target)).toEqual([]);
    });

    it('writes raw bytes for a Uint8Array payload', () => {
        const target = path.join(temporary_directory, 'binary');
        const payload = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

        atomic_write_file(target, payload);

        expect(fs.readFileSync(target)).toEqual(payload);
    });

    it('overwrites an existing file in place', () => {
        const target = path.join(temporary_directory, 'metadata.json');
        fs.writeFileSync(target, 'stale');

        atomic_write_file(target, 'fresh');

        expect(fs.readFileSync(target, 'utf-8')).toBe('fresh');
        expect(leftover_tempfiles(target)).toEqual([]);
    });
});
