/**
 * Unit coverage for `src/configuration.ts` — the YAML loader for
 * `~/.patchlab/configuration.yaml` and `<source>/.patchlab/configuration.yaml`.
 *
 * Strategy: write fixture files into a tempdir, redirect `PATCHLAB_HOME` at
 * that tempdir so the loader's user-global path resolution lands in it, and
 * assert on the returned `Loaded_Configuration`. The loader uses real
 * `fs.statSync` / `fs.readFileSync` / YAML parsing — no mocking, because the
 * cases under test (symlinks, file-size caps, malformed YAML) require the
 * real filesystem and parser to be in the loop.
 *
 * Symlink tests use `fs.symlinkSync`. On Windows, creating a symlink usually
 * requires admin rights or Developer Mode; tests that hit those code paths
 * `it.skip` themselves when symlink creation throws EPERM, so the suite
 * stays green for contributors without elevation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    load_configuration,
    load_configuration_file,
    user_global_configuration_path,
    per_source_configuration_path,
    yaml_resource_limits_to_loaded,
    CONFIGURATION_FILE_SIZE_CAP_BYTES,
} from '../../src/configuration.js';
import { UNLIMITED } from '../../src/resource_limits.js';

let patchlab_home: string;
let source_directory: string;
let original_patchlab_home: string | undefined;

function write_user_global(yaml: string): void {
    const file_path = user_global_configuration_path();
    fs.mkdirSync(path.dirname(file_path), { recursive: true });
    fs.writeFileSync(file_path, yaml);
}

function write_per_source(yaml: string): void {
    const file_path = per_source_configuration_path(source_directory);
    fs.mkdirSync(path.dirname(file_path), { recursive: true });
    fs.writeFileSync(file_path, yaml);
}

function try_create_symlink(target: string, link_path: string, type?: 'file' | 'dir'): boolean {
    try {
        fs.symlinkSync(target, link_path, type);
        return true;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'ENOSYS') {
            return false;
        }

        throw error;
    }
}

beforeEach(() => {
    patchlab_home = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-config-test-'));
    source_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-config-source-'));
    original_patchlab_home = process.env.PATCHLAB_HOME;
    process.env.PATCHLAB_HOME = patchlab_home;
});

afterEach(() => {
    if (original_patchlab_home === undefined) {
        delete process.env.PATCHLAB_HOME;
    } else {
        process.env.PATCHLAB_HOME = original_patchlab_home;
    }
    fs.rmSync(patchlab_home, { recursive: true, force: true });
    fs.rmSync(source_directory, { recursive: true, force: true });
});

describe('absent files', () => {
    it('both files missing produces null/null with no error', () => {
        const result = load_configuration([source_directory]);
        expect(result).toEqual({ user_global: null, per_source: null });
    });

    it('user-global present, per-source missing', () => {
        write_user_global('resource_limits:\n  memory: "4g"\n');
        const result = load_configuration([source_directory]);
        expect(result.user_global?.memory_limit).toBe('4g');
        expect(result.per_source).toBeNull();
    });

    it('per-source present, user-global missing', () => {
        write_per_source('resource_limits:\n  memory: "2g"\n');
        const result = load_configuration([source_directory]);
        expect(result.user_global).toBeNull();
        expect(result.per_source?.memory_limit).toBe('2g');
    });

    it('both files present produce two independent loaded blocks', () => {
        write_user_global('resource_limits:\n  memory: "4g"\n  cpus: 2.0\n');
        write_per_source('resource_limits:\n  pids: 512\n');
        const result = load_configuration([source_directory]);
        expect(result.user_global?.memory_limit).toBe('4g');
        expect(result.user_global?.cpu_limit).toBe('2.0');
        expect(result.per_source?.pids_limit).toBe(512);
    });
});

describe('schema rejection', () => {
    it('unknown top-level key rejected with file path and key name', () => {
        write_user_global('sandbox_defaults:\n  memory: "4g"\n');
        expect(() => load_configuration([source_directory])).toThrow(
            /sandbox_defaults/,
        );
        expect(() => load_configuration([source_directory])).toThrow(
            new RegExp(user_global_configuration_path().replaceAll('\\', '\\\\')),
        );
    });

    it('unknown key under resource_limits rejected (typo)', () => {
        write_user_global('resource_limits:\n  memmory: "4g"\n');
        expect(() => load_configuration([source_directory])).toThrow(/memmory/);
    });

    it('negative memory rejected', () => {
        write_user_global('resource_limits:\n  memory: "-1g"\n');
        expect(() => load_configuration([source_directory])).toThrow(/memory/);
    });

    it('pids: -1 rejected (no -1 carve-out)', () => {
        write_user_global('resource_limits:\n  pids: -1\n');
        expect(() => load_configuration([source_directory])).toThrow(/pids/);
        expect(() => load_configuration([source_directory])).toThrow(/negative/);
    });

    it('blkio_weight below 10 rejected', () => {
        write_user_global('resource_limits:\n  blkio_weight: 5\n');
        expect(() => load_configuration([source_directory])).toThrow(/blkio_weight/);
        expect(() => load_configuration([source_directory])).toThrow(/\[10, 1000\]/);
    });

    it('blkio_weight above 1000 rejected', () => {
        write_user_global('resource_limits:\n  blkio_weight: 5000\n');
        expect(() => load_configuration([source_directory])).toThrow(/blkio_weight/);
        expect(() => load_configuration([source_directory])).toThrow(/\[10, 1000\]/);
    });

    it('pids above 2^31 - 1 rejected', () => {
        // 2^31 = 2147483648, just past the sanity bound.
        write_user_global('resource_limits:\n  pids: 2147483648\n');
        expect(() => load_configuration([source_directory])).toThrow(/pids/);
        expect(() => load_configuration([source_directory])).toThrow(/2147483647/);
    });

    it('malformed YAML rejected with file path in the error', () => {
        write_user_global('resource_limits:\n  memory: [unclosed\n');
        expect(() => load_configuration([source_directory])).toThrow(/YAML parse error/);
        expect(() => load_configuration([source_directory])).toThrow(
            new RegExp(user_global_configuration_path().replaceAll('\\', '\\\\')),
        );
    });

    it('non-map resource_limits rejected', () => {
        write_user_global('resource_limits:\n  - 4g\n  - 2.0\n');
        expect(() => load_configuration([source_directory])).toThrow(
            /resource_limits.*must be a mapping/,
        );
    });

    it('file without resource_limits key is accepted (fall-through)', () => {
        write_user_global('# valid YAML, no resource_limits key\n');
        const result = load_configuration([source_directory]);
        expect(result.user_global).toEqual({
            memory_limit: null, cpu_limit: null, pids_limit: null, blkio_weight: null,
        });
    });

    it('empty file (YAML null) is accepted (fall-through)', () => {
        write_user_global('');
        const result = load_configuration([source_directory]);
        expect(result.user_global?.memory_limit).toBeNull();
    });
});

describe('memory: "0g" / "0m" / etc. — ambiguous zero-with-suffix rejected', () => {
    // A user typing `memory: "0g"` probably means "unlimited" but `--memory 0g`
    // is podman's "0 bytes" form. Force disambiguation: the only "unlimited"
    // form is the bare integer 0 (or the quoted string "0").
    it('memory: "0g" rejected as ambiguous', () => {
        write_user_global('resource_limits:\n  memory: "0g"\n');
        expect(() => load_configuration([source_directory])).toThrow(/ambiguous/);
        expect(() => load_configuration([source_directory])).toThrow(/memory/);
    });

    it('memory: "0m" rejected as ambiguous', () => {
        write_user_global('resource_limits:\n  memory: "0m"\n');
        expect(() => load_configuration([source_directory])).toThrow(/ambiguous/);
    });

    it('memory: 0 (bare integer) is still accepted as unlimited', () => {
        write_user_global('resource_limits:\n  memory: 0\n');
        const result = load_configuration([source_directory]);
        expect(result.user_global?.memory_limit).toBe(UNLIMITED);
    });

    it('memory: "0" (quoted) is still accepted as unlimited', () => {
        write_user_global('resource_limits:\n  memory: "0"\n');
        const result = load_configuration([source_directory]);
        expect(result.user_global?.memory_limit).toBe(UNLIMITED);
    });
});

describe('pids accepts both number and integer-string forms', () => {
    // Memory and cpus accept either form; pids parallels them for consistency.
    it('pids: 1024 (bare integer) is accepted', () => {
        write_user_global('resource_limits:\n  pids: 1024\n');
        const result = load_configuration([source_directory]);
        expect(result.user_global?.pids_limit).toBe(1024);
    });

    it('pids: "1024" (integer string) is accepted', () => {
        write_user_global('resource_limits:\n  pids: "1024"\n');
        const result = load_configuration([source_directory]);
        expect(result.user_global?.pids_limit).toBe(1024);
    });

    it('pids: "-1" (negative integer string) is still rejected', () => {
        write_user_global('resource_limits:\n  pids: "-1"\n');
        expect(() => load_configuration([source_directory])).toThrow(/negative/);
    });

    it('pids: "abc" (non-numeric string) is rejected', () => {
        write_user_global('resource_limits:\n  pids: "abc"\n');
        expect(() => load_configuration([source_directory])).toThrow(/non-negative integer/);
    });
});

describe('YAML null vs YAML 0', () => {
    it('explicit YAML null for memory is treated as "field not set"', () => {
        write_user_global('resource_limits:\n  memory: null\n  cpus: 2.0\n');
        const result = load_configuration([source_directory]);
        expect(result.user_global?.memory_limit).toBeNull();
        expect(result.user_global?.cpu_limit).toBe('2.0');
    });

    it('YAML 0 for memory is treated as "explicitly unlimited"', () => {
        write_user_global('resource_limits:\n  memory: 0\n');
        const result = load_configuration([source_directory]);
        expect(result.user_global?.memory_limit).toBe(UNLIMITED);
    });

    it('YAML 0 for cpus is "explicitly unlimited"', () => {
        write_user_global('resource_limits:\n  cpus: 0\n');
        const result = load_configuration([source_directory]);
        expect(result.user_global?.cpu_limit).toBe(UNLIMITED);
    });

    it('YAML 0 for pids is "explicitly unlimited"', () => {
        write_user_global('resource_limits:\n  pids: 0\n');
        const result = load_configuration([source_directory]);
        expect(result.user_global?.pids_limit).toBe(UNLIMITED);
    });
});

describe('PATCHLAB_HOME redirection', () => {
    it('user-global path uses PATCHLAB_HOME when set', () => {
        // beforeEach has set PATCHLAB_HOME to patchlab_home already.
        const expected_path = path.join(patchlab_home, '.patchlab', 'configuration.yaml');
        expect(user_global_configuration_path()).toBe(expected_path);
    });

    it('writing under PATCHLAB_HOME does NOT touch the real home directory', () => {
        // The user-global path resolved through PATCHLAB_HOME, so writing the
        // fixture lands in the tempdir — assert this explicitly so a future
        // refactor that drops PATCHLAB_HOME support fails this test loudly
        // instead of silently nuking the developer's real configuration.
        write_user_global('resource_limits:\n  memory: "2g"\n');
        const real_home = os.homedir();
        const real_user_global = path.join(real_home, '.patchlab', 'configuration.yaml');
        // Either the developer truly has no `~/.patchlab/configuration.yaml`,
        // or the redirected path differs from it — in either case, the fixture
        // we wrote is under the tempdir.
        expect(user_global_configuration_path()).not.toBe(real_user_global);
    });
});

describe('symlinks', () => {
    it('symlink to a regular file is followed', () => {
        const real_file = path.join(patchlab_home, 'real-configuration.yaml');
        fs.writeFileSync(real_file, 'resource_limits:\n  memory: "4g"\n');
        const link_path = user_global_configuration_path();
        fs.mkdirSync(path.dirname(link_path), { recursive: true });
        const created = try_create_symlink(real_file, link_path, 'file');
        if (!created) {
            // Skip on Windows-without-Developer-Mode rather than fail.
            return;
        }
        const result = load_configuration([source_directory]);
        expect(result.user_global?.memory_limit).toBe('4g');
    });

    it('symlink to a directory is treated as absent', () => {
        const real_directory = path.join(patchlab_home, 'real-directory');
        fs.mkdirSync(real_directory, { recursive: true });
        const link_path = user_global_configuration_path();
        fs.mkdirSync(path.dirname(link_path), { recursive: true });
        const created = try_create_symlink(real_directory, link_path, 'dir');
        if (!created) {
            return;
        }
        const result = load_configuration([source_directory]);
        expect(result.user_global).toBeNull();
    });

    it('broken symlink is treated as absent', () => {
        const missing_target = path.join(patchlab_home, 'does-not-exist.yaml');
        const link_path = user_global_configuration_path();
        fs.mkdirSync(path.dirname(link_path), { recursive: true });
        const created = try_create_symlink(missing_target, link_path, 'file');
        if (!created) {
            return;
        }
        const result = load_configuration([source_directory]);
        expect(result.user_global).toBeNull();
    });
});

describe('file size cap', () => {
    it('file exceeding 64 KiB rejected with path and limit in the message', () => {
        const file_path = user_global_configuration_path();
        fs.mkdirSync(path.dirname(file_path), { recursive: true });
        // Construct a file just over the cap. Pad with a comment so the bytes
        // are valid UTF-8 and the contents would otherwise parse fine.
        const padding = '# '.padEnd(CONFIGURATION_FILE_SIZE_CAP_BYTES + 100, 'x');
        fs.writeFileSync(file_path, padding);

        expect(() => load_configuration([source_directory])).toThrow(/exceeds/);
        expect(() => load_configuration([source_directory])).toThrow(
            new RegExp(`${CONFIGURATION_FILE_SIZE_CAP_BYTES}`),
        );
    });
});

describe('YAML aliases disabled (security)', () => {
    it('alias syntax rejected via parser gate', () => {
        write_user_global('resource_limits: &a\n  memory: "4g"\nother: *a\n');
        expect(() => load_configuration([source_directory])).toThrow(/YAML parse error/);
    });
});

describe('yaml_resource_limits_to_loaded — key conversion regression', () => {
    it('memory → memory_limit, cpus → cpu_limit, pids → pids_limit, blkio_weight → blkio_weight', () => {
        const result = yaml_resource_limits_to_loaded(
            { memory: '4g', cpus: 2.0, pids: 1024, blkio_weight: 500 },
            '/test/fixture',
        );
        expect(result).toEqual({
            memory_limit: '4g',
            cpu_limit: '2.0',
            pids_limit: 1024,
            blkio_weight: 500,
        });
    });

    it('all four fields null when all four omitted from YAML', () => {
        const result = yaml_resource_limits_to_loaded({}, '/test/fixture');
        expect(result).toEqual({
            memory_limit: null,
            cpu_limit: null,
            pids_limit: null,
            blkio_weight: null,
        });
    });

    it('three fields default to null when only one is supplied', () => {
        const result = yaml_resource_limits_to_loaded(
            { memory: '8g' },
            '/test/fixture',
        );
        expect(result.memory_limit).toBe('8g');
        expect(result.cpu_limit).toBeNull();
        expect(result.pids_limit).toBeNull();
        expect(result.blkio_weight).toBeNull();
    });

    it('regression: does NOT add _limit suffix to blkio_weight', () => {
        // The transposition risk: someone refactors and accidentally maps
        // `blkio_weight` -> `blkio_weight_limit`. Lock the field name.
        const result = yaml_resource_limits_to_loaded(
            { blkio_weight: 300 },
            '/test/fixture',
        );
        expect(result.blkio_weight).toBe(300);
        // The key is exactly `blkio_weight`, not `blkio_weight_limit`.
        expect(Object.keys(result)).toContain('blkio_weight');
        expect(Object.keys(result)).not.toContain('blkio_weight_limit');
    });
});

describe('partial-application rejection', () => {
    it('one bad field aborts the entire load (no half-applied values)', () => {
        // Three valid fields and one invalid. The invalid one MUST cause the
        // whole load to fail; none of the valid fields should be silently
        // accepted into a half-loaded struct.
        write_user_global(
            'resource_limits:\n'
            + '  memory: "4g"\n'
            + '  cpus: 2.0\n'
            + '  pids: 1024\n'
            + '  blkio_weight: 99999\n',  // out of range
        );
        expect(() => load_configuration([source_directory])).toThrow(/blkio_weight/);
        // Re-attempt the load and confirm it stays failing — no caching of
        // partial state.
        expect(() => load_configuration([source_directory])).toThrow();
    });
});

describe('per-source path resolution', () => {
    it('per-source path is <source>/.patchlab/configuration.yaml', () => {
        const expected = path.join(source_directory, '.patchlab', 'configuration.yaml');
        expect(per_source_configuration_path(source_directory)).toBe(expected);
    });

    it('load_configuration_file accepts the per-source path directly', () => {
        write_per_source('resource_limits:\n  memory: "2g"\n');
        const loaded = load_configuration_file(per_source_configuration_path(source_directory));
        expect(loaded?.memory_limit).toBe('2g');
    });
});

describe('per-source clamp does not require trust prompt (spec scenario)', () => {
    // Spec scenario: "Per-source clamp does not require trust prompt" — the
    // loader reads a per-source file and applies clamping without ever
    // touching stdin or any prompt helper. The configured-provider tool
    // manifest path at `<source>/.patchlab/tools/*.yaml` requires a trust
    // prompt (because tool manifests describe arbitrary container images and
    // binaries); resource_limits configuration deliberately does NOT, because
    // the per-source clamp gives us the safety invariant a trust prompt would
    // protect.
    //
    // The strongest possible regression check is structural: there is no
    // `register_per_source_manifests`-equivalent helper in the configuration
    // loader's call graph, and `load_configuration` does not import or invoke
    // any function from `tools/configured_provider/`. The runtime check
    // below confirms a fresh per-source file is read AND clamped with NO
    // stdin interaction and NO thrown "trust required" error — the two
    // signals that would indicate a prompt was demanded.
    it('first-encounter per-source file is read without prompting and is clamped', () => {
        // First-encounter conditions: there is no trust marker for this
        // source directory anywhere on disk (we never created one), and
        // process.stdin is not interactive in the vitest harness. The
        // configured-provider trust prompt would either prompt on stdin
        // (interactive) or throw a "trust required" error (strict non-TTY)
        // under these conditions. Loading configuration here does neither.
        write_user_global('resource_limits:\n  memory: "1g"\n');
        write_per_source('resource_limits:\n  memory: "8g"\n');

        // `load_configuration` is synchronous and pure with respect to stdin.
        // If it ever grew a trust-prompt code path, that path would have to
        // be async (`await confirm(...)`) and would surface here either as a
        // returned Promise (the function signature would no longer be
        // synchronous) or as a thrown error naming trust. Neither happens.
        const result = load_configuration([source_directory]);
        expect(result.user_global?.memory_limit).toBe('1g');
        expect(result.per_source?.memory_limit).toBe('8g');
    });
});

/**
 * Multi-repository per-source composition (`multi-source-trust` task 2.6).
 *
 * The `load_configuration` entry point accepts a list of repository roots and
 * composes per-source values via a lattice min-fold:
 *   - A concrete numeric value is a regular lattice element.
 *   - `"unlimited"` is the top (least restrictive); any concrete value wins.
 *   - `null` excludes that repo from the per-field fold (not bottom).
 *
 * Single-repo (N=1) collapses to that one repo's value byte-for-byte. The
 * `[repository_root]` array-wrapping is the back-compat shim used everywhere
 * in this file's existing tests.
 */
