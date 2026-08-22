import * as fs from 'node:fs';
import * as path from 'node:path';
import { PATCHLAB_DIRECTORY } from '../../src/archive.js';
import { destroy_sandbox } from '../../src/sandbox/index.js';

const PATCHLAB_CREATED_PATTERN = /Patchlab created:\s*(\S+)/g;

/** Parse sandbox ids from combined CLI stdout/stderr. */
export function extract_created_sandbox_ids(cli_output: string): string[] {
    const sandbox_ids: string[] = [];
    for (const match of cli_output.matchAll(PATCHLAB_CREATED_PATTERN)) {
        sandbox_ids.push(match[1]);
    }
    return sandbox_ids;
}

function list_sandbox_ids_under_patchlab_home(patchlab_home: string): string[] {
    const archive_root = path.join(patchlab_home, PATCHLAB_DIRECTORY);
    if (!fs.existsSync(archive_root)) {
        return [];
    }

    return fs.readdirSync(archive_root).filter((entry) => {
        try {
            return fs.statSync(path.join(archive_root, entry)).isDirectory();
        } catch {
            return false;
        }
    });
}

/**
 * Tear down sandboxes created by CLI subprocess tests that isolate
 * `PATCHLAB_HOME` into a temp directory. The same sandbox id may be passed
 * more than once (for example when a test reuses one sandbox across multiple
 * CLI calls); each id is destroyed at most once.
 */
export async function destroy_cli_subprocess_sandboxes(
    patchlab_home: string,
    options?: { extra_sandbox_ids?: Iterable<string> },
): Promise<void> {
    const sandbox_ids = new Set<string>([
        ...list_sandbox_ids_under_patchlab_home(patchlab_home),
        ...(options?.extra_sandbox_ids ?? []),
    ]);
    if (sandbox_ids.size === 0) {
        return;
    }

    const original_patchlab_home = process.env.PATCHLAB_HOME;
    process.env.PATCHLAB_HOME = patchlab_home;
    try {
        for (const sandbox_id of sandbox_ids) {
            try {
                await destroy_sandbox(sandbox_id, { force: true });
            } catch {
                // Intentional: teardown is best-effort. A prior destroy in the
                // same afterEach hook may already have removed the archive.
            }
        }
    } finally {
        if (original_patchlab_home === undefined) {
            delete process.env.PATCHLAB_HOME;
        } else {
            process.env.PATCHLAB_HOME = original_patchlab_home;
        }
    }
}
