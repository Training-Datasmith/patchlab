import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert_present } from '../helpers/assert_present.js';

/** Types third-party Tool_Provider implementations need from the package root. */
const REQUIRED_PROVIDER_TYPE_EXPORTS = [
    'Authentication_Method',
    'Authentication_Result',
    'Extractable_Artifact',
    'Host_Access_Plan',
    'Host_File_Copy',
    'Image_Specification',
    'Launch_Context',
    'Prepare_Host_Access_Context',
    'Prompt_Launch_Context',
    'Prompt_Passthrough_Capability',
    'Tool_Provider',
] as const;

describe('package.json runtime metadata (R7)', () => {
    it('declares Node 20+ to match Commander and README', () => {
        const package_json = JSON.parse(
            fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'),
        ) as { engines?: { node?: string } };

        expect(package_json.engines?.node).toBe('>=20');
    });

    it('declares repository and GitHub issues URL for npm metadata', () => {
        const package_json = JSON.parse(
            fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'),
        ) as {
            repository?: { type?: string; url?: string };
            bugs?: { url?: string };
            homepage?: string;
        };

        expect(package_json.repository).toEqual({
            type: 'git',
            url: 'git+https://github.com/Training-Datasmith/patchlab.git',
        });
        expect(package_json.bugs).toEqual({
            url: 'https://github.com/Training-Datasmith/patchlab/issues',
        });
        expect(package_json.homepage).toBeUndefined();
    });
});

describe('public package API (R12)', () => {
    it('declares an exports map for the package root entry', () => {
        const package_json = JSON.parse(
            fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'),
        ) as {
            exports?: Record<string, { types?: string; import?: string; default?: string }>;
        };

        expect(package_json.exports?.['.']).toEqual({
            types: './dist/index.d.ts',
            import: './dist/index.js',
            require: './dist/index.js',
            default: './dist/index.js',
        });
    });

    it('exports provider registration and host-access constants from the package root', async () => {
        const package_root = await import('../../src/index.js');

        expect(typeof package_root.register_provider).toBe('function');
        expect(package_root.HOST_PATCHLAB_INTERNAL).toBe('host.patchlab.internal');
    });

    it('builds declaration exports for Tool_Provider implementation types', () => {
        const declaration_path = path.join(process.cwd(), 'dist', 'index.d.ts');
        expect(fs.existsSync(declaration_path)).toBe(true);

        const declarations = fs.readFileSync(declaration_path, 'utf-8');
        for (const export_name of REQUIRED_PROVIDER_TYPE_EXPORTS) {
            expect(declarations).toContain(export_name);
        }
    });
});

describe('production dependency audit (R8)', () => {
    it('locks brace-expansion to a fixed release (>=5.0.9)', () => {
        const lockfile = JSON.parse(
            fs.readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf-8'),
        ) as {
            packages?: Record<string, { version?: string }>;
        };

        const version = lockfile.packages?.['node_modules/brace-expansion']?.version;
        assert_present(version);

        const [major, minor, patch] = version.split('.').map(Number);
        const fixed = major > 5
            || (major === 5 && minor > 0)
            || (major === 5 && minor === 0 && patch >= 9);
        expect(fixed).toBe(true);
    });
});
