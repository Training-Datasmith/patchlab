import { describe, it, expect, vi, afterEach } from 'vitest';

// `node:child_process` is mocked at module level so `detect_package_manager`
// can be exercised without invoking real podman. Tests that don't override
// the mock simply throw on any execFileSync call.
vi.mock('node:child_process', () => ({
    execFileSync: vi.fn(() => {
        throw new Error('execFileSync not configured for this test');
    }),
    spawn: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import {
    detect_package_manager,
    resolve_capability,
    reverse_map_package,
    generate_install_command,
    targets_php_source_image,
    php_extension_name,
    requires_php_source_installer,
    generate_php_extension_install_command,
} from '../../src/capabilities.js';

const mocked_execFileSync = vi.mocked(execFileSync);

interface Recorded_Call {
    file: string;
    arguments: string[];
}

/**
 * Build an execFileSync mock that:
 *   - Returns `label_value` (or throws) for `podman image inspect` calls
 *     against the capability label.
 *   - Succeeds on `podman create` / `podman start` (returning empty Buffer).
 *   - Succeeds on `podman exec ... test -f <path>` ONLY when the probed
 *     path is in `available_binaries`; throws otherwise.
 *   - Succeeds (or throws when `rm_throws` is set) on `podman rm -f`.
 * Records every call for assertion.
 */
function install_podman_probe_mock(options: {
    label_value: string | Error;
    available_binaries: string[];
    rm_throws?: boolean;
}): { calls: Recorded_Call[] } {
    const calls: Recorded_Call[] = [];
    const available = new Set(options.available_binaries);

    mocked_execFileSync.mockImplementation((file, args) => {
        if (file !== 'podman') {
            throw new Error(`unexpected execFileSync target: ${file}`);
        }
        const arguments_list = [...(args ?? [])] as string[];
        const arguments_set = new Set(arguments_list);
        calls.push({ file, arguments: arguments_list });

        if (arguments_set.has('image') && arguments_set.has('inspect')) {
            if (options.label_value instanceof Error) {
                throw options.label_value;
            }
            return Buffer.from(`${options.label_value}\n`);
        }

        if (arguments_list[0] === 'create' || arguments_list[0] === 'start') {
            return Buffer.from('');
        }

        if (arguments_list[0] === 'exec' && arguments_set.has('test')) {
            const probed_path = arguments_list.at(-1) ?? '';
            if (available.has(probed_path)) {
                return Buffer.from('');
            }
            throw new Error(`probe path missing: ${probed_path}`);
        }

        if (arguments_list[0] === 'rm') {
            if (options.rm_throws) {
                throw new Error('rm failed');
            }
            return Buffer.from('');
        }

        throw new Error(`unhandled podman invocation: ${arguments_list.join(' ')}`);
    });

    return { calls };
}

describe('capability resolution', () => {
    it('resolves postgres-client for apt', () => {
        expect(resolve_capability('postgres-client', 'apt')).toBe('postgresql-client');
    });

    it('resolves postgres-client for dnf', () => {
        expect(resolve_capability('postgres-client', 'dnf')).toBe('postgresql');
    });

    it('resolves postgres-client for apk', () => {
        expect(resolve_capability('postgres-client', 'apk')).toBe('postgresql-client');
    });

    it('resolves git identically across distros', () => {
        expect(resolve_capability('git', 'apt')).toBe('git');
        expect(resolve_capability('git', 'apk')).toBe('git');
        expect(resolve_capability('git', 'dnf')).toBe('git');
    });

    it('resolves sqlite to distro-specific names', () => {
        expect(resolve_capability('sqlite', 'apt')).toBe('sqlite3');
        expect(resolve_capability('sqlite', 'apk')).toBe('sqlite');
        expect(resolve_capability('sqlite', 'dnf')).toBe('sqlite');
    });

    it('resolves mysql-client to distro-specific names', () => {
        expect(resolve_capability('mysql-client', 'apt')).toBe('default-mysql-client');
        expect(resolve_capability('mysql-client', 'apk')).toBe('mysql-client');
        expect(resolve_capability('mysql-client', 'dnf')).toBe('mysql');
    });

    it('resolves redis-tools to distro-specific names', () => {
        expect(resolve_capability('redis-tools', 'apt')).toBe('redis-tools');
        expect(resolve_capability('redis-tools', 'apk')).toBe('redis');
        expect(resolve_capability('redis-tools', 'dnf')).toBe('redis');
    });

    it('resolves redis-server to distro-specific names', () => {
        expect(resolve_capability('redis-server', 'apt')).toBe('redis-server');
        expect(resolve_capability('redis-server', 'apk')).toBe('redis');
        expect(resolve_capability('redis-server', 'dnf')).toBe('redis');
    });

    it('resolves composer identically across distros', () => {
        expect(resolve_capability('composer', 'apt')).toBe('composer');
        expect(resolve_capability('composer', 'apk')).toBe('composer');
        expect(resolve_capability('composer', 'dnf')).toBe('composer');
    });

    it('returns null for unknown capability', () => {
        expect(resolve_capability('foo-bar', 'apt')).toBeNull();
    });

    it('returns null for unknown package manager', () => {
        expect(resolve_capability('git', 'unknown')).toBeNull();
    });
});

describe('reverse mapping', () => {
    it('maps apt package to capability', () => {
        expect(reverse_map_package('postgresql-client')).toBe('postgres-client');
    });

    it('maps dnf package to same capability', () => {
        expect(reverse_map_package('postgresql')).toBe('postgres-client');
    });

    it('maps sqlite3 (apt) to sqlite capability', () => {
        expect(reverse_map_package('sqlite3')).toBe('sqlite');
    });

    it('maps default-mysql-client (apt) to mysql-client capability', () => {
        expect(reverse_map_package('default-mysql-client')).toBe('mysql-client');
    });

    it('maps redis-server (apt) to redis-server capability', () => {
        expect(reverse_map_package('redis-server')).toBe('redis-server');
    });

    it('returns null for unknown package', () => {
        expect(reverse_map_package('some-obscure-package')).toBeNull();
    });

    it('handles packages that appear in multiple distros identically', () => {
        expect(reverse_map_package('git')).toBe('git');
        expect(reverse_map_package('curl')).toBe('curl');
        expect(reverse_map_package('jq')).toBe('jq');
    });
});

describe('install command generation', () => {
    it('generates apt install command with cleanup', () => {
        const command = generate_install_command(['postgres-client', 'curl'], 'apt');
        expect(command).toBe(
            'apt-get update && apt-get install -y --no-install-recommends postgresql-client curl && rm -rf /var/lib/apt/lists/*'
        );
    });

    it('generates apt command for single package', () => {
        const command = generate_install_command(['git'], 'apt');
        expect(command).toContain('git');
        expect(command).toContain('rm -rf /var/lib/apt/lists/*');
    });

    it('generates apk command for single package', () => {
        const command = generate_install_command(['git'], 'apk');
        expect(command).toBe('apk add --no-cache git');
    });

    it('generates apk command for multiple packages', () => {
        const command = generate_install_command(['git', 'jq'], 'apk');
        expect(command).toBe('apk add --no-cache git jq');
    });

    it('throws for dnf with clear message', () => {
        expect(() => generate_install_command(['git'], 'dnf')).toThrow(
            'Package manager dnf detected but not yet supported'
        );
    });

    it('throws for unknown package manager', () => {
        expect(() => generate_install_command(['git'], 'unknown')).toThrow(
            'Could not detect package manager'
        );
    });

    it('skips unknown capabilities and returns remaining', () => {
        const command = generate_install_command(['git', 'nonexistent', 'curl'], 'apt');
        expect(command).toContain('git');
        expect(command).toContain('curl');
        expect(command).not.toContain('nonexistent');
    });

    it('returns empty string when all capabilities are unknown', () => {
        const command = generate_install_command(['nonexistent'], 'apt');
        expect(command).toBe('');
    });

    it('returns empty string for empty capabilities list', () => {
        const command = generate_install_command([], 'apt');
        expect(command).toBe('');
    });
});

describe('install command deduplication', () => {
    it('emits each apt package only once when multiple capabilities map to the same package', () => {
        // php-ext-xml, php-ext-dom, php-ext-simplexml all resolve to php-xml
        const command = generate_install_command(
            ['php-ext-xml', 'php-ext-dom', 'php-ext-simplexml'],
            'apt',
        );
        const packages = command.split(' ');
        const php_xml_count = packages.filter((p) => p === 'php-xml').length;
        expect(php_xml_count).toBe(1);
    });

    it('deduplicates php-sqlite3 when both sqlite3 and pdo-sqlite capabilities are present', () => {
        const command = generate_install_command(
            ['php-ext-sqlite3', 'php-ext-pdo-sqlite'],
            'apt',
        );
        const packages = command.split(' ');
        const sqlite_count = packages.filter((p) => p === 'php-sqlite3').length;
        expect(sqlite_count).toBe(1);
    });

    it('preserves first-seen order after dedup', () => {
        const command = generate_install_command(['git', 'curl', 'git'], 'apt');
        expect(command).toBe(
            'apt-get update && apt-get install -y --no-install-recommends git curl && rm -rf /var/lib/apt/lists/*',
        );
    });
});

describe('requires_php_source_installer', () => {
    it('returns true for php-ext-* capabilities', () => {
        expect(requires_php_source_installer('php-ext-curl')).toBe(true);
        expect(requires_php_source_installer('php-ext-pdo-mysql')).toBe(true);
    });

    it('returns true for composer', () => {
        expect(requires_php_source_installer('composer')).toBe(true);
    });

    it('returns false for non-php-ext apt capabilities', () => {
        expect(requires_php_source_installer('git')).toBe(false);
        expect(requires_php_source_installer('redis-server')).toBe(false);
        expect(requires_php_source_installer('postgres-client')).toBe(false);
    });
});

describe('targets_php_source_image', () => {
    it('matches php:8.4-cli', () => {
        expect(targets_php_source_image('php:8.4-cli')).toBe(true);
    });

    it('matches php:8.3-cli', () => {
        expect(targets_php_source_image('php:8.3-cli')).toBe(true);
    });

    it('matches php with no tag', () => {
        expect(targets_php_source_image('php')).toBe(true);
    });

    it('matches docker.io/library/php:8.3-cli', () => {
        expect(targets_php_source_image('docker.io/library/php:8.3-cli')).toBe(true);
    });

    it('does not match node:22-slim', () => {
        expect(targets_php_source_image('node:22-slim')).toBe(false);
    });

    it('does not match phpmyadmin:latest', () => {
        expect(targets_php_source_image('phpmyadmin:latest')).toBe(false);
    });

    it('does not match my-php:latest (php is not the final segment)', () => {
        expect(targets_php_source_image('my-php:latest')).toBe(false);
    });

    it('does not match python:3.12-slim', () => {
        expect(targets_php_source_image('python:3.12-slim')).toBe(false);
    });
});

describe('php_extension_name', () => {
    it('strips php-ext- prefix', () => {
        expect(php_extension_name('php-ext-gd')).toBe('gd');
    });

    it('converts hyphens to underscores', () => {
        expect(php_extension_name('php-ext-pdo-mysql')).toBe('pdo_mysql');
    });

    it('converts pdo-sqlite to pdo_sqlite', () => {
        expect(php_extension_name('php-ext-pdo-sqlite')).toBe('pdo_sqlite');
    });

    it('leaves names with no hyphens after the prefix unchanged', () => {
        expect(php_extension_name('php-ext-intl')).toBe('intl');
    });
});

describe('generate_php_extension_install_command', () => {
    it('returns empty string for an empty list', () => {
        expect(generate_php_extension_install_command([])).toBe('');
    });

    it('returns install-php-extensions <name> for a single extension', () => {
        expect(generate_php_extension_install_command(['php-ext-gd'])).toBe(
            'install-php-extensions gd',
        );
    });

    it('converts capability names to extension names', () => {
        const command = generate_php_extension_install_command(['php-ext-pdo-mysql', 'php-ext-intl']);
        expect(command).toBe('install-php-extensions pdo_mysql intl');
    });

    it('deduplicates extension names when two capabilities map to the same name', () => {
        // php-ext-sqlite3 → sqlite3, php-ext-pdo-sqlite → pdo_sqlite (different names here),
        // but test an explicit duplicate path: two identical capabilities
        const command = generate_php_extension_install_command([
            'php-ext-gd',
            'php-ext-gd',
            'php-ext-intl',
        ]);
        const parts = command.replace('install-php-extensions ', '').split(' ');
        expect(parts.filter((p) => p === 'gd').length).toBe(1);
        expect(parts).toContain('intl');
    });

    it('preserves first-seen order', () => {
        const command = generate_php_extension_install_command([
            'php-ext-curl',
            'php-ext-mbstring',
            'php-ext-zip',
        ]);
        expect(command).toBe('install-php-extensions curl mbstring zip');
    });
});

describe('detect_package_manager (label inspect then binary probe)', () => {
    afterEach(() => {
        mocked_execFileSync.mockReset();
        mocked_execFileSync.mockImplementation(() => {
            throw new Error('execFileSync not configured for this test');
        });
    });

    it('returns the label value when image carries a recognized package_manager label', () => {
        install_podman_probe_mock({ label_value: 'apt', available_binaries: [] });

        expect(detect_package_manager('image:tag')).toBe('apt');
    });

    it('recognizes apk and dnf label values', () => {
        install_podman_probe_mock({ label_value: 'apk', available_binaries: [] });
        expect(detect_package_manager('image:tag')).toBe('apk');

        install_podman_probe_mock({ label_value: 'dnf', available_binaries: [] });
        expect(detect_package_manager('image:tag')).toBe('dnf');
    });

    it('falls through to binary detection when the label inspect throws', () => {
        install_podman_probe_mock({
            label_value: new Error('image has no labels'),
            available_binaries: ['/usr/bin/apt-get'],
        });

        expect(detect_package_manager('image:tag')).toBe('apt');
    });

    it('falls through to binary detection when the label is an unrecognized value', () => {
        install_podman_probe_mock({
            label_value: '<no value>',
            available_binaries: ['/sbin/apk'],
        });

        expect(detect_package_manager('image:tag')).toBe('apk');
    });

    it('probes binaries in declared order and returns the first match (apt-get → apt)', () => {
        install_podman_probe_mock({
            label_value: '<no value>',
            available_binaries: ['/usr/bin/apt-get', '/sbin/apk'],
        });

        expect(detect_package_manager('image:tag')).toBe('apt');
    });

    it('returns dnf when /usr/bin/dnf is present', () => {
        install_podman_probe_mock({
            label_value: '<no value>',
            available_binaries: ['/usr/bin/dnf'],
        });

        expect(detect_package_manager('image:tag')).toBe('dnf');
    });

    it('returns dnf when only /usr/bin/yum is present (legacy RPM-based image)', () => {
        install_podman_probe_mock({
            label_value: '<no value>',
            available_binaries: ['/usr/bin/yum'],
        });

        expect(detect_package_manager('image:tag')).toBe('dnf');
    });

    it('returns unknown when no package manager binary is found in the probe set', () => {
        install_podman_probe_mock({
            label_value: '<no value>',
            available_binaries: [],
        });

        expect(detect_package_manager('image:tag')).toBe('unknown');
    });

    it('invokes podman rm to clean up the probe container after detection', () => {
        const { calls } = install_podman_probe_mock({
            label_value: '<no value>',
            available_binaries: ['/usr/bin/apt-get'],
        });

        detect_package_manager('image:tag');

        const removal_calls = calls.filter((call) => call.arguments[0] === 'rm');
        expect(removal_calls.length).toBeGreaterThan(0);
    });

    it('swallows cleanup failure and still returns the detection result', () => {
        install_podman_probe_mock({
            label_value: '<no value>',
            available_binaries: ['/sbin/apk'],
            rm_throws: true,
        });

        expect(detect_package_manager('image:tag')).toBe('apk');
    });
});
