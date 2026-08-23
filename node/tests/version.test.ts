import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/core/version.ts';

// The heal API reads the User-Agent to know which client is calling. A release
// that bumps package.json and forgets src/core/version.ts would keep reporting
// the old one, silently, forever. Fail here instead.
test('VERSION matches package.json', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  assert.equal(VERSION, pkg.version);
});

test('VERSION is a plain semver string', () => {
  // It is pasted straight into a header; anything else would ship a malformed
  // User-Agent rather than fail loudly.
  assert.match(VERSION, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});
