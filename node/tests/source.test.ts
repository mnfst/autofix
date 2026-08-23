import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { detectSource, type SdkSource } from '../src/core/source.ts';
import { autofix } from '../src/index.ts';

test('classifies each SDK family from its real user-agent shape', () => {
  const cases: Array<[string, string]> = [
    ['OpenAI/JS 7.4.0', 'openai-sdk'],
    ['AzureOpenAI/JS 7.4.0', 'openai-sdk'],
    ['Anthropic/JS 0.115.0', 'anthropic-sdk'],
    ['ai-sdk/openai/4.0.32 ai-sdk/provider-utils/5.0.23 runtime/node/22.11.0', 'vercel-sdk'],
    ['ai-sdk/anthropic/4.0.33 runtime/node/22.11.0', 'vercel-sdk'],
    ['curl/8.6.0', 'unknown'],
    ['', 'unknown'],
  ];
  for (const [ua, expected] of cases) {
    assert.equal(detectSource(new Headers(ua ? { 'user-agent': ua } : {})), expected, ua || '(empty)');
  }
});

test('the ai-sdk suffix wins over an official-SDK prefix', () => {
  // withUserAgentSuffix APPENDS: a custom fetch chain can carry both tokens.
  const both = new Headers({ 'user-agent': 'OpenAI/JS 7.4.0 ai-sdk/openai/4.0.32' });
  assert.equal(detectSource(both), 'vercel-sdk');
});

test('no user-agent at all is unknown', () => {
  assert.equal(detectSource(new Headers()), 'unknown');
});

// The one caller lives on the fetch path, where the value in hand is
// `init.headers` — a HeadersInit that engine.ts already has to cast and wrap.
// A `Headers` annotation is erased at runtime, so a caller that skips the wrap
// would otherwise throw `headers.get is not a function` out of the wrapper on
// every request: worse than not using autofix at all.
test('a value that is not a Headers falls open instead of throwing', () => {
  for (const notHeaders of [{}, undefined, null, { 'user-agent': 'OpenAI/JS 7.4.0' }]) {
    assert.equal(detectSource(notHeaders as unknown as Headers), 'unknown');
  }
});

const OPENAI = 'https://api.openai.com/v1/chat/completions';
const HEAL_URL = 'http://heal.test';

const chatBody = {
  model: 'gpt-5-mini', temperature: 0.2,
  messages: [{ role: 'user', content: 'SECRET' }],
};
const err400 = () => new Response(JSON.stringify({
  error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model.",
    type: 'invalid_request_error', param: 'temperature', code: 'unsupported_value' },
}), { status: 400 });
const ok200 = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

