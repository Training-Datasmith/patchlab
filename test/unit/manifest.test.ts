import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
    create_manifest,
    manifest_primary_source,
    manifest_repositories,
    read_manifest,
    write_manifest,
    CURRENT_FORMAT_VERSION,
    type Source_Specification,
} from '../../src/manifest.js';

function make_source(host_path: string, repository_root: string, source_prefix: string): Source_Specification {
    return { host_path, repository_root, source_prefix, mount_name: source_prefix };
}

describe('manifest', () => {
    let temporary_directory: string;

    beforeEach(() => {
        temporary_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-test-'));
    });

    afterEach(() => {
        fs.rmSync(temporary_directory, { recursive: true, force: true });
    });

    it('creates a manifest with correct fields', () => {
        const manifest = create_manifest(
            'test-id',
            [make_source('/some/source/src', '/some/source', 'src')],
            'patchlab-test',
            'node:22-slim',
        );
        expect(manifest.id).toBe('test-id');
        expect(manifest_primary_source(manifest).host_path).toBe('/some/source/src');
        expect(manifest_primary_source(manifest).source_prefix).toBe('src');
        expect(manifest_primary_source(manifest).mount_name).toBe('src');
        expect(manifest.created_at).toBeTruthy();
        expect(manifest.container_name).toBe('patchlab-test');
        expect(manifest.container_image).toBe('node:22-slim');
    });

    it('persists and reads new-shape manifest from disk via round trip', () => {
        const manifest = create_manifest(
            'test-id',
            [make_source('/some/source/src', '/some/source', 'src')],
            'patchlab-test',
            'node:22-slim',
        );
        write_manifest(temporary_directory, manifest);
        const read = read_manifest(temporary_directory);
        expect(read.id).toBe(manifest.id);
        expect(read.sources).toEqual(manifest.sources);
        expect(read.container_name).toBe('patchlab-test');
        expect(read.container_image).toBe('node:22-slim');
    });

    it('writes manifest atomically (temp file then rename)', () => {
        const manifest = create_manifest(
            'test-id',
            [make_source('/some/source/src', '/some/source', 'src')],
            'patchlab-test',
            'node:22-slim',
        );
        write_manifest(temporary_directory, manifest);
        manifest.sources = [make_source('/updated/source/src', '/updated/source', 'src')];
        write_manifest(temporary_directory, manifest);
        const read = read_manifest(temporary_directory);
        expect(manifest_primary_source(read).host_path).toBe('/updated/source/src');
    });

    it('stores include/exclude globs when provided', () => {
        const manifest = create_manifest(
            'test-id',
            [make_source('/some/source/src', '/some/source', 'src')],
            'patchlab-test',
            'node:22-slim',
            {
                include: ['src/**'],
                exclude: ['node_modules/**'],
            },
        );
        expect(manifest.include_globs).toEqual(['src/**']);
        expect(manifest.exclude_globs).toEqual(['node_modules/**']);
        write_manifest(temporary_directory, manifest);
        const read = read_manifest(temporary_directory);
        expect(read.include_globs).toEqual(['src/**']);
        expect(read.exclude_globs).toEqual(['node_modules/**']);
    });

    it('populates new schema fields with defaults', () => {
        const manifest = create_manifest(
            'test-id',
            [make_source('/repo', '/repo', '')],
            'patchlab-test',
            'node:22-slim',
        );
        expect(manifest.format_version).toBe(CURRENT_FORMAT_VERSION);
        expect(manifest.sources).toHaveLength(1);
        expect(manifest.baseline_commit_shas).toEqual({ '/repo': null });
        expect(manifest.branch_creation_point_shas).toEqual({ '/repo': null });
    });

    it('persists baseline_commit_sha when caller provides it', () => {
        const manifest = create_manifest(
            'test-id',
            [make_source('/repo/src/ui', '/repo', 'src/ui')],
            'patchlab-test',
            'node:22-slim',
            {
                baseline_commit_sha: 'abc123',
            },
        );
        expect(manifest_primary_source(manifest).repository_root).toBe('/repo');
        expect(manifest_primary_source(manifest).source_prefix).toBe('src/ui');
        expect(manifest.baseline_commit_shas).toEqual({ '/repo': 'abc123' });
        write_manifest(temporary_directory, manifest);
        const read = read_manifest(temporary_directory);
        expect(manifest_primary_source(read).repository_root).toBe('/repo');
        expect(manifest_primary_source(read).source_prefix).toBe('src/ui');
        expect(read.baseline_commit_shas).toEqual({ '/repo': 'abc123' });
    });

    it('reads legacy single-source manifest and synthesizes a sources array', () => {
        // A pre-multi-source manifest carries top-level source_path /
        // repository_root / source_prefix. The reader synthesizes a
        // single-entry sources array; the original file is not modified.
        const legacy = {
            id: 'legacy-id',
            source_path: '/legacy/source/src',
            repository_root: '/legacy/source',
            source_prefix: 'src',
            created_at: '2026-01-01T00:00:00.000Z',
            container_name: 'patchlab-legacy',
            container_image: 'node:22-slim',
            tool: 'gemini-cli-oauth',
        };
        const file_path = path.join(temporary_directory, 'manifest.json');
        fs.writeFileSync(file_path, JSON.stringify(legacy, null, 2), 'utf-8');

        const read = read_manifest(temporary_directory);
        expect(read.id).toBe('legacy-id');
        expect(read.format_version).toBe(0);
        expect(read.sources).toHaveLength(1);
        const primary = manifest_primary_source(read);
        expect(primary.repository_root).toBe('/legacy/source');
        expect(primary.source_prefix).toBe('src');
        expect(primary.mount_name).toBe('src');
        // host_path is recomputed via path.join(repository_root, source_prefix)
        // so the invariant holds by construction even when the legacy
        // source_path was stored under a different normalization.
        expect(primary.host_path.replaceAll('\\', '/')).toBe('/legacy/source/src');
    });

    it('reads legacy repo-root manifest synthesis (empty source_prefix)', () => {
        const legacy = {
            id: 'legacy-root-id',
            source_path: '/legacy/repo',
            repository_root: '/legacy/repo',
            source_prefix: '',
            created_at: '2026-01-01T00:00:00.000Z',
            container_name: 'patchlab-root',
            container_image: 'node:22-slim',
        };
        const file_path = path.join(temporary_directory, 'manifest.json');
        fs.writeFileSync(file_path, JSON.stringify(legacy, null, 2), 'utf-8');

        const read = read_manifest(temporary_directory);
        const primary = manifest_primary_source(read);
        expect(primary.source_prefix).toBe('');
        expect(primary.mount_name).toBe('');
        expect(primary.host_path.replaceAll('\\', '/')).toBe('/legacy/repo');
    });

    it('rejects manifests with neither sources nor any legacy source field', () => {
        const broken = {
            id: 'no-sources-id',
            format_version: 0,
            created_at: '2026-01-01T00:00:00.000Z',
            container_name: 'patchlab-broken',
            container_image: 'node:22-slim',
        };
        const file_path = path.join(temporary_directory, 'manifest.json');
        fs.writeFileSync(file_path, JSON.stringify(broken, null, 2), 'utf-8');

        expect(() => read_manifest(temporary_directory)).toThrow(/at least one source/i);
    });

    it('rejects a legacy manifest carrying only source_prefix (no source_path, no repository_root)', () => {
        // The outer gate at `resolve_sources_from_raw` only throws when ALL
        // three legacy fields are undefined; a manifest with just
        // `source_prefix` set passes that gate and reaches the synthesizer,
        // which then throws because it has nothing to anchor host_path to.
        // Reachable via hand-crafted YAML/JSON or a botched migration that
        // stripped the path fields but kept the prefix.
        const partial_legacy = {
            id: 'prefix-only-id',
            format_version: 0,
            source_prefix: 'src',
            created_at: '2026-01-01T00:00:00.000Z',
            container_name: 'patchlab-prefix-only',
            container_image: 'node:22-slim',
        };
        const file_path = path.join(temporary_directory, 'manifest.json');
        fs.writeFileSync(file_path, JSON.stringify(partial_legacy, null, 2), 'utf-8');

        expect(() => read_manifest(temporary_directory)).toThrow(
            /carries no usable legacy source fields \(neither source_path nor repository_root\)/,
        );
    });

    it('rejects manifests where host_path != path.join(repository_root, source_prefix)', () => {
        const tampered = {
            id: 'tamper-id',
            format_version: 0,
            sources: [{
                host_path: '/home/user/project/src',
                repository_root: '/home/user/project',
                source_prefix: 'lib', // path.join would produce .../lib, not .../src
                mount_name: 'lib',
            }],
            created_at: '2026-01-01T00:00:00.000Z',
            container_name: 'patchlab-tamper',
            container_image: 'node:22-slim',
        };
        const file_path = path.join(temporary_directory, 'manifest.json');
        fs.writeFileSync(file_path, JSON.stringify(tampered, null, 2), 'utf-8');

        expect(() => read_manifest(temporary_directory)).toThrow(/path\.join/);
    });

    it('rejects legacy inconsistent triple (source_path not under repository_root)', () => {
        const legacy = {
            id: 'inconsistent-id',
            source_path: '/home/user/project/src',
            repository_root: '/elsewhere/repo',
            source_prefix: 'src',
            created_at: '2026-01-01T00:00:00.000Z',
            container_name: 'patchlab-legacy',
            container_image: 'node:22-slim',
        };
        const file_path = path.join(temporary_directory, 'manifest.json');
        fs.writeFileSync(file_path, JSON.stringify(legacy, null, 2), 'utf-8');

        expect(() => read_manifest(temporary_directory)).toThrow(/legacy triple is inconsistent/);
    });

    it('rejects manifests with unrecognized format_version', () => {
        const future = {
            id: 'future-id',
            sources: [{
                host_path: '/future',
                repository_root: '/future',
                source_prefix: '',
                mount_name: '',
            }],
            format_version: 99,
            baseline_commit_sha: null,
            created_at: '2026-01-01T00:00:00.000Z',
            container_name: 'patchlab-future',
            container_image: 'node:22-slim',
        };
        const file_path = path.join(temporary_directory, 'manifest.json');
        fs.writeFileSync(file_path, JSON.stringify(future, null, 2), 'utf-8');

        expect(() => read_manifest(temporary_directory)).toThrow(/format_version/);
    });

    describe('manifest_repositories', () => {
        it('returns a one-element array for a single-source manifest', () => {
            const manifest = create_manifest(
                'one-source-id',
                [make_source('/home/user/project/src', '/home/user/project', 'src')],
                'patchlab-test',
                'node:22-slim',
            );
            expect(manifest_repositories(manifest)).toEqual(['/home/user/project']);
        });

        it('dedupes multi-source-same-repo manifests to one element', () => {
            const manifest = create_manifest(
                'dedupe-id',
                [
                    make_source('/repo/src/ui', '/repo', 'src/ui'),
                    make_source('/repo/src/server', '/repo', 'src/server'),
                ],
                'patchlab-test',
                'node:22-slim',
            );
            expect(manifest_repositories(manifest)).toEqual(['/repo']);
        });

        it('preserves first-appearance order across multi-repo sources', () => {
            // The single-repo invariant rejects this in real-world create flows;
            // the helper itself is shape-agnostic and the downstream multi-source
            // changes will rely on this ordering.
            const manifest = create_manifest(
                'multi-repo-id',
                [
                    make_source('/repo-a', '/repo-a', ''),
                    make_source('/repo-b', '/repo-b', ''),
                    make_source('/repo-a', '/repo-a', ''),
                ],
                'patchlab-test',
                'node:22-slim',
            );
            expect(manifest_repositories(manifest)).toEqual(['/repo-a', '/repo-b']);
        });

        it('treats trailing-slash variants as distinct (no normalization)', () => {
            const manifest = create_manifest(
                'slash-variants-id',
                [
                    make_source('/repo', '/repo', ''),
                    make_source('/repo/', '/repo/', ''),
                ],
                'patchlab-test',
                'node:22-slim',
            );
            expect(manifest_repositories(manifest)).toEqual(['/repo', '/repo/']);
        });

        it('returns a fresh array on each call', () => {
            const manifest = create_manifest(
                'fresh-array-id',
                [make_source('/repo/src', '/repo', 'src')],
                'patchlab-test',
                'node:22-slim',
            );
            const first = manifest_repositories(manifest);
            const second = manifest_repositories(manifest);
            expect(first).not.toBe(second);
            first.push('mutated');
            expect(manifest_repositories(manifest)).toEqual(['/repo']);
        });
    });

    describe('SHA-map fields', () => {
        it('round-trips new-shape baseline_commit_shas and branch_creation_point_shas', () => {
            const manifest = create_manifest(
                'sha-shape-id',
                [make_source('/repo/src', '/repo', 'src')],
                'patchlab-test',
                'node:22-slim',
                {
                    baseline_commit_sha: 'abc',
                    branch_creation_point_sha: 'def',
                },
            );
            write_manifest(temporary_directory, manifest);
            const read = read_manifest(temporary_directory);
            expect(read.baseline_commit_shas).toEqual({ '/repo': 'abc' });
            expect(read.branch_creation_point_shas).toEqual({ '/repo': 'def' });
            // Persisted JSON must not carry legacy single-key fields.
            const raw = JSON.parse(fs.readFileSync(path.join(temporary_directory, 'manifest.json'), 'utf-8'));
            expect(raw.baseline_commit_sha).toBeUndefined();
            expect(raw.branch_creation_point_sha).toBeUndefined();
            expect(raw.baseline_commit_shas).toEqual({ '/repo': 'abc' });
        });

        it('synthesizes legacy single-key SHAs into single-entry maps on read', () => {
            const legacy = {
                id: 'legacy-sha-id',
                format_version: 0,
                sources: [{
                    host_path: '/legacy/repo/src',
                    repository_root: '/legacy/repo',
                    source_prefix: 'src',
                    mount_name: 'src',
                }],
                baseline_commit_sha: 'legacy-abc',
                branch_creation_point_sha: 'legacy-def',
                created_at: '2026-01-01T00:00:00.000Z',
                container_name: 'patchlab-legacy',
                container_image: 'node:22-slim',
            };
            const file_path = path.join(temporary_directory, 'manifest.json');
            fs.writeFileSync(file_path, JSON.stringify(legacy, null, 2), 'utf-8');

            const read = read_manifest(temporary_directory);
            expect(read.baseline_commit_shas).toEqual({ '/legacy/repo': 'legacy-abc' });
            expect(read.branch_creation_point_shas).toEqual({ '/legacy/repo': 'legacy-def' });
        });

        it('persists the new shape on first write after a legacy read', () => {
            const legacy = {
                id: 'first-write-id',
                format_version: 0,
                sources: [{
                    host_path: '/legacy/repo/src',
                    repository_root: '/legacy/repo',
                    source_prefix: 'src',
                    mount_name: 'src',
                }],
                baseline_commit_sha: 'abc',
                branch_creation_point_sha: 'def',
                created_at: '2026-01-01T00:00:00.000Z',
                container_name: 'patchlab-legacy',
                container_image: 'node:22-slim',
            };
            const file_path = path.join(temporary_directory, 'manifest.json');
            fs.writeFileSync(file_path, JSON.stringify(legacy, null, 2), 'utf-8');

            const read = read_manifest(temporary_directory);
            write_manifest(temporary_directory, read);
            const raw = JSON.parse(fs.readFileSync(file_path, 'utf-8'));
            expect(raw.baseline_commit_sha).toBeUndefined();
            expect(raw.branch_creation_point_sha).toBeUndefined();
            expect(raw.baseline_commit_shas).toEqual({ '/legacy/repo': 'abc' });
            expect(raw.branch_creation_point_shas).toEqual({ '/legacy/repo': 'def' });
        });

        it('lets the new map win when both shapes are present', () => {
            const mixed = {
                id: 'mixed-id',
                format_version: 0,
                sources: [{
                    host_path: '/repo/src',
                    repository_root: '/repo',
                    source_prefix: 'src',
                    mount_name: 'src',
                }],
                baseline_commit_sha: 'legacy-value',
                baseline_commit_shas: { '/repo': 'new-value' },
                branch_creation_point_sha: 'legacy-creation',
                branch_creation_point_shas: { '/repo': 'new-creation' },
                created_at: '2026-01-01T00:00:00.000Z',
                container_name: 'patchlab-mixed',
                container_image: 'node:22-slim',
            };
            const file_path = path.join(temporary_directory, 'manifest.json');
            fs.writeFileSync(file_path, JSON.stringify(mixed, null, 2), 'utf-8');

            const read = read_manifest(temporary_directory);
            expect(read.baseline_commit_shas).toEqual({ '/repo': 'new-value' });
            expect(read.branch_creation_point_shas).toEqual({ '/repo': 'new-creation' });
        });

        it('preserves null through legacy synthesis', () => {
            const legacy = {
                id: 'null-id',
                format_version: 0,
                sources: [{
                    host_path: '/repo',
                    repository_root: '/repo',
                    source_prefix: '',
                    mount_name: '',
                }],
                baseline_commit_sha: null,
                branch_creation_point_sha: null,
                created_at: '2026-01-01T00:00:00.000Z',
                container_name: 'patchlab-null',
                container_image: 'node:22-slim',
            };
            const file_path = path.join(temporary_directory, 'manifest.json');
            fs.writeFileSync(file_path, JSON.stringify(legacy, null, 2), 'utf-8');

            const read = read_manifest(temporary_directory);
            expect(read.baseline_commit_shas).toEqual({ '/repo': null });
            expect(read.branch_creation_point_shas).toEqual({ '/repo': null });
        });
    });

    describe('manifest_primary_source', () => {
        it('returns the first source for a single-source manifest', () => {
            const manifest = create_manifest(
                'primary-test-id',
                [make_source('/repo/src', '/repo', 'src')],
                'patchlab-test',
                'node:22-slim',
            );
            const primary = manifest_primary_source(manifest);
            expect(primary.host_path).toBe('/repo/src');
            expect(primary.source_prefix).toBe('src');
        });

        it('returns sources[0] for a multi-source manifest', () => {
            const manifest = create_manifest(
                'primary-multi-id',
                [
                    make_source('/repo/src/ui', '/repo', 'src/ui'),
                    make_source('/repo/src/server', '/repo', 'src/server'),
                ],
                'patchlab-test',
                'node:22-slim',
            );
            const primary = manifest_primary_source(manifest);
            expect(primary.source_prefix).toBe('src/ui');
            expect(manifest.sources).toHaveLength(2);
        });

        it('throws when sources is empty (defense in depth)', () => {
            const manifest = create_manifest(
                'empty-test-id',
                [make_source('/repo', '/repo', '')],
                'patchlab-test',
                'node:22-slim',
            );
            // Force the empty state for the helper guard. Production callers
            // can never reach this because create_manifest rejects empty
            // sources at write time and read_manifest rejects on read.
            manifest.sources = [];
            expect(() => manifest_primary_source(manifest)).toThrow(/at least one source/i);
        });
    });

    describe('read_manifest field validation', () => {
        function write_raw_manifest(raw: unknown): void {
            fs.writeFileSync(
                path.join(temporary_directory, 'manifest.json'),
                JSON.stringify(raw, null, 2),
                'utf-8',
            );
        }

        function valid_manifest_payload(): Record<string, unknown> {
            return {
                id: 'corrupt-test-id',
                format_version: CURRENT_FORMAT_VERSION,
                sources: [
                    {
                        host_path: '/repo/src',
                        repository_root: '/repo',
                        source_prefix: 'src',
                        mount_name: 'src',
                    },
                ],
                baseline_commit_shas: { '/repo': null },
                branch_creation_point_shas: { '/repo': null },
                created_at: '2026-04-25T00:00:00.000Z',
                container_name: 'patchlab-test',
                container_image: 'node:22-slim',
            };
        }

        it('rejects a parsed JSON root that is an array', () => {
            fs.writeFileSync(
                path.join(temporary_directory, 'manifest.json'),
                JSON.stringify([1, 2, 3]),
                'utf-8',
            );
            expect(() => read_manifest(temporary_directory)).toThrow(/expected the parsed JSON to be an object/);
        });

        it.each(['id', 'created_at', 'container_name', 'container_image'])(
            'rejects a manifest missing required field "%s"',
            (field) => {
                const payload = valid_manifest_payload();
                delete payload[field];
                write_raw_manifest(payload);
                expect(() => read_manifest(temporary_directory))
                    .toThrow(new RegExp(`"${field}".*string`));
            },
        );

        it('rejects a manifest where id is a number', () => {
            const payload = valid_manifest_payload();
            payload.id = 42;
            write_raw_manifest(payload);
            expect(() => read_manifest(temporary_directory)).toThrow(/"id".*number/);
        });

        it('rejects a manifest where baseline_commit_shas is an array', () => {
            const payload = valid_manifest_payload();
            payload.baseline_commit_shas = ['/repo'];
            write_raw_manifest(payload);
            expect(() => read_manifest(temporary_directory))
                .toThrow(/baseline_commit_shas.*array/);
        });

        it('rejects a manifest where a SHA-map entry is not a string or null', () => {
            const payload = valid_manifest_payload();
            payload.branch_creation_point_shas = { '/repo': 42 };
            write_raw_manifest(payload);
            expect(() => read_manifest(temporary_directory))
                .toThrow(/branch_creation_point_shas.*\/repo.*number/);
        });

        it('rejects a manifest whose sources entry is null (not an object)', () => {
            // Each entry in `sources` must be a non-null object. A null entry
            // would otherwise reach the field-shape validator with no fields
            // present and produce a less-specific error; the explicit
            // not-an-object guard pins the failure to the entry index.
            const payload = valid_manifest_payload();
            payload.sources = [null];
            write_raw_manifest(payload);
            expect(() => read_manifest(temporary_directory))
                .toThrow(/sources\[0\].*is not an object/);
        });

        it('rejects a manifest whose sources entry is missing required string fields', () => {
            // The `host_path`/`repository_root`/`source_prefix`/`mount_name`
            // quartet are all required strings. Set host_path to a number to
            // trigger the TypeError that names the missing-fields contract.
            const payload = valid_manifest_payload();
            payload.sources = [{
                host_path: 42,
                repository_root: '/repo',
                source_prefix: 'src',
                mount_name: 'src',
            }];
            write_raw_manifest(payload);
            expect(() => read_manifest(temporary_directory))
                .toThrow(/sources\[0\].*missing required fields/);
        });
    });

    describe('create_manifest writer-side guards', () => {
        it('rejects an empty sources array', () => {
            // The writer-side symmetric counterpart of `read_manifest`'s
            // `at least one source` guard. A regression that allowed
            // sources=[] through `create_manifest` would produce a manifest
            // that fails its own re-read.
            expect(() => create_manifest('id', [], 'patchlab-test', 'node:22-slim'))
                .toThrow(/non-empty/);
        });

        it('rejects a source whose host_path != path.join(repository_root, source_prefix)', () => {
            // The writer invariant: every emitted source MUST satisfy the
            // path-join equality. A regression that constructed an
            // inconsistent source would later fail manifest read and confuse
            // the resume/extract paths. This catches the construction-time
            // case before the manifest is written.
            const inconsistent: Source_Specification = {
                host_path: '/repo/src',      // declared as `lib` below — does not match
                repository_root: '/repo',
                source_prefix: 'lib',
                mount_name: 'lib',
            };
            expect(() => create_manifest('id', [inconsistent], 'patchlab-test', 'node:22-slim'))
                .toThrow(/writer invariant violated/);
        });
    });
});
