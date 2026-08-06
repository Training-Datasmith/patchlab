// Unit coverage for the three CLI argument-parsing helpers in `src/cli_arguments.ts`.
// Each is a pure function that throws BEFORE any podman / git / filesystem work,
// so they belong on the unit side.

import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
    parse_copy_specification,
    parse_session_number,
    resolve_apply_mode,
    validate_mount_count,
} from '../../src/cli_arguments.js';

describe('parse_copy_specification', () => {
    it('no destination defaults to the basename of the source', () => {
        const result = parse_copy_specification('/some/path/composer.lock');
        expect(result.destination).toBe('composer.lock');
        expect(result.source_path).toBe(path.resolve('/some/path/composer.lock'));
    });

    it('explicit destination is preserved exactly', () => {
        const result = parse_copy_specification('/some/path/composer.lock:vendor/composer.lock');
        expect(result.destination).toBe('vendor/composer.lock');
        expect(result.source_path).toBe(path.resolve('/some/path/composer.lock'));
    });

    it('destination starting with .. is rejected', () => {
        expect(() => parse_copy_specification('/some/file:../outside')).toThrow(/--copy destination must be within the workspace root/);
    });

    it('absolute destination is rejected', () => {
        expect(() => parse_copy_specification('/some/file:/absolute/dest')).toThrow(/--copy destination must be a relative path/);
    });

    it('Windows C:\\path\\file with no destination uses basename', () => {
        const result = parse_copy_specification(String.raw`C:\path\to\file.txt`);
        expect(result.destination).toBe('file.txt');
        expect(result.source_path).toBe(path.resolve(String.raw`C:\path\to\file.txt`));
    });

    it('Windows C:\\path\\file:destination.txt uses explicit destination', () => {
        const result = parse_copy_specification(String.raw`C:\path\to\file.txt:destination.txt`);
        expect(result.destination).toBe('destination.txt');
        expect(result.source_path).toBe(path.resolve(String.raw`C:\path\to\file.txt`));
    });

    it('POSIX path — first colon is the src/dest separator', () => {
        const result = parse_copy_specification('vendor/composer.lock:lock-file.json');
        expect(result.destination).toBe('lock-file.json');
        expect(result.source_path).toBe(path.resolve('vendor/composer.lock'));
    });

    it('~ in source is expanded to the user home directory', () => {
        const result = parse_copy_specification('~/my-file.txt');
        expect(result.source_path).toBe(path.join(os.homedir(), 'my-file.txt'));
        expect(result.destination).toBe('my-file.txt');
    });

    it('~ alone in source expands to the home directory (destination is basename of homedir)', () => {
        const result = parse_copy_specification('~');
        expect(result.source_path).toBe(os.homedir());
        expect(result.destination).toBe(path.basename(os.homedir()));
    });

    it('multiple calls produce independent specifications', () => {
        const first = parse_copy_specification('/a/file-a.txt');
        const second = parse_copy_specification('/b/file-b.txt:renamed.txt');
        expect(first.destination).toBe('file-a.txt');
        expect(second.destination).toBe('renamed.txt');
    });
});

describe('parse_session_number', () => {
    it('accepts a positive integer string', () => {
        expect(parse_session_number('7')).toBe(7);
    });

    it('throws on zero', () => {
        // The CLI uses `--session 0` to mean "no session selected" only as a
        // sentinel value internally. From the command line, 0 is a parse error
        // because session numbers begin at 1.
        expect(() => parse_session_number('0')).toThrow(/--session expects a positive integer, got: 0/);
    });

    it('throws on a negative integer', () => {
        expect(() => parse_session_number('-3')).toThrow(/--session expects a positive integer, got: -3/);
    });

    it('throws on a non-numeric string', () => {
        // `Number.parseInt('abc', 10)` returns NaN; `Number.isFinite(NaN)` is
        // false, so the guard catches it. The error message preserves the
        // raw input so the operator can see what was rejected.
        expect(() => parse_session_number('abc')).toThrow(/--session expects a positive integer, got: abc/);
    });
});

describe('resolve_apply_mode', () => {
    it('returns cherry-pick when --merge is absent', () => {
        expect(resolve_apply_mode(undefined)).toBe('cherry-pick');
    });

    it('returns merge-commit for the bare --merge flag (Commander sets the value to true)', () => {
        // `commander` represents `--merge` with no value as `true` because the
        // option is declared as `[strategy]` (optional value).
        expect(resolve_apply_mode(true)).toBe('merge-commit');
    });

    it('returns merge-commit for --merge=commit', () => {
        expect(resolve_apply_mode('commit')).toBe('merge-commit');
    });

    it('returns merge-squash for --merge=squash', () => {
        expect(resolve_apply_mode('squash')).toBe('merge-squash');
    });

    it('throws on any other --merge value', () => {
        // Catches typos like `--merge=squash-and-rebase` or `--merge=merge`.
        // The error includes the raw input so the operator can correct it.
        expect(() => resolve_apply_mode('rebase')).toThrow(/--merge expects "commit" or "squash", got: rebase/);
    });
});

describe('validate_mount_count', () => {
    it('accepts equal mount and source counts (every source gets a mount)', () => {
        expect(() => validate_mount_count(2, 2)).not.toThrow();
    });

    it('accepts fewer mounts than sources (trailing sources auto-name)', () => {
        // The Nth `--mount` applies to the Nth source positionally; sources
        // past the last `--mount` derive their mount name from the directory.
        expect(() => validate_mount_count(1, 3)).not.toThrow();
    });

    it('accepts zero mounts and zero sources (a no-op call must not throw)', () => {
        expect(() => validate_mount_count(0, 0)).not.toThrow();
    });

    it('throws when mounts exceed total sources', () => {
        // The throw is the load-bearing protection: silently dropping the
        // extra `--mount` would attach the wrong mount name to the wrong
        // source on a re-run, an extremely hard-to-diagnose bug.
        expect(() => validate_mount_count(3, 2)).toThrow(
            /--mount supplied 3 times but only 2 source\(s\) were given/,
        );
    });

    it('error message names the position rule so the operator can self-correct', () => {
        expect(() => validate_mount_count(2, 1)).toThrow(
            /The Nth --mount applies to the Nth source/,
        );
    });
});
