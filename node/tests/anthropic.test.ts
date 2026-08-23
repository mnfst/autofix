import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { autofix, type HealEvent } from '../src/index.ts';

const ANTHROPIC = 'https://api.anthropic.com/v1/messages';
const HEAL_URL = 'http://heal.test';

// Anthropic's envelope: {"type":"error","error":{"type","message"}} — note it
// carries NO `param` and NO `code`, unlike OpenAI.
const err400 = () => new Response(JSON.stringify({
  type: 'error',
  error: { type: 'invalid_request_error',
    message: 'frequency_penalty: Extra inputs are not permitted' },
}), { status: 400 });

const ok200 = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

// Bodies the wrapper must not touch still reach the provider — record them as
// {} instead of throwing.
const readBody = (body: BodyInit | null | undefined): Record<string, unknown> => {
  try { return JSON.parse(body as string) as Record<string, unknown>; } catch { return {}; }
};

function providerStub(script: Array<() => Response>) {
  const calls: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fn = (async (_input: unknown, init?: RequestInit) => {
    calls.push({
      body: readBody(init?.body),
      headers: Object.fromEntries(new Headers(init?.headers as HeadersInit | undefined)),
    });
    return script[Math.min(calls.length - 1, script.length - 1)]!();
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

const realFetch = globalThis.fetch;
let healCalls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];
let healResponder: (body: unknown, init?: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
  process.env.AUTOFIX_URL = HEAL_URL;
  healCalls = [];
  // frequency_penalty is a scalar, so it travelled, so the server can speak for
  // it: the healed body is the corrected parameter set, and the correction here
  // is that frequency_penalty is not in it. `explanation.operations` is prose
  // for a human and is never acted on.
  healResponder = () => new Response(JSON.stringify({
    status: 'unverified', issueId: 'i1', healAttemptId: 'a1',
    healedBody: { model: 'claude-opus-4-6', max_tokens: 100 },
    explanation: { summary: 'Removed the unsupported parameter "frequency_penalty".',
      operations: [{ type: 'drop_param', detail: 'frequency_penalty' }] },
  }), { status: 200 });
  globalThis.fetch = (async (input: never, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(HEAL_URL) || url.includes('autofix.manifest.build')) {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      healCalls.push({ url, method: init?.method ?? 'GET', body });
      return healResponder(body, init);
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.AUTOFIX_URL;
});

const reqInit = (body: Record<string, unknown>): RequestInit => ({
  method: 'POST',
  headers: { 'content-length': '999', 'x-api-key': 'sk-ant-secret', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify(body),
});

const messagesBody = {
  model: 'claude-opus-4-6',
  max_tokens: 100,
  frequency_penalty: 0.5,                        // an OpenAI param, not an Anthropic one → 400
  system: 'SECRET_SYSTEM_PROMPT',                // top-level system prompt
  messages: [{ role: 'user', content: 'SECRET' }],
  tools: [{ name: 't', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
};

test('heals a messages call: strips content + system, replays, keeps the key', async () => {
  const provider = providerStub([err400, ok200]);
  const events: HealEvent[] = [];
  const fx = autofix({ fetch: provider.fn, onHeal: (e) => events.push(e) });
  const res = await fx(ANTHROPIC, reqInit(messagesBody));
  assert.equal(res.status, 200);

  const payload = healCalls[0]!.body!;
  const wire = JSON.stringify(payload);
  assert.ok(!wire.includes('SECRET'), 'no message content or system prompt on the wire');
  assert.ok(!wire.includes('input_schema'), 'tool schemas never leave');
  const sent = payload.request as Record<string, unknown>;
  assert.equal('system' in sent, false, 'system prompt stripped');
  assert.equal('messages' in sent, false);
  assert.equal('tools' in sent, false);
  assert.equal(sent.max_tokens, 100, 'settings do travel — that is the whole point');
  assert.equal(sent.frequency_penalty, 0.5,
    'the param that caused the 400 travels too, though no list ever named it');
  assert.equal(payload.provider, 'anthropic');
  assert.equal(payload.api, 'messages');

  const replay = provider.calls[1]!;
  assert.equal('frequency_penalty' in replay.body, false,
    'the healed body simply left it out, and omission is how a param is dropped');
  assert.equal(replay.body.system, 'SECRET_SYSTEM_PROMPT', 'system restored on replay');
  assert.deepEqual(replay.body.messages, messagesBody.messages, 'messages restored on replay');
  assert.deepEqual(replay.body.tools, messagesBody.tools, 'tools restored on replay');
  assert.equal(replay.headers['x-api-key'], 'sk-ant-secret', 'provider key stays on its path');
  assert.equal('content-length' in replay.headers, false, 'stale content-length dropped');

  assert.equal(events[0]!.healStatus, 'unverified');
  assert.equal(events[0]!.replayStatusCode, 200);
  assert.deepEqual(events[0]!.operations,
    [{ type: 'drop_param', detail: 'frequency_penalty' }],
    'the server\'s prose reaches the hook — it is the only account of what changed');
});

// There is one adapter now, so "the adapters do not overlap" is not a property
// this file can state. What replaced it: each path is attributed to the right
// provider/api through the single autofix() — tests/index.test.ts, 'one fetch
// instance routes all three dialects to the right provider' — and paths outside
// the three dialect tails stay inert — same file, 'unknown paths leave the
// universal wrapper inert'. The Anthropic-specific half of that stays here.

test('non-messages Anthropic paths stay inert', async () => {
  const provider = providerStub([err400]);
  const fx = autofix({ fetch: provider.fn });
  const res = await fx('https://api.anthropic.com/v1/complete', reqInit(messagesBody));
  assert.equal(res.status, 400);
  assert.equal(healCalls.length, 0);
});

test('heals through a custom baseURL (gateway/proxy/localhost)', async () => {
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn });
  const res = await fx('https://gw.example.com/v1/messages', reqInit(messagesBody));
  assert.equal(res.status, 200, 'healed and replayed');
  assert.equal(healCalls[0]!.body!.provider, 'anthropic');
  assert.equal('frequency_penalty' in provider.calls[1]!.body, false);
});

test('heal API down → fail open with the original error', async () => {
  healResponder = () => { throw new Error('down'); };
  const provider = providerStub([err400]);
  const events: HealEvent[] = [];
  const fx = autofix({ fetch: provider.fn, onHeal: (e) => events.push(e) });
  const res = await fx(ANTHROPIC, reqInit(messagesBody));
  assert.equal(res.status, 400);
  assert.equal(provider.calls.length, 1, 'no replay happened');
  assert.equal(events[0]!.healStatus, 'heal_unreachable');
});

// ─── the shared engine, seen from the /v1/messages route ────────────────────
// These guarantees live in core/engine.ts, not in either route table. They are
// asserted again here because "it works on OpenAI" is not evidence that the
// adapter a caller actually installed gets them.

test('a hung heal API gives up on its budget on the messages route too', async () => {
  // AbortSignal.timeout's timer is unref'd, so the stub holds the loop open.
  healResponder = (_body, init) => new Promise<Response>((_resolve, reject) => {
    const holdOpen = setTimeout(() => reject(new Error('stub never aborted')), 2000);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(holdOpen);
      reject(new Error('aborted'));
    });
  });
  const provider = providerStub([err400]);
  const events: HealEvent[] = [];
  const fx = autofix({ fetch: provider.fn, healTimeoutMs: 20, onHeal: (e) => events.push(e) });
  const res = await fx(ANTHROPIC, reqInit(messagesBody));
  assert.equal(res.status, 400, 'the caller gets its own error, not a hang');
  assert.equal(events[0]!.healStatus, 'heal_unreachable');
  assert.equal(provider.calls.length, 1, 'no replay happened');
});

test('a heal answer that is not an object fails open on the messages route', async () => {
  for (const body of ['null', '"patched"', '[{"status":"patched"}]']) {
    healResponder = () => new Response(body, { status: 200 });
    const provider = providerStub([err400]);
    const events: HealEvent[] = [];
    const fx = autofix({ fetch: provider.fn, onHeal: (e) => events.push(e) });
    const res = await fx(ANTHROPIC, reqInit(messagesBody));
    assert.equal(res.status, 400, `${body} was treated as a heal`);
    assert.equal(provider.calls.length, 1, 'no replay happened');
    assert.equal(events[0]!.healStatus, 'heal_unreachable');
  }
});

test('a hook that throws is not allowed to become an outage', async () => {
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn, onHeal: () => { throw new Error('buggy hook'); } });
  const res = await fx(ANTHROPIC, reqInit(messagesBody));
  assert.equal(res.status, 200, 'the caller still gets its healed response');
  assert.equal('frequency_penalty' in provider.calls[1]!.body, false);
});

