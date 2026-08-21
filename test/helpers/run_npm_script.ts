import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

/** Run an npm script cross-platform (`npm.cmd` resolution on Windows). */
export function run_npm_script(
    script: string,
    cwd: string,
): SpawnSyncReturns<string> {
    return spawnSync('npm', ['run', script], {
        cwd,
        stdio: 'pipe',
        encoding: 'utf8',
        shell: process.platform === 'win32',
    });
}
