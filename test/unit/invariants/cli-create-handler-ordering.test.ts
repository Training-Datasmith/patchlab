/**
 * Structural lock for the `create` CLI handler in `src/cli.ts`.
 *
 * The `create` action must call `register_per_source_manifests` BEFORE
 * `get_provider(tool_name)`. If the order is reversed, a `--tool <name>`
 * referring to a per-source manifest fails with "unknown tool" because the
 * configured provider has not yet been registered into the process-scoped
 * registry — and the trust hook (which closes over the registration result)
 * would not be ready when Phase 1 iterates repos.
 *
 * Under `multi-source-trust` the flow is:
 *   1. resolve sources (`resolve_source_inputs`)
 *   2. register per-source manifests across every repository in the source set
 *      (`register_per_source_manifests`) — the registration result is captured
 *   3. build the Phase 1 trust hook closure (`build_phase_1_trust_prompt_hook`)
 *   4. resolve the provider (`get_provider`) — now finds per-source tool names
 *   5. call `create_sandbox_with_prompts` with the hook; Phase 1 fires the
 *      hook per repo for verify+marker write before any branch creation.
 *
 * `per-source-dispatch.test.ts` indirectly proves the current order works
 * end-to-end, but a future refactor that reorders the action body could
 * regress dispatch without breaking that test (e.g. by adding an early
 * pre-check that calls `get_provider` for validation). This file pins the
 * relative order textually so the reviewer sees the regression immediately.
 *
 * The `apply` CLI handler is locked in `non-gated-operations.test.ts` (task
 * 6.21) — the inverse property: it must NOT call either helper.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const this_file = fileURLToPath(import.meta.url);
const repo_root = path.resolve(path.dirname(this_file), '..', '..', '..');

function slice_command_block(cli_source: string, command_marker: string): string {
    const start = cli_source.indexOf(command_marker);
    expect(start).toBeGreaterThan(-1);
    const remainder = cli_source.slice(start + 1);
    const next = /\nprogram\b/.exec(remainder);
    const end = next !== null ? start + 1 + next.index : cli_source.length;
    return cli_source.slice(start, end);
}

describe('create CLI handler: per-source registration runs before get_provider', () => {
    it('register_per_source_manifests appears before get_provider in the create action body', () => {
        const cli_source = fs.readFileSync(path.join(repo_root, 'src', 'cli.ts'), 'utf-8');
        const create_block = slice_command_block(cli_source, ".command('create')");

        // Match the function CALL (open paren) not a comment mention. The
        // create handler's body contains an explanatory comment that names
        // `get_provider` — counting that as the ordering anchor would lock
        // the comment's existence, not the dispatch order.
        const register_index = create_block.indexOf('register_per_source_manifests(');
        const get_provider_index = create_block.indexOf('get_provider(');

        expect(register_index).toBeGreaterThan(-1);
        expect(get_provider_index).toBeGreaterThan(-1);
        expect(register_index).toBeLessThan(get_provider_index);
    });

    it('the create action resolves sources before calling register_per_source_manifests', () => {
        // register_per_source_manifests takes the distinct repository roots
        // (derived from the resolved sources). Resolving the source set
        // AFTER the call would be a bug — the test catches a reorder that
        // moves `resolve_source_inputs(...)` below the registration call.
        const cli_source = fs.readFileSync(path.join(repo_root, 'src', 'cli.ts'), 'utf-8');
        const create_block = slice_command_block(cli_source, ".command('create')");

        const sources_resolution = create_block.indexOf('resolve_source_inputs(');
        const register_index = create_block.indexOf('register_per_source_manifests(');

        expect(sources_resolution).toBeGreaterThan(-1);
        expect(register_index).toBeGreaterThan(-1);
        expect(sources_resolution).toBeLessThan(register_index);
    });

    it('the create action verifies per-source default_tool before get_provider', () => {
        const cli_source = fs.readFileSync(path.join(repo_root, 'src', 'cli.ts'), 'utf-8');
        const create_block = slice_command_block(cli_source, ".command('create')");

        const verify_default_tool_index = create_block.indexOf('verify_per_source_default_tool(');
        const get_provider_index = create_block.indexOf('get_provider(');

        expect(verify_default_tool_index).toBeGreaterThan(-1);
        expect(get_provider_index).toBeGreaterThan(-1);
        expect(verify_default_tool_index).toBeLessThan(get_provider_index);
    });

    it('the create action registers per-source manifests before default_tool verify', () => {
        const cli_source = fs.readFileSync(path.join(repo_root, 'src', 'cli.ts'), 'utf-8');
        const create_block = slice_command_block(cli_source, ".command('create')");

        const register_index = create_block.indexOf('register_per_source_manifests(');
        const verify_default_tool_index = create_block.indexOf('verify_per_source_default_tool(');

        expect(register_index).toBeGreaterThan(-1);
        expect(verify_default_tool_index).toBeGreaterThan(-1);
        expect(register_index).toBeLessThan(verify_default_tool_index);
    });

    it('the create action verifies per-source default_tool before building any image', () => {
        const cli_source = fs.readFileSync(path.join(repo_root, 'src', 'cli.ts'), 'utf-8');
        const create_block = slice_command_block(cli_source, ".command('create')");

        const verify_default_tool_index = create_block.indexOf('verify_per_source_default_tool(');
        const ensure_image_index = create_block.indexOf('ensure_default_image(');

        expect(verify_default_tool_index).toBeGreaterThan(-1);
        expect(ensure_image_index).toBeGreaterThan(-1);
        expect(verify_default_tool_index).toBeLessThan(ensure_image_index);
    });

    it('the create action verifies per-source trust BEFORE building any image', () => {
        // A per-source provider's `dockerfile.install` lines run as `RUN`
        // directives during ensure_default_image's `podman build`, and the
        // trust prompt discloses exactly those commands (and the base_image)
        // for approval. Building the image before the prompt would execute
        // unapproved manifest content on the host. Lock the ordering so a
        // reorder that moves the build ahead of the verification regresses
        // visibly. (verify_per_source_trust_multi_repository is also re-run
        // inside Phase 1 as a defense-in-depth gate, but this upfront call is
        // the one that protects the build.)
        const cli_source = fs.readFileSync(path.join(repo_root, 'src', 'cli.ts'), 'utf-8');
        const create_block = slice_command_block(cli_source, ".command('create')");

        const verify_index = create_block.indexOf('verify_per_source_trust_multi_repository(');
        const ensure_image_index = create_block.indexOf('ensure_default_image(');

        expect(verify_index).toBeGreaterThan(-1);
        expect(ensure_image_index).toBeGreaterThan(-1);
        expect(verify_index).toBeLessThan(ensure_image_index);
    });

    it('the create action calls create_sandbox after register_per_source_manifests and trust verification', () => {
        // register_per_source_manifests populates the provider registry (so
        // get_provider works for per-source tool names) AND creates the
        // registration result that create_sandbox re-uses internally for trust
        // verification. Both must precede the create_sandbox call.
        const cli_source = fs.readFileSync(path.join(repo_root, 'src', 'cli.ts'), 'utf-8');
        const create_block = slice_command_block(cli_source, ".command('create')");

        const register_index = create_block.indexOf('register_per_source_manifests(');
        const verify_index = create_block.indexOf('verify_per_source_trust_multi_repository(');
        const create_sandbox_index = create_block.indexOf('create_sandbox(');

        expect(register_index).toBeGreaterThan(-1);
        expect(verify_index).toBeGreaterThan(-1);
        expect(create_sandbox_index).toBeGreaterThan(-1);
        expect(register_index).toBeLessThan(verify_index);
        expect(verify_index).toBeLessThan(create_sandbox_index);
    });
});