test('a replay the transport cannot send returns the original error', async () => {
  const provider = providerStub([err400, () => { throw new Error('ECONNRESET'); }]);
  const events: HealEvent[] = [];
  const fx = autofix({ fetch: provider.fn, onHeal: (e) => events.push(e) });
  const res = await fx(ANTHROPIC, reqInit(messagesBody));
  assert.equal(res.status, 400);
  const original = await res.json() as { error: { message: string } };
  assert.match(original.error.message, /Extra inputs are not permitted/);
  assert.equal(provider.calls.length, 2, 'the replay was attempted exactly once');

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(healCalls.filter((c) => c.method === 'PATCH').length, 0, 'no outcome to report');
  assert.equal(events[0]!.healStatus, 'replay_failed');
});

test('the caller keeps streaming when the heal drops it', async () => {
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn });
  await fx(ANTHROPIC, reqInit({ ...messagesBody, stream: true }));
  assert.equal(provider.calls[1]!.body.stream, true, 'the SDK is committed to parsing SSE');
});

test('a heal cannot start a stream the caller never asked for', async () => {
  healResponder = () => new Response(JSON.stringify({
    status: 'patched', issueId: 'i1',
    healedBody: { model: 'claude-opus-4-6', max_tokens: 100, stream: true },
  }), { status: 200 });
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn });
  await fx(ANTHROPIC, reqInit(messagesBody));
  assert.equal('stream' in provider.calls[1]!.body, false, 'the caller asked for one object');
});

