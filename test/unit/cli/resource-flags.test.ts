/**
 * CLI-flag parsing and validation for the four resource-limit flags.
 *
 * Two surfaces are exercised:
 *   1. The per-flag value parsers (`parse_memory_value`, `parse_cpus_value`,
 *      `parse_pids_value`, `parse_blkio_weight_value`) — these run when
 *      Commander accepts a string for the flag's argument. They handle the
 *      `--flag=-N` equals form (Commander passes `-N` as the value) and
 *      ALL positive-validation cases (range checks, type checks).
 *   2. The pre-parse guard `argv_contains_resource_flag_negative` — catches
 *      `--flag -N` (space-separated) before Commander touches argv, so the
 *      patchlab-branded error names the offending flag rather than emitting
 *      a generic "missing argument" / "unknown option" message.
 *
 * Task 5.4b explicitly calls out both forms (space and equals) for negative
 * values; the cases below cover each flag in both forms.
 */
import { describe, it, expect } from 'vitest';
import {
    argv_contains_resource_flag_negative,
    parse_memory_value,
    parse_cpus_value,
    parse_pids_value,
    parse_blkio_weight_value,
    UNLIMITED,
} from '../../../src/resource_limits.js';

describe('argv_contains_resource_flag_negative — space-separated form (task 5.4a/5.4b)', () => {
    it('catches --memory -1g', () => {
        const result = argv_contains_resource_flag_negative(
            ['node', 'patchlab', 'create', '--memory', '-1g', './source'],
        );
        expect(result).toEqual({ flag: '--memory' });
    });

    it('catches --cpus -2.0', () => {
        const result = argv_contains_resource_flag_negative(
            ['node', 'patchlab', 'create', '--cpus', '-2.0', './source'],
        );
        expect(result).toEqual({ flag: '--cpus' });
    });

    it('catches --pids-limit -1', () => {
        const result = argv_contains_resource_flag_negative(
            ['node', 'patchlab', 'create', '--pids-limit', '-1', './source'],
        );
        expect(result).toEqual({ flag: '--pids-limit' });
    });

    it('catches --blkio-weight -10', () => {
        const result = argv_contains_resource_flag_negative(
            ['node', 'patchlab', 'create', '--blkio-weight', '-10', './source'],
        );
        expect(result).toEqual({ flag: '--blkio-weight' });
    });

    it('does NOT match positive values', () => {
        const result = argv_contains_resource_flag_negative(
            ['node', 'patchlab', 'create', '--memory', '4g', '--cpus', '2.0', './source'],
        );
        expect(result).toBeNull();
    });

    it('does NOT match a non-resource flag followed by a negative number', () => {
        // The guard only fires on the four resource-limit flag names.
        const result = argv_contains_resource_flag_negative(
            ['node', 'patchlab', 'create', '--other-flag', '-1', './source'],
        );
        expect(result).toBeNull();
    });

    it('does NOT match --flag=-N (equals form is handled by the per-flag validator)', () => {
        // `--memory=-1g` is a single token, not a flag+negative pair.
        const result = argv_contains_resource_flag_negative(
            ['node', 'patchlab', 'create', '--memory=-1g', './source'],
        );
        expect(result).toBeNull();
    });

    it('stops scanning at the -- end-of-options separator', () => {
        const result = argv_contains_resource_flag_negative(
            ['node', 'patchlab', 'create', '--', '--memory', '-1g'],
        );
        expect(result).toBeNull();
    });

    it('handles empty argv', () => {
        expect(argv_contains_resource_flag_negative([])).toBeNull();
    });
});

