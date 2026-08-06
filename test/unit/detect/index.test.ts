import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { detect_requirements } from '../../../src/detect/index.js';
import { assert_present } from '../../helpers/assert_present.js';

describe('dependency detection', () => {
    let temporary_directory: string;

    beforeEach(() => {
        temporary_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-detect-'));
    });

    afterEach(() => {
        fs.rmSync(temporary_directory, { recursive: true, force: true });
    });

    function write(relative_path: string, content: string): void {
        const full = path.join(temporary_directory, relative_path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }

    describe('source code detector', () => {
        it('detects podman execFileSync calls', () => {
            write('src/runner.ts', "import { execFileSync } from 'node:child_process';\nexecFileSync('podman', ['run']);\n");
            const result = detect_requirements(temporary_directory);
            expect(result.volume_mounts).toHaveLength(1);
            expect(result.volume_mounts[0].host_path).toContain('podman.sock');
            expect(result.volume_mounts[0].source).toBe('source_code');
        });

        it('detects docker spawn calls', () => {
            write('test/e2e.ts', "spawn('docker', ['build']);\n");
            const result = detect_requirements(temporary_directory);
            expect(result.volume_mounts).toHaveLength(1);
        });

        it('returns empty for projects without container calls', () => {
            write('src/index.ts', "console.log('hello');\n");
            const result = detect_requirements(temporary_directory);
            expect(result.volume_mounts).toHaveLength(0);
        });

        it('scans scripts/ directory', () => {
            write('scripts/deploy.ts', "execFileSync('podman', ['push']);\n");
            const result = detect_requirements(temporary_directory);
            expect(result.volume_mounts).toHaveLength(1);
        });
    });

    describe('CI configuration detector', () => {
        it('extracts package installs from workflow', () => {
            write('.github/workflows/test.yml', `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: apt-get update && apt-get install -y postgresql-client curl
`);
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'postgres-client')).toBe(true);
            expect(result.system_packages.some((p) => p.capability === 'curl')).toBe(true);
        });

        it('extracts services from workflow', () => {
            write('.github/workflows/test.yml', `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
      redis:
        image: redis:7
    steps:
      - run: echo hello
`);
            const result = detect_requirements(temporary_directory);
            expect(result.services.some((s) => s.name === 'postgres')).toBe(true);
            expect(result.services.some((s) => s.name === 'redis')).toBe(true);
        });

        it('extracts environment variables from workflow', () => {
            write('.github/workflows/test.yml', `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      DATABASE_URL: postgres://localhost/test
    steps:
      - run: echo hello
`);
            const result = detect_requirements(temporary_directory);
            expect(result.environment_variables.some((e) => e.key === 'DATABASE_URL')).toBe(true);
        });

        it('skips malformed YAML', () => {
            write('.github/workflows/broken.yml', ': : : not valid yaml [[[');
            const result = detect_requirements(temporary_directory);
            // Should not throw, just skip
            expect(result).toBeDefined();
        });

        it('emits pdo-mysql package when CI job env sets DB_CONNECTION=mysql', () => {
            write('.github/workflows/test.yml', `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      DB_CONNECTION: mysql
    steps:
      - run: echo hello
`);
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-pdo-mysql')).toBe(true);
        });

        it('emits pdo-pgsql package when CI step env sets DB_CONNECTION=pgsql', () => {
            write('.github/workflows/test.yml', `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
        env:
          DB_CONNECTION: pgsql
`);
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-pdo-pgsql')).toBe(true);
        });

        it('emits pdo-sqlite and sqlite3 when CI job env sets DB_CONNECTION=sqlite', () => {
            write('.github/workflows/test.yml', `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      DB_CONNECTION: sqlite
    steps:
      - run: echo hello
`);
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-pdo-sqlite')).toBe(true);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-sqlite3')).toBe(true);
        });

        it('uses ci_configuration as source for CI-detected DB packages', () => {
            write('.github/workflows/test.yml', `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      DB_CONNECTION: mysql
    steps:
      - run: echo hello
`);
            const result = detect_requirements(temporary_directory);
            const pdo_mysql = result.system_packages.find((p) => p.capability === 'php-ext-pdo-mysql');
            expect(pdo_mysql?.source).toBe('ci_configuration');
        });

        it('ignores unknown DB_CONNECTION values in CI env', () => {
            write('.github/workflows/test.yml', `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      DB_CONNECTION: firebird
    steps:
      - run: echo hello
`);
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.filter((p) => p.capability.startsWith('php-ext-pdo'))).toHaveLength(0);
        });

        it('installs both mysql and sqlite extensions when CI sets mysql and phpunit.xml sets sqlite', () => {
            write('.github/workflows/test.yml', `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      DB_CONNECTION: mysql
    steps:
      - run: echo hello
`);
            write('phpunit.xml', `<phpunit><php><env name="DB_CONNECTION" value="sqlite"/></php></phpunit>`);
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-pdo-mysql')).toBe(true);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-pdo-sqlite')).toBe(true);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-sqlite3')).toBe(true);
        });
    });

    describe('docker-compose detector', () => {
        it('detects services from docker-compose.yml', () => {
            write('docker-compose.yml', `
services:
  db:
    image: postgres:15
  cache:
    image: redis:7
`);
            const result = detect_requirements(temporary_directory);
            expect(result.services.some((s) => s.name === 'db')).toBe(true);
            expect(result.services.some((s) => s.name === 'cache')).toBe(true);
        });

        it('detects services from compose.yml', () => {
            write('compose.yml', `
services:
  api:
    image: node:22
`);
            const result = detect_requirements(temporary_directory);
            expect(result.services.some((s) => s.name === 'api')).toBe(true);
        });

        it('extracts environment variables', () => {
            write('docker-compose.yml', `
services:
  db:
    image: postgres:15
    environment:
      POSTGRES_DB: test
      POSTGRES_USER: admin
`);
            const result = detect_requirements(temporary_directory);
            expect(result.environment_variables.some((e) => e.key === 'POSTGRES_DB')).toBe(true);
        });

        it('handles array-style environment variables', () => {
            write('docker-compose.yml', `
services:
  db:
    image: postgres:15
    environment:
      - POSTGRES_DB=test
      - POSTGRES_USER=admin
`);
            const result = detect_requirements(temporary_directory);
            expect(result.environment_variables.some((e) => e.key === 'POSTGRES_DB' && e.value === 'test')).toBe(true);
        });
    });

    describe('devDependencies detector', () => {
        it('detects testcontainers', () => {
            write('package.json', JSON.stringify({
                devDependencies: { '@testcontainers/postgresql': '^10.0.0' },
            }));
            const result = detect_requirements(temporary_directory);
            expect(result.volume_mounts.some((m) => m.host_path.includes('podman.sock'))).toBe(true);
            expect(result.volume_mounts[0].source).toBe('dev_dependencies');
        });

        it('ignores non-infrastructure packages', () => {
            write('package.json', JSON.stringify({
                devDependencies: { vitest: '^1.0.0', typescript: '^5.0.0' },
            }));
            const result = detect_requirements(temporary_directory);
            expect(result.volume_mounts).toHaveLength(0);
        });
    });

    describe('test scripts detector', () => {
        it('detects podman in package.json scripts', () => {
            write('package.json', JSON.stringify({
                scripts: { test: 'podman run test-image npm test' },
            }));
            const result = detect_requirements(temporary_directory);
            expect(result.volume_mounts.some((m) => m.host_path.includes('podman.sock'))).toBe(true);
        });

        it('detects psql in Makefile', () => {
            write('Makefile', 'test:\n\tpsql -c "SELECT 1"\n');
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'postgres-client')).toBe(true);
        });
    });

    describe('configuration file detector', () => {
        it('extracts environment variables from .env.test', () => {
            write('.env.test', 'DATABASE_URL=postgres://localhost/test\nREDIS_URL=redis://localhost\n');
            const result = detect_requirements(temporary_directory);
            expect(result.environment_variables.some((e) => e.key === 'DATABASE_URL')).toBe(true);
            expect(result.environment_variables.some((e) => e.key === 'REDIS_URL')).toBe(true);
            expect(result.environment_variables[0].source).toBe('configuration_files');
        });

        it('ignores comments and blank lines', () => {
            write('.env.test', '# This is a comment\n\nDATABASE_URL=test\n');
            const result = detect_requirements(temporary_directory);
            expect(result.environment_variables).toHaveLength(1);
        });
    });

    describe('pipeline merging', () => {
        it('deduplicates system packages', () => {
            // CI and test scripts both detect postgres-client
            write('.github/workflows/test.yml', `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: apt-get install -y postgresql-client
`);
            write('Makefile', 'test:\n\tpsql -c "SELECT 1"\n');
            const result = detect_requirements(temporary_directory);
            const postgres = result.system_packages.filter((p) => p.capability === 'postgres-client');
            expect(postgres).toHaveLength(1);
        });

        it('deduplicates volume mounts', () => {
            // Source code and devDeps both detect socket mount
            write('src/runner.ts', "execFileSync('podman', ['run']);\n");
            write('package.json', JSON.stringify({
                devDependencies: { testcontainers: '^10.0.0' },
            }));
            const result = detect_requirements(temporary_directory);
            const mounts = result.volume_mounts.filter((m) => m.host_path.includes('podman.sock'));
            expect(mounts).toHaveLength(1);
        });

        it('first detector wins for environment variable conflicts', () => {
            // CI config (higher priority) and .env.test (lower priority) both set DATABASE_URL
            write('.github/workflows/test.yml', `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      DATABASE_URL: postgres://ci/test
    steps:
      - run: echo test
`);
            write('.env.test', 'DATABASE_URL=postgres://localhost/dev\n');
            const result = detect_requirements(temporary_directory);
            const db_url = result.environment_variables.find((e) => e.key === 'DATABASE_URL');
            assert_present(db_url);
            expect(db_url.value).toBe('postgres://ci/test');
            expect(db_url.source).toBe('ci_configuration');
        });

        it('no conflict when values match', () => {
            write('.github/workflows/test.yml', `
name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      DATABASE_URL: postgres://localhost/test
    steps:
      - run: echo test
`);
            write('.env.test', 'DATABASE_URL=postgres://localhost/test\n');
            const result = detect_requirements(temporary_directory);
            const db_urls = result.environment_variables.filter((e) => e.key === 'DATABASE_URL');
            expect(db_urls).toHaveLength(1);
        });
    });

    describe('error isolation', () => {
        it('continues when a detector fails', () => {
            // Write valid .env.test but broken CI YAML
            write('.github/workflows/test.yml', ': : : not valid yaml [[[');
            write('.env.test', 'API_KEY=test123\n');
            const result = detect_requirements(temporary_directory);
            // Config file detector should still work
            expect(result.environment_variables.some((e) => e.key === 'API_KEY')).toBe(true);
        });
    });

    describe('PHP extensions detector', () => {
        it('detects mbstring and curl from composer.json require', () => {
            write('composer.json', JSON.stringify({
                require: { php: '^8.3', 'ext-mbstring': '*', 'ext-curl': '*' },
            }));
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-mbstring')).toBe(true);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-curl')).toBe(true);
        });

        it('detects extensions from require-dev', () => {
            write('composer.json', JSON.stringify({
                require: { php: '^8.3' },
                'require-dev': { 'ext-gmp': '*' },
            }));
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-gmp')).toBe(true);
        });

        it('deduplicates extensions that appear in both require and require-dev', () => {
            write('composer.json', JSON.stringify({
                require: { 'ext-mbstring': '*' },
                'require-dev': { 'ext-mbstring': '*' },
            }));
            const result = detect_requirements(temporary_directory);
            const mbstring = result.system_packages.filter((p) => p.capability === 'php-ext-mbstring');
            expect(mbstring).toHaveLength(1);
        });

        it('detects ext-fileinfo', () => {
            write('composer.json', JSON.stringify({
                require: { 'ext-fileinfo': '*' },
            }));
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-fileinfo')).toBe(true);
        });

        it('maps pdo_mysql with underscores to php-ext-pdo-mysql', () => {
            write('composer.json', JSON.stringify({
                require: { 'ext-pdo_mysql': '*' },
            }));
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-pdo-mysql')).toBe(true);
        });

        it('uses package_manifest as source', () => {
            write('composer.json', JSON.stringify({
                require: { 'ext-mbstring': '*' },
            }));
            const result = detect_requirements(temporary_directory);
            const mbstring = result.system_packages.find((p) => p.capability === 'php-ext-mbstring');
            expect(mbstring?.source).toBe('package_manifest');
        });

        it('emits capabilities for built-in extensions not in the apt table', () => {
            write('composer.json', JSON.stringify({
                require: { 'ext-json': '*', 'ext-tokenizer': '*', 'ext-pcre': '*' },
            }));
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-json')).toBe(true);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-pcre')).toBe(true);
        });

        it('ignores non-extension composer dependencies', () => {
            write('composer.json', JSON.stringify({
                require: { php: '^8.3', 'symfony/framework-bundle': '^7.0' },
            }));
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability.startsWith('php-ext-'))).toBe(false);
        });

        it('emits a capability for extensions not in the apt table', () => {
            write('composer.json', JSON.stringify({
                require: { 'ext-ftp': '*' },
            }));
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-ftp')).toBe(true);
        });

        it('handles malformed composer.json without throwing', () => {
            write('composer.json', '{ not valid json }');
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability.startsWith('php-ext-'))).toBe(false);
        });

        it('detects ext-gd from composer.json suggest by default', () => {
            write('composer.json', JSON.stringify({
                suggest: { 'ext-gd': 'For image manipulation' },
            }));
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-gd')).toBe(true);
        });

        it('skips suggest section when exclude_suggested_extensions is set', () => {
            write('composer.json', JSON.stringify({
                suggest: { 'ext-gd': 'For image manipulation' },
            }));
            const result = detect_requirements(temporary_directory, { exclude_suggested_extensions: true });
            expect(result.system_packages.some((p) => p.capability === 'php-ext-gd')).toBe(false);
        });

        it('deduplicates extensions that appear in both require and suggest', () => {
            write('composer.json', JSON.stringify({
                require: { 'ext-mbstring': '*' },
                suggest: { 'ext-mbstring': 'Already required' },
            }));
            const result = detect_requirements(temporary_directory);
            const mbstring = result.system_packages.filter((p) => p.capability === 'php-ext-mbstring');
            expect(mbstring).toHaveLength(1);
        });
    });

    describe('PHP lock extensions detector', () => {
        it('detects an extension required by a transitive dependency in packages', () => {
            write('composer.lock', JSON.stringify({
                packages: [
                    { name: 'vendor/some-lib', require: { 'ext-mbstring': '*', php: '^8.0' } },
                ],
                'packages-dev': [],
            }));
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-mbstring')).toBe(true);
        });

        it('detects extensions from packages-dev', () => {
            write('composer.lock', JSON.stringify({
                packages: [],
                'packages-dev': [
                    { name: 'vendor/test-helper', require: { 'ext-gd': '*' } },
                ],
            }));
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-gd')).toBe(true);
        });

        it('uses package_manifest as source', () => {
            write('composer.lock', JSON.stringify({
                packages: [
                    { name: 'vendor/some-lib', require: { 'ext-curl': '*' } },
                ],
                'packages-dev': [],
            }));
            const result = detect_requirements(temporary_directory);
            const curl = result.system_packages.find((p) => p.capability === 'php-ext-curl');
            expect(curl?.source).toBe('package_manifest');
        });

        it('deduplicates extensions required by multiple transitive packages', () => {
            write('composer.lock', JSON.stringify({
                packages: [
                    { name: 'vendor/a', require: { 'ext-mbstring': '*' } },
                    { name: 'vendor/b', require: { 'ext-mbstring': '^1.0' } },
                ],
                'packages-dev': [],
            }));
            const result = detect_requirements(temporary_directory);
            const mbstring = result.system_packages.filter((p) => p.capability === 'php-ext-mbstring');
            expect(mbstring).toHaveLength(1);
        });

        it('deduplicates extensions already declared in composer.json', () => {
            write('composer.json', JSON.stringify({
                require: { 'ext-mbstring': '*' },
            }));
            write('composer.lock', JSON.stringify({
                packages: [
                    { name: 'vendor/some-lib', require: { 'ext-mbstring': '*' } },
                ],
                'packages-dev': [],
            }));
            const result = detect_requirements(temporary_directory);
            const mbstring = result.system_packages.filter((p) => p.capability === 'php-ext-mbstring');
            expect(mbstring).toHaveLength(1);
        });

        it('maps pdo_sqlite with underscores to php-ext-pdo-sqlite', () => {
            write('composer.lock', JSON.stringify({
                packages: [
                    { name: 'vendor/orm', require: { 'ext-pdo_sqlite': '*' } },
                ],
                'packages-dev': [],
            }));
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-pdo-sqlite')).toBe(true);
        });

        it('ignores non-extension keys like php and package names', () => {
            write('composer.lock', JSON.stringify({
                packages: [
                    { name: 'vendor/some-lib', require: { php: '>=8.0', 'symfony/console': '^6.0' } },
                ],
                'packages-dev': [],
            }));
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages).toHaveLength(0);
        });

        it('emits a capability for extensions not in the apt table', () => {
            write('composer.lock', JSON.stringify({
                packages: [
                    { name: 'league/flysystem-ftp', require: { 'ext-ftp': '*' } },
                ],
                'packages-dev': [],
            }));
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-ftp')).toBe(true);
        });

        it('returns empty when composer.lock is absent', () => {
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages).toHaveLength(0);
        });

        it('returns empty when composer.lock is malformed JSON', () => {
            write('composer.lock', '{ not valid json }');
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages).toHaveLength(0);
        });

        it('tolerates package entries with no require field', () => {
            write('composer.lock', JSON.stringify({
                packages: [
                    { name: 'vendor/no-require' },
                    { name: 'vendor/with-require', require: { 'ext-curl': '*' } },
                ],
                'packages-dev': [],
            }));
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-curl')).toBe(true);
        });
    });

    describe('composer detector', () => {
        it('emits composer capability when composer.json is present', () => {
            write('composer.json', JSON.stringify({ require: {} }));
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'composer')).toBe(true);
        });

        it('uses package_manifest as source', () => {
            write('composer.json', JSON.stringify({ require: {} }));
            const result = detect_requirements(temporary_directory);
            const entry = result.system_packages.find((p) => p.capability === 'composer');
            expect(entry?.source).toBe('package_manifest');
        });

        it('returns no composer requirement when composer.json is absent', () => {
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'composer')).toBe(false);
        });

        it('emits composer exactly once when both composer.json and composer.lock are present', () => {
            write('composer.json', JSON.stringify({ require: {} }));
            write('composer.lock', JSON.stringify({ packages: [], 'packages-dev': [] }));
            const result = detect_requirements(temporary_directory);
            const entries = result.system_packages.filter((p) => p.capability === 'composer');
            expect(entries).toHaveLength(1);
        });
    });

    describe('PHP test configuration detector', () => {
        it('maps DB_CONNECTION=sqlite in phpunit.xml to pdo-sqlite and sqlite3', () => {
            write('phpunit.xml', `<?xml version="1.0" encoding="UTF-8"?>
<phpunit>
  <php>
    <env name="DB_CONNECTION" value="sqlite"/>
  </php>
</phpunit>`);
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-pdo-sqlite')).toBe(true);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-sqlite3')).toBe(true);
        });

        it('reads phpunit.xml.dist when phpunit.xml is absent', () => {
            write('phpunit.xml.dist', `<?xml version="1.0" encoding="UTF-8"?>
<phpunit>
  <php>
    <env name="DB_CONNECTION" value="sqlite"/>
  </php>
</phpunit>`);
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-pdo-sqlite')).toBe(true);
        });

        it('maps DB_CONNECTION=mysql in .env to pdo-mysql', () => {
            write('.env', 'DB_CONNECTION=mysql\n');
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-pdo-mysql')).toBe(true);
        });

        it('maps DB_CONNECTION=mariadb in .env to pdo-mysql', () => {
            write('.env', 'DB_CONNECTION=mariadb\n');
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-pdo-mysql')).toBe(true);
        });

        it('maps DB_CONNECTION=pgsql in .env.testing to pdo-pgsql', () => {
            write('.env.testing', 'DB_CONNECTION=pgsql\n');
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-pdo-pgsql')).toBe(true);
        });

        it('phpunit.xml takes priority over .env when both declare DB_CONNECTION', () => {
            write('phpunit.xml', `<phpunit><php><env name="DB_CONNECTION" value="sqlite"/></php></phpunit>`);
            write('.env', 'DB_CONNECTION=mysql\n');
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-pdo-sqlite')).toBe(true);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-pdo-mysql')).toBe(false);
        });

        it('handles value attribute before name attribute', () => {
            write('phpunit.xml', `<phpunit><php><env value="sqlite" name="DB_CONNECTION"/></php></phpunit>`);
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-pdo-sqlite')).toBe(true);
        });

        it('maps DB_CONNECTION=testing to pdo-sqlite and sqlite3 (Laravel/testbench convention)', () => {
            write('phpunit.xml', `<phpunit><php><env name="DB_CONNECTION" value="testing"/></php></phpunit>`);
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-pdo-sqlite')).toBe(true);
            expect(result.system_packages.some((p) => p.capability === 'php-ext-sqlite3')).toBe(true);
        });

        it('ignores unknown DB_CONNECTION values without throwing', () => {
            write('.env', 'DB_CONNECTION=firebird\n');
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages.filter((p) => p.capability.startsWith('php-ext-pdo'))).toHaveLength(0);
        });

        it('returns no requirements when no phpunit or env files exist', () => {
            const result = detect_requirements(temporary_directory);
            expect(result.system_packages).toHaveLength(0);
        });
    });

    describe('integration', () => {
        it('detects Podman socket need for PatchLab itself', () => {
            const project_root = path.resolve(__dirname, '..', '..', '..');
            const result = detect_requirements(project_root);
            expect(result.volume_mounts.some((m) => m.host_path.includes('podman.sock'))).toBe(true);
        });
    });
});
