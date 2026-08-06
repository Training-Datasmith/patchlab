import { beforeAll } from 'vitest';
import { ensure_podman } from '../../src/podman.js';
import { resolve_runtime_prompter } from '../../src/cli_prompter.js';
import { ensure_integration_test_tool_registered } from '../test_helpers.js';

// Ensure Podman is running before any test file that uses containers.
// This runs once per worker — ensure_podman caches its result so
// subsequent calls within the same process are no-ops. Integration
// tests run with vitest's piped stdin, so `resolve_runtime_prompter()`
// returns `null`; if the podman machine is in a bad state the
// non-interactive `process.exit(1)` path fires rather than a hanging
// prompt — surface the bad state instead of hiding it.
beforeAll(async () => {
    ensure_integration_test_tool_registered();
    await ensure_podman(resolve_runtime_prompter());
}, 120_000);
