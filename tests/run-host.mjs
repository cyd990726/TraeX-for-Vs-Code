import { runTests } from '@vscode/test-electron';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
delete process.env.ELECTRON_RUN_AS_NODE;
const directory = await mkdtemp(join(tmpdir(), 'trae-host-'));
const workspace = join(directory, 'workspace');
const { mkdir } = await import('node:fs/promises');
await mkdir(workspace);
try {
  await runTests({
    ...(process.env.VSCODE_EXECUTABLE ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE } : process.platform === 'darwin' ? { vscodeExecutablePath: '/Applications/Visual Studio Code.app/Contents/MacOS/Code' } : {}),
    extensionDevelopmentPath: resolve('.'), extensionTestsPath: resolve('tests/host.cjs'),
    extensionTestsEnv: { TRAE_TEST_ROOT: resolve('.'), TRAE_TEST_NODE: process.execPath },
    launchArgs: [workspace, '--disable-extensions', '--extensions-dir', join(directory, 'extensions'), '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--user-data-dir', join(directory,'profile')]
  });
} finally { await rm(directory, { recursive: true, force: true }); }