function providerStub(script: Array<() => Response>) {
  const calls: { body: Record<string, unknown> }[] = [];
  const fn = (async (_input: unknown, init?: RequestInit) => {
    calls.push({ body: JSON.parse(init?.body as string) as Record<string, unknown> });
    return script[Math.min(calls.length - 1, script.length - 1)]!();
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

const realFetch = globalThis.fetch;
let healCalls: { method: string; headers: Record<string, string> }[] = [];

beforeEach(() => {
  process.env.AUTOFIX_URL = HEAL_URL;
  healCalls = [];
  globalThis.fetch = (async (input: never, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(HEAL_URL)) {
      healCalls.push({ method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers as HeadersInit | undefined)) });
      return new Response(JSON.stringify({
        status: 'unverified', issueId: 'i1', healAttemptId: 'a1',
        healedBody: { model: 'gpt-5-mini', temperature: 1 },
      }), { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.AUTOFIX_URL;
});

const post = (headers: Record<string, string>): RequestInit => ({
  method: 'POST', headers, body: JSON.stringify(chatBody),
});

async function outcomeReported() {
  await new Promise((r) => setTimeout(r, 20)); // fire-and-forget PATCH
}

// The user-agent each SDK actually sends, per source.ts's fingerprint table.
const UA_BY_SOURCE: Record<Exclude<SdkSource, 'unknown'>, string> = {
  'openai-sdk': 'OpenAI/JS 7.4.0',
  'anthropic-sdk': 'Anthropic/JS 0.115.0',
  'vercel-sdk': 'ai-sdk/openai/4.0.32 ai-sdk/provider-utils/5.0.23 runtime/node/22.11.0',
};

test('heal POST and outcome PATCH both carry the detected source', async () => {
  for (const [source, ua] of Object.entries(UA_BY_SOURCE)) {
    healCalls = [];
    const provider = providerStub([err400, ok200]);
    const fx = autofix({ fetch: provider.fn });
    const res = await fx(OPENAI, post({ 'user-agent': ua, authorization: 'Bearer sk-test' }));
    assert.equal(res.status, 200, source);
    await outcomeReported();
    assert.deepEqual(healCalls.map((c) => c.method), ['POST', 'PATCH'], source);
    for (const call of healCalls) {
      assert.equal(call.headers['x-autofix-source'], source, call.method);
    }
  }
});

// The heal API 400s `x-autofix-source: unknown`, and a 400 is a dead heal. An
// absent header is the same information at no cost, so absence is the assertion
// — an empty-string value would be just as rejected.
test('a bare fetch with no SDK fingerprint sends no source header at all', async () => {
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn });
  const res = await fx(OPENAI, post({}));
  assert.equal(res.status, 200);
  await outcomeReported();
  assert.deepEqual(healCalls.map((c) => c.method), ['POST', 'PATCH']);
  for (const call of healCalls) {
    assert.equal('x-autofix-source' in call.headers, false, call.method);
  }
});

// No `headers` key at all — not even an empty object — and a plain URL string,
// so there is nowhere to look. Classification must still answer, not throw.
test('a request carrying no headers at all reports unknown', async () => {
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn });
  await fx(OPENAI, { method: 'POST', body: JSON.stringify(chatBody) });
  assert.equal('x-autofix-source' in healCalls[0]!.headers, false);
});

test('headers living on a Request object still classify', async () => {
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn });
  const req = new Request(OPENAI, { method: 'POST', headers: { 'user-agent': 'OpenAI/JS 7.4.0' } });
  await fx(req, { method: 'POST', body: JSON.stringify(chatBody) });
  assert.equal(healCalls[0]!.headers['x-autofix-source'], 'openai-sdk');
});

// A HeadersInit the Headers constructor refuses (a pair-array row of three)
// used to throw inside the gate, where the catch turned it into "no heal
// attempted at all", silently and with no event. Classification is analytics;
// the heal is the product.
test('a malformed HeadersInit costs the classification, never the heal', async () => {
  const provider = providerStub([err400, ok200]);
  const events: string[] = [];
  const fx = autofix({ fetch: provider.fn, onHeal: (e) => events.push(e.healStatus) });
  await fx(OPENAI, {
    method: 'POST', body: JSON.stringify(chatBody),
    headers: [['user-agent', 'OpenAI/JS 7.4.0', 'extra']] as unknown as HeadersInit,
  });
  assert.equal(healCalls.length, 1, 'the heal was asked for');
  assert.equal('x-autofix-source' in healCalls[0]!.headers, false);
  assert.deepEqual(events, ['replay_failed'], 'and the caller can see what happened');
});

test('raw caller headers never reach the heal API', async () => {
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn });
  await fx(OPENAI, post({
    'user-agent': 'OpenAI/JS 7.4.0', 'x-stainless-os': 'MacOS', authorization: 'Bearer sk-test',
  }));
  const sent = healCalls[0]!.headers;
  assert.equal('x-stainless-os' in sent, false, 'stainless telemetry stripped');
  assert.equal('authorization' in sent, false, 'caller auth never travels');
  assert.match(sent['user-agent']!, /^autofix-node\//, 'UA is the engine, not the caller');
});

// The incident this pins (issue #11): the client emitted `vercel-ai-sdk` and
// `unknown`, the heal API accepts neither, and every 400 it answered killed the
// heal outright — healing was dead for all AI SDK traffic. The list below is a
// hardcoded copy of the server's accepted set, never fetched: a rename on this
// side has to fail here rather than in production.
test('every source the client can emit is one the heal API accepts', async () => {
  const ACCEPTED_BY_SERVER = ['anthropic-sdk', 'openai-sdk', 'vercel-sdk'];
  const emitted: string[] = [];
  for (const ua of [...Object.values(UA_BY_SOURCE), 'curl/8.6.0']) {
    healCalls = [];
    const provider = providerStub([err400, ok200]);
    await autofix({ fetch: provider.fn })(OPENAI, post({ 'user-agent': ua }));
    const value = healCalls[0]!.headers['x-autofix-source'];
    if (value !== undefined) emitted.push(value);
  }
  assert.deepEqual(emitted.sort(), ACCEPTED_BY_SERVER,
    'anything else is a 400 from the heal API, which is a dead heal');
});
