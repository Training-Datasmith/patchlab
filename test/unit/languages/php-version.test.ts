import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('node:child_process', () => ({
    execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import {
    satisfies_php_constraint,
    resolve_php_image,
    resolve_php_version_from_lock,
    resolve_php_version_from_host,
    KNOWN_PHP_VERSIONS,
} from '../../../src/languages/php_version.js';

const mocked_exec_sync = vi.mocked(execSync);

describe('satisfies_php_constraint', () => {
    describe('caret (^)', () => {
        it('^8.2 satisfies 8.4 (highest in same major)', () => {
            expect(satisfies_php_constraint('8.4', '^8.2')).toBe(true);
        });

        it('^8.2 satisfies 8.2 (exact lower bound)', () => {
            expect(satisfies_php_constraint('8.2', '^8.2')).toBe(true);
        });

        it('^8.2 does not satisfy 8.1 (below lower bound)', () => {
            expect(satisfies_php_constraint('8.1', '^8.2')).toBe(false);
        });

        it('^8.2 does not satisfy 7.4 (different major)', () => {
            expect(satisfies_php_constraint('7.4', '^8.2')).toBe(false);
        });

        it('^8 (major-only) satisfies all 8.x versions', () => {
            expect(satisfies_php_constraint('8.4', '^8')).toBe(true);
            expect(satisfies_php_constraint('8.0', '^8')).toBe(true);
        });

        it('^8 (major-only) does not satisfy 7.4', () => {
            expect(satisfies_php_constraint('7.4', '^8')).toBe(false);
        });
    });

    describe('tilde (~)', () => {
        it('~8.2 satisfies 8.4 (same major, higher minor)', () => {
            expect(satisfies_php_constraint('8.4', '~8.2')).toBe(true);
        });

        it('~8.2 does not satisfy 8.1', () => {
            expect(satisfies_php_constraint('8.1', '~8.2')).toBe(false);
        });

        it('~8 (major-only) satisfies 8.3', () => {
            expect(satisfies_php_constraint('8.3', '~8')).toBe(true);
        });

        it('~8 (major-only) does not satisfy 7.4', () => {
            expect(satisfies_php_constraint('7.4', '~8')).toBe(false);
        });
    });

    describe('comparison operators', () => {
        it('>=8.1 satisfies 8.4', () => {
            expect(satisfies_php_constraint('8.4', '>=8.1')).toBe(true);
        });

        it('>=8.1 satisfies 8.1 (exact bound)', () => {
            expect(satisfies_php_constraint('8.1', '>=8.1')).toBe(true);
        });

        it('>=8.1 does not satisfy 8.0', () => {
            expect(satisfies_php_constraint('8.0', '>=8.1')).toBe(false);
        });

        it('>=8 (major-only) satisfies all 8.x', () => {
            expect(satisfies_php_constraint('8.3', '>=8')).toBe(true);
        });

        it('>8.1 satisfies 8.2', () => {
            expect(satisfies_php_constraint('8.2', '>8.1')).toBe(true);
        });

        it('>8.1 does not satisfy 8.1', () => {
            expect(satisfies_php_constraint('8.1', '>8.1')).toBe(false);
        });

        it('<9.0 satisfies 8.4', () => {
            expect(satisfies_php_constraint('8.4', '<9.0')).toBe(true);
        });

        it('<8.3 does not satisfy 8.3', () => {
            expect(satisfies_php_constraint('8.3', '<8.3')).toBe(false);
        });

        it('<8.3 does not satisfy 8.4', () => {
            expect(satisfies_php_constraint('8.4', '<8.3')).toBe(false);
        });

        it('<=8.2 satisfies 8.2', () => {
            expect(satisfies_php_constraint('8.2', '<=8.2')).toBe(true);
        });

        it('<=8.2 does not satisfy 8.3', () => {
            expect(satisfies_php_constraint('8.3', '<=8.2')).toBe(false);
        });

        it('<9 (major-only) satisfies 8.4', () => {
            expect(satisfies_php_constraint('8.4', '<9')).toBe(true);
        });

        it('<8 (major-only) does not satisfy 8.0', () => {
            expect(satisfies_php_constraint('8.0', '<8')).toBe(false);
        });
    });

    describe('wildcard and exact', () => {
        it('8.2.* satisfies only 8.2', () => {
            expect(satisfies_php_constraint('8.2', '8.2.*')).toBe(true);
            expect(satisfies_php_constraint('8.3', '8.2.*')).toBe(false);
            expect(satisfies_php_constraint('8.1', '8.2.*')).toBe(false);
        });

        it('7.4.* satisfies only 7.4', () => {
            expect(satisfies_php_constraint('7.4', '7.4.*')).toBe(true);
            expect(satisfies_php_constraint('8.0', '7.4.*')).toBe(false);
        });

        it('8.2 (exact) satisfies only 8.2', () => {
            expect(satisfies_php_constraint('8.2', '8.2')).toBe(true);
            expect(satisfies_php_constraint('8.3', '8.2')).toBe(false);
        });
    });

    describe('AND (space / comma)', () => {
        it('>=8.1 <9.0 satisfies 8.4 and 8.1', () => {
            expect(satisfies_php_constraint('8.4', '>=8.1 <9.0')).toBe(true);
            expect(satisfies_php_constraint('8.1', '>=8.1 <9.0')).toBe(true);
        });

        it('>=8.1 <9.0 does not satisfy 8.0 or 9.0', () => {
            expect(satisfies_php_constraint('8.0', '>=8.1 <9.0')).toBe(false);
        });

        it('>=7.4 <8.0 satisfies only 7.4', () => {
            expect(satisfies_php_constraint('7.4', '>=7.4 <8.0')).toBe(true);
            expect(satisfies_php_constraint('8.0', '>=7.4 <8.0')).toBe(false);
        });

        it('comma-separated AND behaves the same as space', () => {
            expect(satisfies_php_constraint('8.2', '>=8.1,<8.3')).toBe(true);
            expect(satisfies_php_constraint('8.3', '>=8.1,<8.3')).toBe(false);
        });
    });

    describe('OR (| / ||)', () => {
        it('7.4 || ^8.0 satisfies both 7.4 and 8.4', () => {
            expect(satisfies_php_constraint('7.4', '7.4 || ^8.0')).toBe(true);
            expect(satisfies_php_constraint('8.4', '7.4 || ^8.0')).toBe(true);
        });

        it('single-pipe OR also works', () => {
            expect(satisfies_php_constraint('8.4', '^7.4|^8.0')).toBe(true);
            expect(satisfies_php_constraint('7.4', '^7.4|^8.0')).toBe(true);
        });
    });

    describe('unknown operators', () => {
        it('unrecognised operator is treated as satisfied', () => {
            expect(satisfies_php_constraint('8.3', '?8.2')).toBe(true);
        });
    });
});

describe('KNOWN_PHP_VERSIONS ordering', () => {
    it('is sorted from highest to lowest', () => {
        const pairs = KNOWN_PHP_VERSIONS.slice(0, -1).map((v, i) => [v, KNOWN_PHP_VERSIONS[i + 1]] as const);
        for (const [higher, lower] of pairs) {
            const [hm, hn] = higher.split('.').map(Number);
            const [lm, ln] = lower.split('.').map(Number);
            const higher_wins = hm > lm || (hm === lm && hn > ln);
            expect(higher_wins, `${higher} should be above ${lower}`).toBe(true);
        }
    });
});

describe('resolve_php_version_from_lock', () => {
    let temporary_directory: string;

    beforeEach(() => {
        temporary_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-lock-'));
    });

    afterEach(() => {
        fs.rmSync(temporary_directory, { recursive: true, force: true });
    });

    function write_lock(content: object): void {
        fs.writeFileSync(
            path.join(temporary_directory, 'composer.lock'),
            JSON.stringify(content),
        );
    }

    it('returns null when composer.lock is absent', () => {
        expect(resolve_php_version_from_lock(temporary_directory)).toBeNull();
    });

    it('returns null when composer.lock is malformed JSON', () => {
        fs.writeFileSync(path.join(temporary_directory, 'composer.lock'), '{ not json }');
        expect(resolve_php_version_from_lock(temporary_directory)).toBeNull();
    });

    it('returns null when platform key is absent', () => {
        write_lock({ packages: [] });
        expect(resolve_php_version_from_lock(temporary_directory)).toBeNull();
    });

    it('returns null when platform.php is absent', () => {
        write_lock({ platform: { 'ext-curl': '*' } });
        expect(resolve_php_version_from_lock(temporary_directory)).toBeNull();
    });

    it('returns null when platform.php is a number (non-string)', () => {
        write_lock({ platform: { php: 8 } });
        expect(resolve_php_version_from_lock(temporary_directory)).toBeNull();
    });

    it('returns null when platform.php is null (non-string)', () => {
        write_lock({ platform: { php: null } });
        expect(resolve_php_version_from_lock(temporary_directory)).toBeNull();
    });

    it('returns null when platform.php is major-only (no minor)', () => {
        write_lock({ platform: { php: '8' } });
        expect(resolve_php_version_from_lock(temporary_directory)).toBeNull();
    });

    it('returns null when platform.php is an unrecognisable string', () => {
        write_lock({ platform: { php: 'latest' } });
        expect(resolve_php_version_from_lock(temporary_directory)).toBeNull();
    });

    it('returns php:8.1-cli for platform.php "8.1.27"', () => {
        write_lock({ platform: { php: '8.1.27' } });
        expect(resolve_php_version_from_lock(temporary_directory)).toBe('php:8.1-cli');
    });

    it('returns php:8.3-cli for platform.php "8.3.0"', () => {
        write_lock({ platform: { php: '8.3.0' } });
        expect(resolve_php_version_from_lock(temporary_directory)).toBe('php:8.3-cli');
    });

    it('returns php:7.4-cli for platform.php "7.4.33"', () => {
        write_lock({ platform: { php: '7.4.33' } });
        expect(resolve_php_version_from_lock(temporary_directory)).toBe('php:7.4-cli');
    });

    it('accepts major.minor without patch component', () => {
        write_lock({ platform: { php: '8.2' } });
        expect(resolve_php_version_from_lock(temporary_directory)).toBe('php:8.2-cli');
    });
});

describe('resolve_php_version_from_host', () => {
    beforeEach(() => {
        mocked_exec_sync.mockReset();
    });

    it('returns php:8.3-cli when php --version outputs PHP 8.3.6', () => {
        mocked_exec_sync.mockReturnValueOnce('PHP 8.3.6 (cli) (built: Jan  1 2024)\n');
        expect(resolve_php_version_from_host()).toBe('php:8.3-cli');
    });

    it('returns php:8.1-cli when php --version outputs PHP 8.1.0', () => {
        mocked_exec_sync.mockReturnValueOnce('PHP 8.1.0 (cli)\n');
        expect(resolve_php_version_from_host()).toBe('php:8.1-cli');
    });

    it('returns null when execSync throws (php not on PATH)', () => {
        mocked_exec_sync.mockImplementationOnce(() => { throw new Error('ENOENT'); });
        expect(resolve_php_version_from_host()).toBeNull();
    });

    it('returns null when php --version output does not match pattern', () => {
        mocked_exec_sync.mockReturnValueOnce('Zend PHP 8.0.0\n');
        expect(resolve_php_version_from_host()).toBeNull();
    });

    it('does not throw on any execSync error', () => {
        mocked_exec_sync.mockImplementationOnce(() => { throw new Error('unknown error'); });
        expect(() => resolve_php_version_from_host()).not.toThrow();
    });
});

describe('resolve_php_image', () => {
    let temporary_directory: string;

    beforeEach(() => {
        temporary_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-php-version-'));
        // Default: host PHP not available (no lock file, no host PHP → fall through to composer.json)
        mocked_exec_sync.mockReset();
        mocked_exec_sync.mockImplementation(() => { throw new Error('ENOENT'); });
    });

    afterEach(() => {
        fs.rmSync(temporary_directory, { recursive: true, force: true });
    });

    function write_composer(content: object): void {
        fs.writeFileSync(path.join(temporary_directory, 'composer.json'), JSON.stringify(content));
    }

    function write_lock(content: object): void {
        fs.writeFileSync(
            path.join(temporary_directory, 'composer.lock'),
            JSON.stringify(content),
        );
    }

    it('returns null when composer.json is absent', () => {
        expect(resolve_php_image(temporary_directory)).toBeNull();
    });

    it('returns null when composer.json is malformed', () => {
        fs.writeFileSync(path.join(temporary_directory, 'composer.json'), '{ not json }');
        expect(resolve_php_image(temporary_directory)).toBeNull();
    });

    it('returns null when require.php is absent', () => {
        write_composer({ require: { 'ext-curl': '*' } });
        expect(resolve_php_image(temporary_directory)).toBeNull();
    });

    it('returns null when no known version satisfies the constraint', () => {
        write_composer({ require: { php: '<7.0' } });
        expect(resolve_php_image(temporary_directory)).toBeNull();
    });

    it('returns highest satisfying version for ^8.2', () => {
        write_composer({ require: { php: '^8.2' } });
        expect(resolve_php_image(temporary_directory)).toBe('php:8.4-cli');
    });

    it('returns highest satisfying version for ^8.1', () => {
        write_composer({ require: { php: '^8.1' } });
        expect(resolve_php_image(temporary_directory)).toBe('php:8.4-cli');
    });

    it('returns 7.4 for a 7.4-pinned constraint', () => {
        write_composer({ require: { php: '>=7.4 <8.0' } });
        expect(resolve_php_image(temporary_directory)).toBe('php:7.4-cli');
    });

    it('returns the exact version for a wildcard pin', () => {
        write_composer({ require: { php: '8.2.*' } });
        expect(resolve_php_image(temporary_directory)).toBe('php:8.2-cli');
    });

    it('lock file platform.php takes priority over composer.json constraint', () => {
        write_lock({ platform: { php: '8.1.27' } });
        write_composer({ require: { php: '>=8.0' } });
        // Lock says 8.1; composer.json would give 8.4 — lock wins
        expect(resolve_php_image(temporary_directory)).toBe('php:8.1-cli');
    });

    it('lock file platform.php takes priority over host PHP', () => {
        write_lock({ platform: { php: '8.0.0' } });
        mocked_exec_sync.mockReturnValueOnce('PHP 8.3.6 (cli)\n');
        expect(resolve_php_image(temporary_directory)).toBe('php:8.0-cli');
    });

    it('host PHP used when composer.lock is absent and composer.json present', () => {
        write_composer({ require: { php: '>=7.4' } });
        mocked_exec_sync.mockReturnValueOnce('PHP 8.2.0 (cli)\n');
        expect(resolve_php_image(temporary_directory)).toBe('php:8.2-cli');
    });

    it('falls through to composer.json when lock has no usable platform.php and no host PHP', () => {
        write_lock({ packages: [] });
        write_composer({ require: { php: '^8.1' } });
        // execSync already mocked to throw → host PHP returns null → falls to constraint
        expect(resolve_php_image(temporary_directory)).toBe('php:8.4-cli');
    });

    it('falls through to composer.json when lock platform.php is non-string', () => {
        write_lock({ platform: { php: 8 } });
        write_composer({ require: { php: '^8.2' } });
        expect(resolve_php_image(temporary_directory)).toBe('php:8.4-cli');
    });
});