describe('parse_memory_value', () => {
    it('accepts plain integer values', () => {
        expect(parse_memory_value('4096')).toBe('4096');
    });

    it('accepts suffixed values (b/k/m/g, case-insensitive)', () => {
        expect(parse_memory_value('4g')).toBe('4g');
        expect(parse_memory_value('512m')).toBe('512m');
        expect(parse_memory_value('1024k')).toBe('1024k');
        expect(parse_memory_value('2048b')).toBe('2048b');
    });

    it('normalizes uppercase suffixes to lowercase', () => {
        expect(parse_memory_value('4G')).toBe('4g');
        expect(parse_memory_value('512M')).toBe('512m');
    });

    it('returns UNLIMITED for "0"', () => {
        expect(parse_memory_value('0')).toBe(UNLIMITED);
    });

    it('rejects non-numeric values with a message naming --memory', () => {
        expect(() => parse_memory_value('abc')).toThrow(/--memory/);
    });

    it('rejects negative values (equals form, --memory=-1g) with a message naming --memory', () => {
        // Commander passes the value string to the parser; `-1g` matches the
        // negative prefix and must be rejected.
        expect(() => parse_memory_value('-1g')).toThrow(/--memory/);
    });

    it('rejects values with weird suffixes', () => {
        expect(() => parse_memory_value('4tb')).toThrow(/--memory/);
        expect(() => parse_memory_value('1.5g')).toThrow(/--memory/);
    });

    it('returns UNLIMITED for zero-equivalent suffixed values (0g, 0m, 0k, 0b)', () => {
        expect(parse_memory_value('0g')).toBe(UNLIMITED);
        expect(parse_memory_value('0m')).toBe(UNLIMITED);
        expect(parse_memory_value('0k')).toBe(UNLIMITED);
        expect(parse_memory_value('0b')).toBe(UNLIMITED);
    });
});

describe('parse_cpus_value', () => {
    it('accepts integers and decimals', () => {
        expect(parse_cpus_value('2')).toBe('2');
        expect(parse_cpus_value('2.5')).toBe('2.5');
        expect(parse_cpus_value('0.5')).toBe('0.5');
    });

    it('returns UNLIMITED for "0"', () => {
        expect(parse_cpus_value('0')).toBe(UNLIMITED);
    });

    it('rejects negative decimal values (equals form) with --cpus in the message', () => {
        expect(() => parse_cpus_value('-1.0')).toThrow(/--cpus/);
    });

    it('rejects non-numeric values', () => {
        expect(() => parse_cpus_value('abc')).toThrow(/--cpus/);
    });

    it('returns UNLIMITED for zero-equivalent decimal (0.0)', () => {
        expect(parse_cpus_value('0.0')).toBe(UNLIMITED);
    });
});

describe('parse_pids_value', () => {
    it('accepts non-negative integers', () => {
        expect(parse_pids_value('1024')).toBe(1024);
        expect(parse_pids_value('1')).toBe(1);
    });

    it('returns UNLIMITED for "0"', () => {
        expect(parse_pids_value('0')).toBe(UNLIMITED);
    });

    it('rejects --pids-limit=-1 (equals form) with --pids-limit in the message', () => {
        expect(() => parse_pids_value('-1')).toThrow(/--pids-limit/);
    });

    it('rejects values greater than 2^31 - 1', () => {
        expect(() => parse_pids_value(String(2 ** 31))).toThrow(/--pids-limit/);
    });

    it('rejects decimal values', () => {
        expect(() => parse_pids_value('1024.5')).toThrow(/--pids-limit/);
    });

    it('returns UNLIMITED for zero-equivalent multi-zero (00)', () => {
        expect(parse_pids_value('00')).toBe(UNLIMITED);
    });
});

describe('parse_blkio_weight_value', () => {
    it('accepts integers in the [10, 1000] range', () => {
        expect(parse_blkio_weight_value('10')).toBe(10);
        expect(parse_blkio_weight_value('500')).toBe(500);
        expect(parse_blkio_weight_value('1000')).toBe(1000);
    });

    it('rejects --blkio-weight 5000 with the documented range in the message', () => {
        expect(() => parse_blkio_weight_value('5000')).toThrow(/\[10, 1000\]/);
        expect(() => parse_blkio_weight_value('5000')).toThrow(/--blkio-weight/);
    });

    it('rejects values below 10 (excluding 0)', () => {
        expect(() => parse_blkio_weight_value('1')).toThrow(/--blkio-weight/);
        expect(() => parse_blkio_weight_value('5')).toThrow(/--blkio-weight/);
        expect(() => parse_blkio_weight_value('9')).toThrow(/--blkio-weight/);
    });

    it('accepts 0 as the clear-limit sentinel', () => {
        expect(parse_blkio_weight_value('0')).toBe(0);
    });

    it('rejects --blkio-weight=-1 (equals form) with --blkio-weight in the message', () => {
        expect(() => parse_blkio_weight_value('-1')).toThrow(/--blkio-weight/);
    });

    it('rejects non-numeric values', () => {
        expect(() => parse_blkio_weight_value('abc')).toThrow(/--blkio-weight/);
    });
});
