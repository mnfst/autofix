import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureDir = join(packageDir, 'tests', 'package-smoke');
const scratchDir = mkdtempSync(join(tmpdir(), 'autofix-package-smoke-'));
let tarballPath;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

try {
  const packed = spawnSync('npm', ['pack', '--json'], {
    cwd: packageDir,
    encoding: 'utf8',
  });
  if (packed.error) throw packed.error;
  if (packed.status !== 0) {
    process.stderr.write(packed.stderr);
    throw new Error(`npm pack exited with status ${packed.status}`);
  }

  const [{ filename }] = JSON.parse(packed.stdout);
  tarballPath = join(packageDir, filename);

  for (const fixture of ['package.json', 'runtime.mjs', 'types.ts']) {
    copyFileSync(join(fixtureDir, fixture), join(scratchDir, fixture));
  }

  run('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarballPath,
  ], { cwd: scratchDir });
  run(process.execPath, [join(scratchDir, 'runtime.mjs')], { cwd: scratchDir });
  run(join(packageDir, 'node_modules', '.bin', 'tsc'), [
    '--noEmit',
    '--strict',
    '--target', 'ES2022',
    '--module', 'Node16',
    '--moduleResolution', 'Node16',
    '--lib', 'ES2022,DOM',
    join(scratchDir, 'types.ts'),
  ], { cwd: scratchDir });
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
  if (tarballPath) rmSync(tarballPath, { force: true });
}
