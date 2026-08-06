import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { detect_requirements } from '../../../src/detect/index.js';

describe('detect_requirements with tool context', () => {
    let temp_dir: string;

    beforeEach(() => {
        temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-detect-ctx-'));
    });

    afterEach(() => {
        fs.rmSync(temp_dir, { recursive: true, force: true });
    });

    function write(relative_path: string, content: string): void {
        const full = path.join(temp_dir, relative_path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }

    describe('openspec detection with tool context', () => {
        it('uses gemini as default openspec tool name when no context', () => {
            write('openspec/config.yaml', 'schema: spec-driven\n');

            const result = detect_requirements(temp_dir);
            const npm_packages = result.npm_packages;
            const openspec_pkg = npm_packages.find(
                r => r.package === '@fission-ai/openspec',
            );

            expect(openspec_pkg).toBeDefined();
            if (openspec_pkg && openspec_pkg.type === 'npm_package' && openspec_pkg.init_command) {
                expect(openspec_pkg.init_command).toContain('gemini');
            }
        });

        it('uses provider openspec tool name when tool context is provided', () => {
            write('openspec/config.yaml', 'schema: spec-driven\n');

            const result = detect_requirements(temp_dir, { tool: 'gemini-cli-oauth' });
            const npm_packages = result.npm_packages;
            const openspec_pkg = npm_packages.find(
                r => r.package === '@fission-ai/openspec',
            );

            expect(openspec_pkg).toBeDefined();
            if (openspec_pkg && openspec_pkg.type === 'npm_package' && openspec_pkg.init_command) {
                expect(openspec_pkg.init_command).toContain('gemini');
            }
        });

        it('falls back to gemini when tool context has unknown tool', () => {
            write('openspec/config.yaml', 'schema: spec-driven\n');

            const result = detect_requirements(temp_dir, { tool: 'nonexistent' });
            const npm_packages = result.npm_packages;
            const openspec_pkg = npm_packages.find(
                r => r.package === '@fission-ai/openspec',
            );

            expect(openspec_pkg).toBeDefined();
            if (openspec_pkg && openspec_pkg.type === 'npm_package' && openspec_pkg.init_command) {
                expect(openspec_pkg.init_command).toContain('gemini');
            }
        });
    });

    describe('context does not affect other detectors', () => {
        it('detects non-openspec requirements regardless of tool context', () => {
            write('docker-compose.yml', 'services:\n  postgres:\n    image: postgres:15\n');

            const result = detect_requirements(temp_dir, { tool: 'gemini-cli-api' });
            expect(result.services.length).toBeGreaterThan(0);
        });
    });
});
