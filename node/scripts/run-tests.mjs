import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const testsDirectory = new URL('../tests/', import.meta.url);
const testFiles = readdirSync(testsDirectory)
  .filter((file) => file.endsWith('.test.ts'))
  .sort();

for (const testFile of testFiles) {
  const result = spawnSync(
    process.execPath,
    [tsxCli, '--test', fileURLToPath(new URL(testFile, testsDirectory))],
    { stdio: 'inherit' },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
