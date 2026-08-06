import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import { logger } from './logger.js';

/**
 * Set of package managers patchlab knows how to detect inside an image.
 *
 * **Widen-points checklist.** Adding a new value here (e.g., `'dnf'`) requires
 * lock-step updates in four places, otherwise configured-provider manifests
 * and the build pipeline will fall out of sync:
 *   1. This `Package_Manager` type
 *   2. The `generate_install_command` branch for the new value (below)
 *   3. `Image_Specification.get_base_preparation_lines`'s return type in
 *      `src/tools/types.ts` — broaden the `package_manager?: 'apt' | 'apk'`
 *      field's union
 *   4. `validate_package_manager` in `src/tools/configured_provider/validators.ts`
 *      AND the `package_manager` field constraint in
 *      `openspec/specs/configured-tool-provider/spec.md`
 */
export type Package_Manager = 'apt' | 'apk' | 'dnf' | 'unknown';

export interface Capability_Map {
    apt: string;
    apk: string;
    dnf: string;
}

// Canonical capability-to-package mapping table.
// Shared by both resolution (capability → package) and reverse mapping (package → capability).
const CAPABILITY_TABLE: Record<string, Capability_Map> = {
    'git':             { apt: 'git',                apk: 'git',               dnf: 'git' },
    'curl':            { apt: 'curl',               apk: 'curl',              dnf: 'curl' },
    'postgres-client': { apt: 'postgresql-client',  apk: 'postgresql-client', dnf: 'postgresql' },
    'redis-tools':     { apt: 'redis-tools',        apk: 'redis',             dnf: 'redis' },
    'redis-server':    { apt: 'redis-server',       apk: 'redis',             dnf: 'redis' },
    'composer':        { apt: 'composer',           apk: 'composer',          dnf: 'composer' },
    'mysql-client':    { apt: 'default-mysql-client', apk: 'mysql-client',    dnf: 'mysql' },
    'sqlite':          { apt: 'sqlite3',            apk: 'sqlite',            dnf: 'sqlite' },
    'jq':              { apt: 'jq',                 apk: 'jq',               dnf: 'jq' },
    'wget':            { apt: 'wget',               apk: 'wget',              dnf: 'wget' },
    'podman':          { apt: 'podman',              apk: 'podman',            dnf: 'podman' },
    'php-ext-bcmath':     { apt: 'php-bcmath',          apk: 'php83-bcmath',          dnf: 'php-bcmath' },
    'php-ext-curl':       { apt: 'php-curl',            apk: 'php83-curl',            dnf: 'php-curl' },
    'php-ext-dom':        { apt: 'php-xml',             apk: 'php83-dom',             dnf: 'php-xml' },
    'php-ext-fileinfo':   { apt: 'php-fileinfo',        apk: 'php83-fileinfo',        dnf: 'php-fileinfo' },
    'php-ext-gd':         { apt: 'php-gd',              apk: 'php83-gd',              dnf: 'php-gd' },
    'php-ext-gmp':        { apt: 'php-gmp',             apk: 'php83-gmp',             dnf: 'php-gmp' },
    'php-ext-imagick':    { apt: 'php-imagick',         apk: 'php83-pecl-imagick',    dnf: 'php-imagick' },
    'php-ext-imap':       { apt: 'php-imap',            apk: 'php83-imap',            dnf: 'php-imap' },
    'php-ext-intl':       { apt: 'php-intl',            apk: 'php83-intl',            dnf: 'php-intl' },
    'php-ext-ldap':       { apt: 'php-ldap',            apk: 'php83-ldap',            dnf: 'php-ldap' },
    'php-ext-mbstring':   { apt: 'php-mbstring',        apk: 'php83-mbstring',        dnf: 'php-mbstring' },
    'php-ext-memcached':  { apt: 'php-memcached',       apk: 'php83-pecl-memcached',  dnf: 'php-memcached' },
    'php-ext-pdo':        { apt: 'php-pdo',             apk: 'php83-pdo',             dnf: 'php-pdo' },
    'php-ext-pdo-mysql':  { apt: 'php-mysql',           apk: 'php83-pdo_mysql',       dnf: 'php-mysqlnd' },
    'php-ext-pdo-pgsql':  { apt: 'php-pgsql',           apk: 'php83-pdo_pgsql',       dnf: 'php-pgsql' },
    'php-ext-pdo-sqlite': { apt: 'php-sqlite3',         apk: 'php83-pdo_sqlite',      dnf: 'php-pdo' },
    'php-ext-redis':      { apt: 'php-redis',           apk: 'php83-redis',           dnf: 'php-redis' },
    'php-ext-simplexml':  { apt: 'php-xml',             apk: 'php83-simplexml',       dnf: 'php-xml' },
    'php-ext-soap':       { apt: 'php-soap',            apk: 'php83-soap',            dnf: 'php-soap' },
    'php-ext-sqlite3':    { apt: 'php-sqlite3',         apk: 'php83-sqlite3',         dnf: 'php-sqlite' },
    'php-ext-xsl':        { apt: 'php-xsl',             apk: 'php83-xsl',             dnf: 'php-xsl' },
    'php-ext-xml':        { apt: 'php-xml',             apk: 'php83-xml',             dnf: 'php-xml' },
    'php-ext-zip':        { apt: 'php-zip',             apk: 'php83-zip',             dnf: 'php-zip' },
};

