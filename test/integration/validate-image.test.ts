/**
 * Coverage for `validate_image` and `validate_or_remove_image`.
 *
 * Builds minimal fixture images in `beforeAll` so the validate-against-real-
 * image branches always exercise without relying on incidental dev-machine state.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    validate_image,
    validate_or_remove_image,
    PATCHLAB_TEST_LABEL,
    remove_test_images,
} from '../../src/images.js';
import { image_exists } from '../../src/podman.js';
import { DEFAULT_TEST_TOOL, register_default_test_tool } from '../helpers/stub_tool_provider.js';

const VALID_FIXTURE_TAG = 'patchlab/validate-image-fixture-base:latest';
const AUTH_FIXTURE_TAG = 'patchlab/validate-image-fixture-auth:latest';
const DUMMY_TAG = 'patchlab/validate-test-dummy:latest';

function build_image_from_dockerfile(dockerfile: string, tag: string): void {
    const build_context = fs.mkdtempSync(path.join(os.tmpdir(), 'patchlab-validate-fixture-'));
    try {
        execFileSync('podman', ['build', '-t', tag, '-f', '-', build_context], {
            input: dockerfile,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } finally {
        fs.rmSync(build_context, { recursive: true, force: true });
    }
}

beforeAll(() => {
    register_default_test_tool();

    build_image_from_dockerfile(
        String.raw`FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
LABEL biz.ecartz.patchlab.compatible="true"
LABEL biz.ecartz.patchlab.tools="${DEFAULT_TEST_TOOL}"
LABEL biz.ecartz.patchlab.tool.${DEFAULT_TEST_TOOL}="installed"
LABEL ${PATCHLAB_TEST_LABEL}="true"
`,
        VALID_FIXTURE_TAG,
    );

    build_image_from_dockerfile(
        `FROM ${VALID_FIXTURE_TAG}
LABEL biz.ecartz.patchlab.tool.${DEFAULT_TEST_TOOL}="authenticated"
LABEL ${PATCHLAB_TEST_LABEL}="true"
`,
        AUTH_FIXTURE_TAG,
    );
}, 600_000);

afterAll(() => {
    remove_test_images();
});

describe('validate_image', () => {
    it('returns invalid for a non-existent image', () => {
        const result = validate_image('patchlab/does-not-exist:latest');
        expect(result.valid).toBe(false);
        expect(result.reasons).toContain('image does not exist');
    });

    it('returns valid for a base image with git and a registered stub provider', () => {
        const result = validate_image(VALID_FIXTURE_TAG, DEFAULT_TEST_TOOL);
        expect(result.valid).toBe(true);
        expect(result.reasons).toEqual([]);
    });

    it('returns valid for an authenticated-labeled image with git and a registered stub provider', () => {
        const result = validate_image(AUTH_FIXTURE_TAG, DEFAULT_TEST_TOOL);
        expect(result.valid).toBe(true);
        expect(result.reasons).toEqual([]);
    });
});

describe('validate_or_remove_image', () => {
    it('removes an invalid image', () => {
        build_image_from_dockerfile(
            `FROM node:22-slim
LABEL biz.ecartz.patchlab.compatible="true"
LABEL biz.ecartz.patchlab.tools="${DEFAULT_TEST_TOOL}"
LABEL ${PATCHLAB_TEST_LABEL}="true"
`,
            DUMMY_TAG,
        );

        expect(image_exists(DUMMY_TAG)).toBe(true);

        const result = validate_or_remove_image(DUMMY_TAG, DEFAULT_TEST_TOOL);
        expect(result.valid).toBe(false);
        expect(result.reasons.some((reason) => reason.includes('git'))).toBe(true);
        expect(image_exists(DUMMY_TAG)).toBe(false);
    });

    it('does NOT remove a valid image', () => {
        expect(image_exists(VALID_FIXTURE_TAG)).toBe(true);

        const result = validate_or_remove_image(VALID_FIXTURE_TAG, DEFAULT_TEST_TOOL);
        expect(result.valid).toBe(true);
        expect(image_exists(VALID_FIXTURE_TAG)).toBe(true);
    });
});
