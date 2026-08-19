/**
 * Structural lock: every `src/<path>.ts` has a discoverable test mirror.
 *
 * The organizing principle (set during the test-structure pass): given a src
 * file, the reader should be able to find its tests in a predictable
 * location. Accepted shapes:
 *   - `src/foo.ts` ↔ `test/<tier>/foo.test.ts`
 *   - `src/foo.ts` ↔ `test/<tier>/foo/` (directory grouping multiple files)
 *   - `src/a/b/x.ts` ↔ `test/<tier>/a/b/x.test.ts` (mirrored nesting)
 *   - `src/a/b/x.ts` ↔ `test/<tier>/a/b/x/`
 *
 * Where `<tier>` is `unit`, `integration`, `posix`, `windows`, or `macos`. The snake-
 * cased src filename matches the kebab-cased test filename (and vice versa).
 *
 * Files exempted from the mirror rule are listed in `MIRROR_EXEMPTIONS`
 * below, each with a one-line rationale. The two structural categories are:
 *   1. Re-export wrappers (`index.ts`) whose siblings carry the logic and
 *      are tested separately through the wrapper's symbol surface.
 *   2. Type-only modules (`types.ts`) — no executable code to test in
 *      isolation; their shape is verified at every call site.
 *
 * Files with `INDIRECT:` rationale are tested through another test file
 * (named after a related concept) — they are listed here so the implicit
 * coverage is at least documented, and the scanner catches new gaps.
 *
 * The scanner is intentionally a ratchet: existing gaps are documented as
 * exemptions; new src files MUST either grow a mirrored test or join the
 * exemption set with explicit rationale.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const SOURCE_ROOT = path.join(REPOSITORY_ROOT, 'src');
const TEST_TIERS = ['unit', 'integration', 'posix', 'windows', 'macos'] as const;

interface Mirror_Exemption {
    relative_path: string;
    rationale: string;
}

const MIRROR_EXEMPTIONS: Mirror_Exemption[] = [
    // Re-export wrappers (no own logic — sibling files carry the surface).
    { relative_path: 'index.ts', rationale: 're-export wrapper for top-level public surface' },
    { relative_path: 'sandbox/index.ts', rationale: 're-export wrapper for sandbox/* siblings' },
    { relative_path: 'tools/index.ts', rationale: 're-export wrapper for tools/* siblings' },
    { relative_path: 'tools/configured_provider/index.ts', rationale: 're-export wrapper for configured_provider/* siblings' },
    { relative_path: 'languages/index.ts', rationale: 're-export wrapper that registers built-in detectors; siblings carry the logic' },

    // Type-only modules (no executable code).
    { relative_path: 'detect/types.ts', rationale: 'type-only module' },
    { relative_path: 'tools/types.ts', rationale: 'type-only module' },
    { relative_path: 'tools/configured_provider/types.ts', rationale: 'type-only module' },
    { relative_path: 'languages/types.ts', rationale: 'type-only module' },

    // Tested through src/languages/ sibling tests.
    { relative_path: 'languages/builtins.ts', rationale: 'INDIRECT: pure detector data exercised via test/unit/languages/detect.test.ts (all eight languages)' },

    // Tested through src/branch/index.ts re-export wrapper.
    { relative_path: 'branch/apply.ts', rationale: 'tested via branch/index.ts re-export (see test/unit/branch/index.test.ts)' },
    { relative_path: 'branch/create.ts', rationale: 'tested via branch/index.ts re-export (see test/unit/branch/index.test.ts)' },
    { relative_path: 'branch/diff_read.ts', rationale: 'tested via branch/index.ts re-export (see test/unit/branch/index.test.ts)' },

    // Tested through src/detect/index.ts re-export wrapper.
    { relative_path: 'detect/detectors.ts', rationale: 'tested via detect/index.ts re-export (see test/unit/detect/index.test.ts)' },
    { relative_path: 'detect/pipeline.ts', rationale: 'tested via detect/index.ts re-export (see test/unit/detect/index.test.ts)' },

    // Tested through src/sandbox/index.ts re-export wrapper.
    { relative_path: 'sandbox/image_tier.ts', rationale: 'tested via sandbox/index.ts re-export (see test/unit/sandbox/effective-image.test.ts)' },
    { relative_path: 'sandbox/inspect.ts', rationale: 'tested via sandbox/index.ts re-export (test/unit/sandbox/lifecycle.test.ts, test/unit/non-gated-operations.test.ts, test/integration/sandbox.test.ts, test/unit/legacy-tool-fallback.test.ts)' },
    { relative_path: 'sandbox/persisted_resource_limits.ts', rationale: 'INDIRECT: tested via test/unit/manifest-resource-limits.test.ts' },
    { relative_path: 'sandbox/provisioning.ts', rationale: 'create/resume rollback control flow tested via test/unit/sandbox/provisioning-rollback.test.ts; end-to-end via test/integration/sandbox.test.ts' },
    { relative_path: 'sandbox/workspace_copies.ts', rationale: 'INDIRECT: tested end-to-end via test/integration/copy_paths.test.ts (create, resume, extract, and copy-out paths)' },

    // Tested through src/tools/configured_provider/index.ts re-export wrapper.
    { relative_path: 'tools/configured_provider/discovery.ts', rationale: 'tested via configured_provider/index.ts re-export (see test/unit/tools/configured_provider/manifest-parse-discovery.test.ts)' },
    { relative_path: 'tools/configured_provider/parse.ts', rationale: 'tested via configured_provider/index.ts re-export (see test/unit/tools/configured_provider/manifest-parse-discovery.test.ts)' },
    { relative_path: 'tools/configured_provider/path_resolution.ts', rationale: 'tested via configured_provider/index.ts re-export (see test/unit/tools/configured_provider/per-source-containment.test.ts)' },
    { relative_path: 'tools/configured_provider/provider_class.ts', rationale: 'tested via configured_provider/index.ts re-export (see test/unit/tools/configured_provider/provider.test.ts)' },
    { relative_path: 'tools/configured_provider/trust_hash.ts', rationale: 'tested via configured_provider/index.ts re-export (see test/unit/tools/configured_provider/per-source-trust.test.ts)' },
    { relative_path: 'tools/configured_provider/trust_marker.ts', rationale: 'INDIRECT: tested via test/unit/tools/configured_provider/per-source-trust.test.ts and test/windows/per-source-trust.test.ts' },
    { relative_path: 'tools/configured_provider/trust_verification.ts', rationale: 'INDIRECT: tested via test/unit/tools/configured_provider/per-source-trust.test.ts and test/unit/tools/configured_provider/trust-flag-resolution.test.ts' },
    { relative_path: 'tools/repository_state_key.ts', rationale: 'INDIRECT: realpath keying tested via test/unit/tools/default-tool-preference.test.ts and per-source-trust marker tests' },

    // Tested through provider abstraction tests.
    { relative_path: 'tools/provider.ts', rationale: 'INDIRECT: unit coverage in test/unit/tool-registry.test.ts, test/unit/list-tools.test.ts, test/unit/register-*.test.ts; integration smoke in test/integration/configured-provider.test.ts' },

    // Container runtime layer.
    { relative_path: 'container_runtime/index.ts', rationale: 'INDIRECT: commit.test.ts + test/unit/podman/* + integration tests' },
    { relative_path: 'container_runtime/registry.ts', rationale: 'INDIRECT: runtime registry dispatch tested via test/unit/podman/* and integration tests' },
    { relative_path: 'container_runtime/types.ts', rationale: 'type-only module' },

    // Tested through topic-named test files.
    { relative_path: 'configuration.ts', rationale: 'INDIRECT: tested via test/unit/configuration-loader.test.ts and configuration-loader-fs-faults.test.ts' },
    { relative_path: 'extractable_artifact.ts', rationale: 'INDIRECT: validator surface in test/unit/archive-validators.test.ts and test/posix/archive-validators.test.ts; injection flow in test/integration/extraction.test.ts' },

    // OpenCode module (tested under test/unit/opencode/).
    { relative_path: 'local_model_proxy/main.ts', rationale: 'INDIRECT: detached daemon entrypoint; spawn path exercised via test/unit/local_model_proxy/manager.test.ts and proxy.test.ts' },
    { relative_path: 'opencode/index.ts', rationale: 're-export wrapper for opencode/* siblings' },
    { relative_path: 'tools/host_access.ts', rationale: 'type-only module (host access plan interfaces and host gateway hostname)' },
    { relative_path: 'opencode/paths.ts', rationale: 'INDIRECT: path helpers exercised via test/unit/opencode/host-configuration.test.ts and provider.test.ts' },
    { relative_path: 'opencode/settings.ts', rationale: 'INDIRECT: defaults exercised via test/unit/configuration-loader.test.ts and provider tests' },
];

const EXEMPT_PATHS = new Set(MIRROR_EXEMPTIONS.map((entry) => entry.relative_path));

function collect_source_files(directory: string, accumulator: string[]): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entry_path = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            collect_source_files(entry_path, accumulator);
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            accumulator.push(entry_path);
        }
    }
}

function snake_to_kebab(name: string): string {
    return name.replaceAll('_', '-');
}

function name_variants(name: string): string[] {
    const kebab = snake_to_kebab(name);
    return name === kebab ? [name] : [name, kebab];
}

function cartesian(lists: string[][]): string[][] {
    if (lists.length === 0) {
        return [[]];
    }
    const rest = cartesian(lists.slice(1));
    return lists[0].flatMap((value) => rest.map((tail) => [value, ...tail]));
}

function candidate_test_bases(relative_source: string): string[] {
    const without_extension = relative_source.replace(/\.ts$/, '');
    const segments = without_extension.split(/[\\/]/);
    const filename = segments.at(-1) ?? '';
    const directory_segments = segments.slice(0, -1);

    const directory_paths = cartesian(directory_segments.map(name_variants))
        .map((parts) => parts.join(path.sep));
    const filename_choices = name_variants(filename);

    const bases: string[] = [];
    for (const tier of TEST_TIERS) {
        for (const directory_path of directory_paths) {
            for (const test_filename of filename_choices) {
                bases.push(path.join(REPOSITORY_ROOT, 'test', tier, directory_path, test_filename));
            }
        }
    }

    return bases;
}

function mirror_exists_for(relative_source: string): boolean {
    for (const base of candidate_test_bases(relative_source)) {
        if (fs.existsSync(base + '.test.ts')) {
            return true;
        }
        if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
            return true;
        }
    }

    return false;
}

describe('test/src mirror discipline', () => {
    it('every src/ file has a mirrored test (or an explicit exemption with rationale)', () => {
        const source_files: string[] = [];
        collect_source_files(SOURCE_ROOT, source_files);

        const unmirrored: string[] = [];
        const stale_exemptions: string[] = [];

        for (const absolute of source_files) {
            const relative = path.relative(SOURCE_ROOT, absolute).split(path.sep).join('/');
            if (mirror_exists_for(relative)) {
                if (EXEMPT_PATHS.has(relative)) {
                    stale_exemptions.push(relative);
                }
                continue;
            }
            if (EXEMPT_PATHS.has(relative)) {
                continue;
            }
            unmirrored.push(relative);
        }

        expect(
            unmirrored,
            `src/ files with no mirrored test and no exemption — add a mirrored test file/dir under test/<tier>/, or add to MIRROR_EXEMPTIONS with rationale:\n${unmirrored
                .map((p) => `  src/${p}`)
                .join('\n')}`,
        ).toEqual([]);

        expect(
            stale_exemptions,
            `MIRROR_EXEMPTIONS entries whose src file now has a mirror test — remove these from the list:\n${stale_exemptions
                .map((p) => `  ${p}`)
                .join('\n')}`,
        ).toEqual([]);
    });
});