// Reverse index: package name (from any distro) → capability name.
// Built once from CAPABILITY_TABLE.
const REVERSE_INDEX: Map<string, string> = new Map();
for (const [capability, packages] of Object.entries(CAPABILITY_TABLE)) {
    for (const package_name of [packages.apt, packages.apk, packages.dnf]) {
        if (!REVERSE_INDEX.has(package_name)) {
            REVERSE_INDEX.set(package_name, capability);
        }
    }
}

/** Detect the package manager in a container image. Checks cached label first, falls back to binary inspection. */
export function detect_package_manager(image: string): Package_Manager {
    // Check cached label first
    try {
        const result = execFileSync(
            'podman',
            ['image', 'inspect', '--format', '{{index .Labels "biz.ecartz.patchlab.package_manager"}}', image],
            { stdio: 'pipe' }
        ).toString('utf-8').trim();
        if (result === 'apt' || result === 'apk' || result === 'dnf') {
            return result;
        }
    } catch (_image_label_inspect_failed) {
        // No label or inspect failed, fall through to binary detection
    }

    // Disambiguate by pid + random suffix, not wall-clock alone: two probes
    // started in the same millisecond (concurrent builds) would otherwise share
    // a container name and cross-kill each other on removal.
    const container_name = `patchlab-detect-pm-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
    try {
        // This probe container is a short-lived build-side helper (created,
        // exec'd for `test -f`, removed) and is intentionally NOT subject to
        // the sandbox resource-limit feature: the spec scopes limits to the
        // sandbox containers produced by `patchlab create` and
        // `patchlab resume`. The probe runs `sleep infinity`, so its idle
        // resource footprint is negligible — applying caps here would add
        // failure modes without changing the practical behavior.
        execFileSync('podman', ['create', '--name', container_name, image, 'sleep', 'infinity'], { stdio: 'pipe' });
        execFileSync('podman', ['start', container_name], { stdio: 'pipe' });

        const checks: { path: string; result: Package_Manager }[] = [
            { path: '/usr/bin/apt-get', result: 'apt' },
            { path: '/sbin/apk',        result: 'apk' },
            { path: '/usr/bin/dnf',     result: 'dnf' },
            { path: '/usr/bin/yum',     result: 'dnf' },
        ];

        for (const check of checks) {
            try {
                execFileSync(
                    'podman',
                    ['exec', container_name, 'test', '-f', check.path],
                    { stdio: 'pipe' }
                );
                return check.result;
            } catch (_binary_missing) {
                // Binary not found, try next
            }
        }

        return 'unknown';
    } finally {
        try {
            execFileSync('podman', ['rm', '-f', container_name], { stdio: 'pipe' });
        } catch (_probe_container_already_gone) {
            // probe container may already be gone — podman prune will catch stragglers
        }
    }
}

/** Resolve a capability name to the distro-specific package name. Returns null for unknown capabilities. */
export function resolve_capability(capability: string, package_manager: Package_Manager): string | null {
    const entry = CAPABILITY_TABLE[capability];

    return (!entry || (package_manager === 'unknown')) ? null : entry[package_manager];
}

/** Reverse-map a raw package name (from any distro) to its capability name. Returns null for unknown packages. */
export function reverse_map_package(package_name: string): string | null {
    return REVERSE_INDEX.get(package_name) ?? null;
}

/** Generate a package install command for the given capabilities and package manager. */
export function generate_install_command(
    capabilities: string[],
    package_manager: Package_Manager
): string {
    if (package_manager === 'dnf') {
        throw new Error(
            'Package manager dnf detected but not yet supported. Use a Debian-based image or specify packages manually in .patchlab.json.'
        );
    }
    if (package_manager === 'unknown') {
        throw new Error(
            'Could not detect package manager for this image. Use a Debian-based image or specify packages manually in .patchlab.json.'
        );
    }

    const seen = new Set<string>();
    const resolved: string[] = [];
    for (const capability of capabilities) {
        const package_name = resolve_capability(capability, package_manager);
        if (!package_name) {
            logger().warn(`Warning: unknown capability '${capability}' — skipped`);
            continue;
        }

        if (seen.has(package_name)) {
            continue;
        }

        seen.add(package_name);
        resolved.push(package_name);
    }

    if (resolved.length === 0) {
        return '';
    }

    if (package_manager === 'apk') {
        // `--no-cache` is Alpine's idiomatic equivalent of the apt path's
        // trailing `rm -rf /var/lib/apt/lists/*` — avoids leaving package
        // metadata in the image layer.
        return `apk add --no-cache ${resolved.join(' ')}`;
    }

    return `apt-get update && apt-get install -y --no-install-recommends ${resolved.join(' ')} && rm -rf /var/lib/apt/lists/*`;
}

/**
 * Return true when `base_image` is an official `php:*` image (and thus uses
 * PHP built from source, requiring `install-php-extensions` rather than
 * distro `php-*` apt/apk packages to add extensions).
 *
 * Strips the tag suffix and any registry/path prefix before comparing the
 * final name segment to `'php'`, so `php:8.4-cli`,
 * `docker.io/library/php:8.3-cli`, and `php` all match, while
 * `phpmyadmin:latest`, `node:22-slim`, and `my-php:latest` do not.
 */
export function targets_php_source_image(base_image: string): boolean {
    // Remove the tag (everything after the last ':' that is not part of the host).
    // A simple heuristic: strip from the last ':' only when the remaining portion
    // contains at least one '/' (meaning it was <repo>:<tag>) or when the colon
    // is followed by a digit (plain `php:8.4-cli`).
    const colon_index = base_image.lastIndexOf(':');
    const repository = (colon_index === -1) ? base_image : base_image.slice(0, colon_index);

    // Strip registry host + path prefix; compare only the final path segment.
    const last_slash = repository.lastIndexOf('/');
    const name = (last_slash === -1) ? repository : repository.slice(last_slash + 1);

    return name === 'php';
}

/**
 * Derive the `install-php-extensions` argument for a `php-ext-*` capability.
 * Strips the `php-ext-` prefix and replaces hyphens with underscores to match
 * the extension names that `install-php-extensions` expects.
 *
 * Examples: `php-ext-pdo-mysql` → `pdo_mysql`, `php-ext-gd` → `gd`.
 */
export function php_extension_name(capability: string): string {
    return capability.slice('php-ext-'.length).replaceAll('-', '_');
}

// Non-php-ext-* capabilities that must go through install-php-extensions on a
// php:*-cli base, mapped to the helper argument they require.  `@composer`
// installs Composer without pulling in Debian's php-common package, which
// conflicts with the from-source PHP layout used by the official php:cli images.
const PHP_SOURCE_EXTRA_ARGS: Record<string, string> = {
    composer: '@composer',
};

/**
 * Return true when a capability must use the `install-php-extensions` helper
 * rather than the distro package manager on a `php:*-cli` base image.
 *
 * This covers both `php-ext-*` capabilities (PHP extensions) and plain
 * capabilities such as `composer` whose distro packages depend on `php-common`,
 * which conflicts with the from-source PHP in the official `php:cli` images.
 */
export function requires_php_source_installer(capability: string): boolean {
    return capability.startsWith('php-ext-') || Object.hasOwn(PHP_SOURCE_EXTRA_ARGS, capability);
}

function to_install_php_extensions_arg(capability: string): string {
    return capability.startsWith('php-ext-')
        ? php_extension_name(capability)
        : PHP_SOURCE_EXTRA_ARGS[capability] ?? capability;
}

/**
 * Generate the `install-php-extensions` install command for the given
 * capabilities that must be routed through the helper on a `php:*-cli` base.
 * Deduplicates argument names (first-seen order) and returns an empty string
 * when the list is empty.
 *
 * The `install-php-extensions` helper (mlocati/docker-php-extension-installer)
 * automatically skips extensions already bundled with `php:*-cli`, installs
 * required dev-libraries, handles pecl extensions transparently, and supports
 * `@`-prefixed specials such as `@composer`.
 */
export function generate_php_extension_install_command(php_extension_capabilities: string[]): string {
    const seen = new Set<string>();
    const extension_names: string[] = [];
    for (const capability of php_extension_capabilities) {
        const name = to_install_php_extensions_arg(capability);
        if (seen.has(name)) {
            continue;
        }

        seen.add(name);
        extension_names.push(name);
    }

    if (extension_names.length === 0) {
        return '';
    }

    return `install-php-extensions ${extension_names.join(' ')}`;
}
