import { describe, it, expect } from 'vitest';
import { format_bytes } from '../../src/format.js';

describe('format_bytes', () => {
    it('renders bytes below 1 KiB without a decimal', () => {
        expect(format_bytes(0)).toBe('0 B');
        expect(format_bytes(1)).toBe('1 B');
        expect(format_bytes(1023)).toBe('1023 B');
    });

    it('renders exactly 1 KiB as "1.00 KiB"', () => {
        expect(format_bytes(1024)).toBe('1.00 KiB');
    });

    it('renders values in KiB, MiB, GiB, and TiB ranges', () => {
        expect(format_bytes(2048)).toBe('2.00 KiB');
        expect(format_bytes(1024 * 1024)).toBe('1.00 MiB');
        expect(format_bytes(1024 * 1024 * 1024)).toBe('1.00 GiB');
        expect(format_bytes(1024 * 1024 * 1024 * 1024)).toBe('1.00 TiB');
    });

    it('caps at TiB and does not introduce a new unit beyond TiB', () => {
        expect(format_bytes(1024 * 1024 * 1024 * 1024 * 1024)).toBe('1024.00 TiB');
    });

    it('rounds to two decimal places', () => {
        expect(format_bytes(1536)).toBe('1.50 KiB');
        expect(format_bytes(1.5 * 1024 * 1024)).toBe('1.50 MiB');
    });
});
