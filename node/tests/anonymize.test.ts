import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeHealedBody, stripRequest } from '../src/core/anonymize.ts';

// The privacy boundary is stated once, in ../../tests/anonymize-cases.json, and
// run here and in python/tests/test_anonymize.py. Twin packages that agree
// because they read the same table, not because someone compared them by eye.
interface Case {
  name: string;
  request: Record<string, unknown>;
  sent?: Record<string, unknown>;
  healed?: Record<string, unknown>;
  replay?: Record<string, unknown>;
}
const cases = JSON.parse(
  readFileSync(new URL('../../tests/anonymize-cases.json', import.meta.url), 'utf8'),
) as { strip: Case[]; strip_send_messages: Case[]; merge: Required<Case>[] };

for (const c of cases.strip) {
  test(`strip: ${c.name}`, () => {
    assert.deepEqual(stripRequest(c.request), c.sent);
  });
}

for (const c of cases.strip_send_messages) {
  test(`strip with sendMessages: ${c.name}`, () => {
    assert.deepEqual(stripRequest(c.request, { sendMessages: true }), c.sent);
  });
}

for (const c of cases.merge) {
  test(`merge: ${c.name}`, () => {
    assert.deepEqual(mergeHealedBody(c.request, c.healed), c.replay);
  });
}

// Whatever the table says, no secret is allowed to appear anywhere in the bytes
// that actually go out — a nesting the table's own expectations got wrong would
// still be caught here.
test('nothing marked SECRET survives the strip, in any case in the table', () => {
  for (const c of cases.strip) {
    const wire = JSON.stringify(stripRequest(c.request));
    for (const secret of ['SECRET', 'THE USERS WHOLE DOCUMENT', 'acme-42', 'user-99',
      'sid-1', 'cache-1', 'MCP_BEARER']) {
      assert.equal(wire.includes(secret), false, `${c.name}: ${secret}`);
    }
  }
});

test('stripRequest copies — the caller\'s own request is never touched', () => {
  const original = {
    model: 'm',
    thinking: { type: 'enabled', budget_tokens: 8000 },
    modalities: ['text'],
  };
  const stripped = stripRequest(original);
  (stripped.thinking as Record<string, unknown>).budget_tokens = 1;
  (stripped.modalities as string[]).push('audio');
  assert.deepEqual(original.thinking, { type: 'enabled', budget_tokens: 8000 });
  assert.deepEqual(original.modalities, ['text']);
});

test('mergeHealedBody mutates neither argument', () => {
  const original = { model: 'a', messages: ['m'], thinking: { type: 'enabled' } };
  const healed = { model: 'b', thinking: { type: 'disabled' } };
  mergeHealedBody(original, healed);
  assert.deepEqual(original, { model: 'a', messages: ['m'], thinking: { type: 'enabled' } });
  assert.deepEqual(healed, { model: 'b', thinking: { type: 'disabled' } });
});

// A polluted prototype is a live transitive-dependency vuln class. The walk
// rebuilds every level from own entries, so an inherited key is not the
// caller's request and does not become part of what travels.
test('an inherited key is neither disclosed nor replayed', () => {
  (Object.prototype as unknown as Record<string, unknown>).temperature = 9;
  try {
    assert.deepEqual(stripRequest({ model: 'm' }), { model: 'm' });
    assert.deepEqual(mergeHealedBody({ model: 'm' }, { model: 'm' }), { model: 'm' });
  } finally {
    delete (Object.prototype as unknown as Record<string, unknown>).temperature;
  }
});