// Omission is a deletion only for what the caller disclosed. A heal that says
// nothing about the prompt is a heal that never saw it — and a prompt-less
// request is the one edit that could be worse than not healing at all: the
// provider may still answer it with a 200, billed to a caller who asked nothing.
test('a heal cannot drop the prompt or the tools out of the replay', async () => {
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn });
  await fx(ANTHROPIC, reqInit(messagesBody));

  const replay = provider.calls[1]!;
  assert.deepEqual(replay.body.messages, messagesBody.messages);
  assert.equal(replay.body.system, 'SECRET_SYSTEM_PROMPT');
  assert.deepEqual(replay.body.tools, messagesBody.tools);
  assert.equal(replay.body.model, 'claude-opus-4-6');
  assert.equal('frequency_penalty' in replay.body, false, 'the legitimate drop still happened');
});

test('a successful replay body is never teed for the outcome report', async () => {
  let clones = 0;
  const counted = () => {
    const res = ok200();
    const real = res.clone.bind(res);
    res.clone = () => { clones++; return real(); };
    return res;
  };
  const provider = providerStub([err400, counted]);
  const fx = autofix({ fetch: provider.fn });
  const res = await fx(ANTHROPIC, reqInit(messagesBody));
  assert.equal(res.status, 200);

  await new Promise((r) => setTimeout(r, 20)); // fire-and-forget outcome
  assert.equal(clones, 0, 'the body the caller is reading is not copied');
  const patch = healCalls.find((c) => c.method === 'PATCH');
  assert.equal(patch!.body!.retryStatusCode, 200, 'the outcome is still reported');
});

test('a failed replay hands back the original error and reports its own', async () => {
  const provider = providerStub([err400, () => new Response(
    JSON.stringify({ type: 'error', error: { message: 'still bad' } }), { status: 400 })]);
  const fx = autofix({ fetch: provider.fn });
  const res = await fx(ANTHROPIC, reqInit(messagesBody));
  assert.equal(res.status, 400);
  const original = await res.json() as { error: { message: string } };
  assert.match(original.error.message, /Extra inputs are not permitted/, "the caller's own error");

  await new Promise((r) => setTimeout(r, 20));
  const patch = healCalls.find((c) => c.method === 'PATCH');
  assert.equal(patch!.body!.retryStatusCode, 400);
  assert.equal((patch!.body!.error as { message: string }).message, 'still bad');
});

test('non-POSTs and non-object bodies stay inert on the messages route', async () => {
  const inert: Array<[string, RequestInit]> = [
    ['a GET', { method: 'GET', body: JSON.stringify(messagesBody) }],
    ['a POST of an array', { method: 'POST', body: '[1,2,3]' }],
    ['a POST of a bare string', { method: 'POST', body: '"claude-opus-4-6"' }],
    ['a POST of something that is not JSON', { method: 'POST', body: 'model=claude' }],
  ];
  for (const [what, init] of inert) {
    const provider = providerStub([err400]);
    const fx = autofix({ fetch: provider.fn });
    assert.equal((await fx(ANTHROPIC, init)).status, 400, what);
    assert.equal(healCalls.length, 0, `${what} reached the heal API`);
  }
});
