// Windows-only assertions for `parse_copy_specification` drive-letter paths.
// The drive-prefix branch in `src/cli_arguments.ts` only behaves correctly when
// `path.basename` and `path.resolve` treat `\` as a separator — true on win32,
// not on POSIX hosts. Self-gates on win32; no-ops on Linux/macOS runners.

import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parse_copy_specification } from '../../src/cli_arguments.js';

const IS_WINDOWS = process.platform === 'win32';
const describe_on_windows = describe.runIf(IS_WINDOWS);

describe_on_windows('parse_copy_specification — Windows drive-letter paths', () => {
    it('C:\\path\\file with no destination uses basename', () => {
        const result = parse_copy_specification(String.raw`C:\path\to\file.txt`);
        expect(result.destination).toBe('file.txt');
        expect(result.source_path).toBe(path.resolve(String.raw`C:\path\to\file.txt`));
    });

    it('C:\\path\\file:destination.txt uses explicit destination', () => {
        const result = parse_copy_specification(String.raw`C:\path\to\file.txt:destination.txt`);
        expect(result.destination).toBe('destination.txt');
        expect(result.source_path).toBe(path.resolve(String.raw`C:\path\to\file.txt`));
    });
});
