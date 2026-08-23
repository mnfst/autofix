import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { autofix, type HealEvent } from '../src/index.ts';

const HEAL_URL = 'http://heal.test';

const err400 = (message: string) => () => new Response(JSON.stringify({
  error: { message, type: 'invalid_request_error' },
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
let healCalls: { method: string; body: Record<string, unknown> | undefined;
  headers: Record<string, string> }[] = [];

beforeEach(() => {
  process.env.AUTOFIX_URL = HEAL_URL;
  healCalls = [];
  globalThis.fetch = (async (input: never, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(HEAL_URL)) {
      healCalls.push({ method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers as HeadersInit | undefined)) });
      return new Response(JSON.stringify({
        status: 'unverified', issueId: 'i1', healAttemptId: 'a1',
        healedBody: { model: 'fixed-model' },
      }), { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.AUTOFIX_URL;
});

// The AI SDK's real request shape: JSON string body, ai-sdk UA suffix.
const aiSdkInit = (body: Record<string, unknown>, provider: string): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'user-agent': `ai-sdk/${provider}/4.0.32 ai-sdk/provider-utils/5.0.23 runtime/node/22.11.0`,
  },
  body: JSON.stringify(body),
});

test('one fetch instance routes all three dialects to the right provider', async () => {
  const routes: Array<[string, string, string]> = [
    ['https://api.openai.com/v1/chat/completions', 'openai', 'chat_completions'],
    ['https://api.openai.com/v1/responses', 'openai', 'responses'],
    ['https://api.anthropic.com/v1/messages', 'anthropic', 'messages'],
  ];
  const stub = providerStub([err400('bad knob'), ok200, err400('bad knob'), ok200,
    err400('bad knob'), ok200]);
  const events: HealEvent[] = [];
  const fx = autofix({ fetch: stub.fn, onHeal: (e) => events.push(e) }); // ONE instance
  for (const [i, [url, provider, api]] of routes.entries()) {
    healCalls = [];
    const res = await fx(url, aiSdkInit({ model: 'm', max_tokens: 10 }, provider));
    assert.equal(res.status, 200, url);
    assert.equal(healCalls[0]!.body!.provider, provider, url);
    assert.equal(healCalls[0]!.body!.api, api, url);
    assert.equal(events[i]!.healStatus, 'unverified', url);
  }
});

test('the union adapter reports vercel-sdk for AI SDK traffic on both dialect families', async () => {
  for (const [url, provider] of [
    ['https://api.openai.com/v1/chat/completions', 'openai'],
    ['https://api.anthropic.com/v1/messages', 'anthropic'],
  ] as const) {
    healCalls = [];
    const stub = providerStub([err400('bad knob'), ok200]);
    await autofix({ fetch: stub.fn })(url, aiSdkInit({ model: 'm' }, provider));
    assert.equal(healCalls[0]!.headers['x-autofix-source'], 'vercel-sdk', url);
  }
});

test('unknown paths leave the universal wrapper inert', async () => {
  const inertPaths = [
    'https://api.openai.com/v1/embeddings',
    'https://api.anthropic.com/v1/messages/batches',
    'https://example.com/api/anything',
    // OpenAI's Assistants API (/threads/{id}/messages) ends in the Anthropic
    // dialect's tail, so it is the body that keeps it inert, not the path —
    // see the next test, which sends the real thing.
  ];
  for (const url of inertPaths) {
    const stub = providerStub([err400('nope')]);
    const res = await autofix({ fetch: stub.fn })(url, aiSdkInit({ model: 'm' }, 'openai'));
    assert.equal(res.status, 400, url);
    assert.equal(healCalls.length, 0, `${url} reached the heal API`);
  }
});

test('the Assistants message body stays inert on its own /messages path', async () => {
  // The real body openai-node sends for beta.threads.messages.create: no
  // `model`, and a top-level `content` no dialect of ours has.
  const stub = providerStub([err400('nope'), ok200]);
  const res = await autofix({ fetch: stub.fn })(
    'https://api.openai.com/v1/threads/thread_abc/messages',
    aiSdkInit({ role: 'user', content: 'MY PRIVATE PROMPT',
      attachments: [{ file_id: 'file-1' }] }, 'openai'),
  );
  assert.equal(res.status, 400, 'the caller keeps their own error');
  assert.equal(healCalls.length, 0, 'the prompt text reached the heal API');
  assert.equal(stub.calls.length, 1, 'nothing was replayed');
});

// Prototype pollution is a live transitive-dependency vuln class: one bad
// package setting `Object.prototype.model` must not reopen the gate for a body
// that never carried one, or this exact prompt text starts travelling.
test('a polluted Object.prototype.model cannot reopen the gate', async () => {
  (Object.prototype as unknown as Record<string, unknown>).model = 'gpt-4o';
  try {
    const stub = providerStub([err400('nope')]);
    const res = await autofix({ fetch: stub.fn })(
      'https://api.openai.com/v1/threads/thread_abc/messages',
      aiSdkInit({ role: 'user', content: 'MY PRIVATE PROMPT',
        attachments: [{ file_id: 'file-1' }] }, 'openai'),
    );
    assert.equal(res.status, 400, 'the caller keeps their own error');
    assert.equal(healCalls.length, 0, 'a prototype key opened the gate');
  } finally {
    delete (Object.prototype as unknown as Record<string, unknown>).model;
  }
});

test('a body with no model is inert on a real dialect path too', async () => {
  for (const url of [
    'https://api.openai.com/v1/chat/completions',
    'https://api.openai.com/v1/responses',
    'https://api.anthropic.com/v1/messages',
  ]) {
    healCalls = [];
    const stub = providerStub([err400('nope')]);
    const res = await autofix({ fetch: stub.fn })(url, aiSdkInit({ temperature: 1 }, 'openai'));
    assert.equal(res.status, 400, url);
    assert.equal(healCalls.length, 0, `${url} reached the heal API without a model`);
  }
});

// The Responses API lets the model live on a stored prompt template instead of
// in the body. Those calls are ordinary Responses traffic and fail the same way,
// so the dialect claims `prompt` as a second identifying key.
test('a stored-prompt Responses call with no model heals like any other', async () => {
  const stub = providerStub([err400('bad knob'), ok200]);
  const res = await autofix({ fetch: stub.fn })('https://api.openai.com/v1/responses',
    aiSdkInit({ prompt: { id: 'pmpt_abc', version: '2' }, temperature: 0.2 }, 'openai'));
  assert.equal(res.status, 200, 'healed and replayed');
  assert.equal(healCalls[0]!.body!.api, 'responses');
});

test('prompt does not identify the dialects that never accept it', async () => {
  for (const url of [
    'https://api.openai.com/v1/chat/completions',
    'https://api.anthropic.com/v1/messages',
  ]) {
    healCalls = [];
    const stub = providerStub([err400('nope')]);
    const res = await autofix({ fetch: stub.fn })(url,
      aiSdkInit({ prompt: { id: 'pmpt_abc' } }, 'openai'));
    assert.equal(res.status, 400, url);
    assert.equal(healCalls.length, 0, `${url} opened on a key it does not own`);
  }
});

// Without an attempt id there is no outcome report to hand the failed replay
// to, and nobody else ever reads it: under undici that body pins a pooled
// connection until GC, on every healed failure a server answers this way.
test('a failed replay is drained when the heal API sends no healAttemptId', async () => {
  let cancelled = false;
  globalThis.fetch = (async (_input: never, init?: RequestInit) => {
    healCalls.push({ method: init?.method ?? 'GET', body: undefined, headers: {} });
    return new Response(JSON.stringify({
      status: 'patched', issueId: 'i1', healedBody: { model: 'm2' }, // no healAttemptId
    }), { status: 200 });
  }) as typeof globalThis.fetch;

  let call = 0;
  const provider = (async () => {
    call += 1;
    if (call === 1) return err400('bad knob')();
    return new Response(new ReadableStream({
      start: (c) => { c.enqueue(new TextEncoder().encode('{"error":{"message":"still bad"}}')); },
      // Releasing an already-broken connection can reject; an unhandled
      // rejection would land during the wait below.
      cancel: () => { cancelled = true; throw new Error('already gone'); },
    }), { status: 400 });
  }) as typeof globalThis.fetch;

  const res = await autofix({ fetch: provider })('https://api.openai.com/v1/chat/completions',
    aiSdkInit({ model: 'm', max_tokens: 10 }, 'openai'));
  assert.equal(res.status, 400, 'the caller keeps their own error');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cancelled, true, 'the failed replay body was left pinning a connection');
  assert.deepEqual(healCalls.map((c) => c.method), ['POST'], 'no attempt id, so no PATCH');
});

test('official-SDK traffic through the root export classifies per SDK', async () => {
  const stub = providerStub([err400('bad'), ok200]);
  await autofix({ fetch: stub.fn })('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'user-agent': 'Anthropic/JS 0.115.0', 'x-api-key': 'sk-ant' },
    body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 10 }),
  });
  assert.equal(healCalls[0]!.headers['x-autofix-source'], 'anthropic-sdk');
});