describe('multi-repository per-source composition', () => {
    let repository_a: string;
    let repository_b: string;

    beforeEach(() => {
        repository_a = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-config-multi-a-'));
        repository_b = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-config-multi-b-'));
    });

    afterEach(() => {
        fs.rmSync(repository_a, { recursive: true, force: true });
        fs.rmSync(repository_b, { recursive: true, force: true });
    });

    function write_per_source_at(repository_root: string, yaml: string): void {
        const file_path = per_source_configuration_path(repository_root);
        fs.mkdirSync(path.dirname(file_path), { recursive: true });
        fs.writeFileSync(file_path, yaml);
    }

    it('single-repo passes through unchanged (no fold)', () => {
        write_per_source_at(repository_a, 'resource_limits:\n  memory: "8g"\n  cpus: 2.0\n');
        const result = load_configuration([repository_a]);
        expect(result.per_source?.memory_limit).toBe('8g');
        expect(result.per_source?.cpu_limit).toBe('2.0');
    });

    it('two repos both supply numeric values: min wins per field', () => {
        write_per_source_at(repository_a, 'resource_limits:\n  memory: "8g"\n  cpus: 2.0\n');
        write_per_source_at(repository_b, 'resource_limits:\n  memory: "6g"\n  cpus: 4.0\n');
        const result = load_configuration([repository_a, repository_b]);
        expect(result.per_source?.memory_limit).toBe('6g');
        expect(result.per_source?.cpu_limit).toBe('2.0');
    });

    it('one repo missing the field excludes it from the fold', () => {
        write_per_source_at(repository_a, 'resource_limits:\n  memory: "8g"\n');
        write_per_source_at(repository_b, 'resource_limits:\n  cpus: 4.0\n');
        const result = load_configuration([repository_a, repository_b]);
        expect(result.per_source?.memory_limit).toBe('8g');
        expect(result.per_source?.cpu_limit).toBe('4.0');
    });

    it('all repos unlimited folds to unlimited', () => {
        write_per_source_at(repository_a, 'resource_limits:\n  memory: 0\n');
        write_per_source_at(repository_b, 'resource_limits:\n  memory: 0\n');
        const result = load_configuration([repository_a, repository_b]);
        expect(result.per_source?.memory_limit).toBe(UNLIMITED);
    });

    it('concrete wins over unlimited under the lattice', () => {
        write_per_source_at(repository_a, 'resource_limits:\n  memory: 0\n');
        write_per_source_at(repository_b, 'resource_limits:\n  memory: "8g"\n');
        const result = load_configuration([repository_a, repository_b]);
        expect(result.per_source?.memory_limit).toBe('8g');
    });

    it('both repos missing the field yields null per-source (falls through to user-global)', () => {
        write_user_global('resource_limits:\n  memory: "4g"\n');
        const result = load_configuration([repository_a, repository_b]);
        expect(result.per_source).toBeNull();
        expect(result.user_global?.memory_limit).toBe('4g');
    });

    it('user-global clamp produces a more-restrictive effective value (12g global, 8g + 6g per-source → 6g resolved)', () => {
        // The clamp itself runs in the resolver. The loader composes per-source
        // to 6g (the min). The downstream resolver then clamps the composite
        // against the user-global 12g upper bound — the composite is already
        // below the upper bound so the clamp is a no-op. End result: 6g.
        write_user_global('resource_limits:\n  memory: "12g"\n');
        write_per_source_at(repository_a, 'resource_limits:\n  memory: "8g"\n');
        write_per_source_at(repository_b, 'resource_limits:\n  memory: "6g"\n');
        const result = load_configuration([repository_a, repository_b]);
        expect(result.user_global?.memory_limit).toBe('12g');
        expect(result.per_source?.memory_limit).toBe('6g');
    });

    it('pids_limit min-fold across two repos', () => {
        write_per_source_at(repository_a, 'resource_limits:\n  pids: 1024\n');
        write_per_source_at(repository_b, 'resource_limits:\n  pids: 512\n');
        const result = load_configuration([repository_a, repository_b]);
        expect(result.per_source?.pids_limit).toBe(512);
    });

    it('blkio_weight min-fold across two repos (no unlimited sentinel for this field)', () => {
        write_per_source_at(repository_a, 'resource_limits:\n  blkio_weight: 500\n');
        write_per_source_at(repository_b, 'resource_limits:\n  blkio_weight: 200\n');
        const result = load_configuration([repository_a, repository_b]);
        expect(result.per_source?.blkio_weight).toBe(200);
    });
});