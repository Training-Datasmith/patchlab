import { beforeAll } from 'vitest';
import { ensure_container_runtime } from '../../src/container_runtime.js';
import { resolve_runtime_prompter } from '../../src/cli_prompter.js';
import { ensure_integration_test_tool_registered } from '../test_helpers.js';
import { install_isolated_patchlab_home_hooks } from '../helpers/home_directory.js';

// Every integration worker gets an isolated PATCHLAB_HOME so archives never
// land in the developer's real ~/.patchlab/. When CI sets PATCHLAB_HOME to a
// fixed path, reuse it so post-test cleanup verification can inspect it.
install_isolated_patchlab_home_hooks('patchlab-integration-', { scope: 'all' });

// The unit vitest project pins PATCHLAB_CONTAINER_RUNTIME=podman for argv-shape
// tests. When `npm test` runs unit then integration in one process, that pin
// leaks and breaks macOS integration/CLI subprocess tests — clear it here so
// auto-detect picks nerdctl on Darwin. Linux CI sets the env var at the job
// level before vitest starts; this delete runs in the integration worker after
// unit workers may have set it, so re-apply the job-level value when present
// in the original environment is not needed — CI re-exports it per job step.
// Preserve job-level runtime pins (CI macOS nerdctl / Linux podman shards). Only
// clear a leaked unit-project pin when no explicit runtime was requested.
if (process.platform === 'darwin' && process.env.PATCHLAB_CONTAINER_RUNTIME === undefined) {
    delete process.env.PATCHLAB_CONTAINER_RUNTIME;
}

// Ensure Podman is running before any test file that uses containers.
// This runs once per worker — ensure_podman caches its result so
// subsequent calls within the same process are no-ops. Integration
// tests run with vitest's piped stdin, so `resolve_runtime_prompter()`
// returns `null`; if the podman machine is in a bad state the
// non-interactive `process.exit(1)` path fires rather than a hanging
// prompt — surface the bad state instead of hiding it.
beforeAll(async () => {
    ensure_integration_test_tool_registered();
    await ensure_container_runtime(resolve_runtime_prompter());
}, 120_000);
