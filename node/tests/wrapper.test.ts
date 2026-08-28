import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION } from '../src/core/version.ts';
import { autofix, type HealEvent } from '../src/index.ts';

const OPENAI = 'https://api.openai.com/v1/chat/completions';
const RESPONSES = 'https://api.openai.com/v1/responses';
const HEAL_URL = 'http://heal.test';

const err400 = () => new Response(JSON.stringify({
  error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model.",
    type: 'invalid_request_error', param: 'temperature', code: 'unsupported_value' },
}), { status: 400 });

const ok200 = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

// Bodies the wrapper must not touch (uploads, no body at all, malformed JSON)
// still reach the provider — record them as {} instead of throwing.
const readBody = (body: BodyInit | null | undefined): Record<string, unknown> => {
  try { return JSON.parse(body as string) as Record<string, unknown>; } catch { return {}; }
};

// Scripted provider stub — plays `script` in order, sticks on the last entry.
// An entry may also throw, standing in for a transport that could not send.
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

// postHeal/reportOutcome use GLOBAL fetch — route heal-API calls through a stub.
const realFetch = globalThis.fetch;
let healCalls: { url: string; method: string; body: Record<string, unknown> | undefined;
  headers: Record<string, string> }[] = [];
// `init` is handed over too: the budget lives on init.signal, and the outcome
// PATCH is only distinguishable from the heal POST by its method.
let healResponder: (body: unknown, init?: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
  process.env.AUTOFIX_URL = HEAL_URL;
  healCalls = [];
  healResponder = () => new Response(JSON.stringify({
    status: 'unverified', issueId: 'i1', healAttemptId: 'a1',
    healedBody: { model: 'gpt-5-mini', temperature: 1 },
    explanation: { summary: 'Set "temperature" to 1.',
      operations: [{ type: 'set_param', detail: 'temperature → 1' }] },
  }), { status: 200 });
  globalThis.fetch = (async (input: never, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(HEAL_URL) || url.includes('autofix.manifest.build')) {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      healCalls.push({
        url, method: init?.method ?? 'GET', body,
        headers: Object.fromEntries(new Headers(init?.headers as HeadersInit | undefined)),
      });
      return healResponder(body, init);
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.AUTOFIX_URL;
  delete process.env.AUTOFIX_DEBUG;
});

const reqInit = (body: Record<string, unknown>): RequestInit => ({
  method: 'POST',
  headers: { 'content-length': '999', authorization: 'Bearer sk-secret' },
  body: JSON.stringify(body),
});

const chatBody = { model: 'gpt-5-mini', temperature: 0.2,
  messages: [{ role: 'user', content: 'SECRET' }] };

test('success and non-healable statuses pass through untouched', async () => {
  for (const status of [200, 401, 429, 500]) {
    const provider = providerStub([() => new Response('{}', { status })]);
    const fx = autofix({ fetch: provider.fn });
    const res = await fx(OPENAI, reqInit(chatBody));
    assert.equal(res.status, status);
    assert.equal(healCalls.length, 0);
  }
});

test('non-LLM paths leave the wrapper inert', async () => {
  const provider = providerStub([err400]);
  const fx = autofix({ fetch: provider.fn });
  const res = await fx('https://api.example.com/v1/embeddings', reqInit(chatBody));
  assert.equal(res.status, 400);
  assert.equal(healCalls.length, 0);
});

// A custom baseURL is the norm, not the exception: gateways, proxies, Azure,
// LiteLLM, localhost. Routing follows the SDK wherever it points.
for (const url of [
  'https://api.example.com/v1/chat/completions',        // self-hosted proxy
  'https://openrouter.ai/api/v1/chat/completions',      // extra path prefix
  'https://x.openai.azure.com/openai/deployments/gpt-4/chat/completions?api-version=2024-06-01',
  'http://localhost:4000/v1/chat/completions',          // LiteLLM
]) {
  test(`heals through a custom baseURL: ${new URL(url).host}`, async () => {
    const provider = providerStub([err400, ok200]);
    const fx = autofix({ fetch: provider.fn });
    const res = await fx(url, reqInit(chatBody));
    assert.equal(res.status, 200, 'healed and replayed');
    assert.equal(healCalls.length >= 1, true);
    assert.equal(provider.calls[1]!.body.temperature, 1);
  });
}

test('the reported url drops query strings (gateways put tokens there)', async () => {
  const provider = providerStub([err400, ok200]);
  const events: HealEvent[] = [];
  const fx = autofix({ fetch: provider.fn, onHeal: (e) => events.push(e) });
  await fx('https://gw.example.com/v1/chat/completions?api-key=SECRET_TOKEN',
    reqInit(chatBody));
  const payload = healCalls[0]!.body!;
  assert.equal(payload.url, 'https://gw.example.com/v1/chat/completions');
  assert.ok(!JSON.stringify(payload).includes('SECRET_TOKEN'), 'query token never travels');
  assert.ok(!events[0]!.url.includes('SECRET_TOKEN'));
});

test('heals: strips content, sends derived identity, merges, replays, reports outcome', async () => {
  const provider = providerStub([err400, ok200]);
  const events: HealEvent[] = [];
  const fx = autofix({ fetch: provider.fn, onHeal: (e) => events.push(e) });
  const res = await fx(OPENAI, reqInit(chatBody));
  assert.equal(res.status, 200);

  const payload = healCalls[0]!.body!;
  assert.ok(!JSON.stringify(payload).includes('SECRET'), 'no message content on the wire');
  assert.ok(!('messages' in (payload.request as object)));
  assert.match(payload.tenantId as string, /^[0-9a-f]{64}$/, 'derived sha256 workspace id');
  assert.equal(payload.provider, 'openai');
  assert.equal(payload.api, 'chat_completions');

  const replay = provider.calls[1]!;
  assert.equal(replay.body.temperature, 1, 'healed knob applied');
  assert.deepEqual(replay.body.messages, chatBody.messages, 'replay keeps original messages');
  assert.equal(replay.headers.authorization, 'Bearer sk-secret', 'provider key stays on its path');
  assert.equal('content-length' in replay.headers, false, 'stale content-length dropped');

  await new Promise((r) => setTimeout(r, 20)); // fire-and-forget outcome
  const patch = healCalls.find((c) => c.method === 'PATCH');
  assert.ok(patch && patch.url.includes('/api/heal-attempts/a1'));
  assert.equal(patch.body!.retryStatusCode, 200);

  // Both heal calls carry the SDK's User-Agent — which SDK reported.
  assert.equal(healCalls[0]!.headers['user-agent'], `autofix-node/${VERSION}`);
  assert.equal(healCalls[0]!.headers.authorization, undefined,
    'provider authorization never reaches the heal API');
  assert.equal(patch!.headers['user-agent'], `autofix-node/${VERSION}`);

  assert.equal(events.length, 1);
  assert.equal(events[0]!.healStatus, 'unverified');
  assert.equal(events[0]!.replayStatusCode, 200);
  assert.equal(events[0]!.summary, 'Set "temperature" to 1.');
});

test('healedBody smuggling content is overwritten by the original', async () => {
  healResponder = () => new Response(JSON.stringify({
    status: 'patched', issueId: 'i1',
    healedBody: { model: 'gpt-5-mini', messages: [{ role: 'user', content: 'INJECTED' }] },
  }), { status: 200 });
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn });
  await fx(OPENAI, reqInit(chatBody));
  assert.deepEqual(provider.calls[1]!.body.messages, chatBody.messages);
});

test('resolving → original error, no replay', async () => {
  healResponder = () => new Response(JSON.stringify({
    status: 'resolving', issueId: 'i1',
    explanation: { summary: 'Working on it.', operations: [] },
  }), { status: 200 });
  const provider = providerStub([err400]);
  const events: HealEvent[] = [];
  const fx = autofix({ fetch: provider.fn, onHeal: (e) => events.push(e) });
  const res = await fx(OPENAI, reqInit(chatBody));
  assert.equal(res.status, 400);
  assert.equal(provider.calls.length, 1, 'no replay happened');
  assert.equal(events[0]!.healStatus, 'resolving');
  assert.equal(events[0]!.summary, 'Working on it.');
});

test('patched with an empty healedBody is not served', async () => {
  healResponder = () => new Response(JSON.stringify({
    status: 'patched', issueId: 'i1', healedBody: {},
  }), { status: 200 });
  const provider = providerStub([err400]);
  const fx = autofix({ fetch: provider.fn });
  const res = await fx(OPENAI, reqInit(chatBody));
  assert.equal(res.status, 400);
  assert.equal(provider.calls.length, 1);
});

test('heal API down → fail open with the original error', async () => {
  healResponder = () => { throw new Error('down'); };
  const provider = providerStub([err400]);
  const events: HealEvent[] = [];
  const fx = autofix({ fetch: provider.fn, onHeal: (e) => events.push(e) });
  const res = await fx(OPENAI, reqInit(chatBody));
  assert.equal(res.status, 400);
  assert.equal(events[0]!.healStatus, 'heal_unreachable');
});

test('heal API 5xx → fail open with the original error', async () => {
  healResponder = () => new Response('oops', { status: 500 });
  const provider = providerStub([err400]);
  const fx = autofix({ fetch: provider.fn });
  const res = await fx(OPENAI, reqInit(chatBody));
  assert.equal(res.status, 400);
});

test('replay failure returns the ORIGINAL error and reports the failed outcome', async () => {
  const provider = providerStub([err400, () => new Response(
    JSON.stringify({ error: { message: 'still bad' } }), { status: 400 })]);
  const fx = autofix({ fetch: provider.fn });
  const res = await fx(OPENAI, reqInit(chatBody));
  assert.equal(res.status, 400);
  const original = await res.json() as { error: { message: string } };
  assert.match(original.error.message, /Unsupported value/);

  await new Promise((r) => setTimeout(r, 20));
  const patch = healCalls.find((c) => c.method === 'PATCH');
  assert.equal(patch!.body!.retryStatusCode, 400);
  assert.equal((patch!.body!.error as { message: string }).message, 'still bad');
});

test('no AUTOFIX_URL → the hosted heal endpoint is used', async () => {
  delete process.env.AUTOFIX_URL;
  healResponder = () => new Response(JSON.stringify({ status: 'no_patch', issueId: 'i1' }),
    { status: 200 });
  const provider = providerStub([err400]);
  const fx = autofix({ fetch: provider.fn });
  await fx(OPENAI, reqInit(chatBody));
  assert.equal(healCalls[0]!.url,
    'https://autofix.manifest.build/api/heal');
});

// The shape of the structured output is a setting and heals like one; the
// schema inside it is the caller's data model and never leaves the process.
test('responses dialect: heals text.format.type without ever seeing the schema', async () => {
  healResponder = () => new Response(JSON.stringify({
    status: 'patched', issueId: 'i1',
    healedBody: { model: 'gpt-5-mini', temperature: 1, text: { format: { type: 'json_object' } } },
  }), { status: 200 });
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn });
  const res = await fx(RESPONSES, reqInit({
    model: 'gpt-5-mini', temperature: 0.2,
    input: 'SECRET_INPUT', instructions: 'SECRET_INSTRUCTIONS',
    text: { format: { type: 'json_schema', schema: { name: 'SECRET_SCHEMA' } } },
  }));
  assert.equal(res.status, 200);

  const payload = healCalls[0]!.body!;
  const req = payload.request as Record<string, unknown>;
  assert.ok(!JSON.stringify(payload).includes('SECRET'), 'nothing SECRET on the wire');
  assert.ok(!('input' in req), 'input stripped from the heal payload');
  assert.ok(!('instructions' in req), 'instructions stripped from the heal payload');
  assert.deepEqual(req.text, { format: { type: 'json_schema' } }, 'the shape, not the schema');
  assert.equal(payload.api, 'responses');

  const replay = provider.calls[1]!;
  assert.equal(replay.body.input, 'SECRET_INPUT', 'replay keeps original input');
  assert.equal(replay.body.instructions, 'SECRET_INSTRUCTIONS', 'replay keeps instructions');
  assert.deepEqual(replay.body.text,
    { format: { type: 'json_object', schema: { name: 'SECRET_SCHEMA' } } },
    'the healed shape, over a schema the heal API never saw');
});

// ─── budgets ────────────────────────────────────────────────────────────────
// Nothing autofix calls may sit on the caller's clock without one.

test('a hung heal API gives up on its budget instead of stalling the caller', async () => {
  // A real hung request holds the event loop open; AbortSignal.timeout's timer
  // is unref'd, so the stub has to do the holding itself or nothing ever fires.
  healResponder = (_body, init) => new Promise<Response>((_resolve, reject) => {
    const holdOpen = setTimeout(() => reject(new Error('stub never aborted')), 2000);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(holdOpen);
      reject(new Error('aborted'));
    });
  });
  const provider = providerStub([err400]);
  const events: HealEvent[] = [];
  const started = Date.now();
  const fx = autofix({ fetch: provider.fn, healTimeoutMs: 20, onHeal: (e) => events.push(e) });
  const res = await fx(OPENAI, reqInit(chatBody));

  assert.equal(res.status, 400, 'the caller gets its own error, not a hang');
  assert.ok(Date.now() - started < 1500, 'it gave up on the budget, not on the stub');
  assert.equal(provider.calls.length, 1, 'no replay happened');
  assert.equal(events[0]!.healStatus, 'heal_unreachable');
});

test('the heal call is budgeted even when the caller names no budget', async () => {
  let signalled = false;
  healResponder = (_body, init) => {
    signalled = Boolean(init?.signal);
    return new Response(JSON.stringify({ status: 'no_patch', issueId: 'i1' }), { status: 200 });
  };
  const provider = providerStub([err400]);
  await autofix({ fetch: provider.fn })(OPENAI, reqInit(chatBody));
  assert.equal(signalled, true, 'the default budget is still a budget');
});

// ─── the heal answer is untrusted input ─────────────────────────────────────

test('a heal answer that is not an object fails open', async () => {
  // A 200 can still carry null, a string or an array: a proxy, a cache, a bad
  // deploy. None of them may become a TypeError in the caller's stack.
  for (const body of ['null', '"patched"', '[{"status":"patched"}]']) {
    healResponder = () => new Response(body, { status: 200 });
    const provider = providerStub([err400]);
    const events: HealEvent[] = [];
    const fx = autofix({ fetch: provider.fn, onHeal: (e) => events.push(e) });
    const res = await fx(OPENAI, reqInit(chatBody));
    assert.equal(res.status, 400, `${body} was treated as a heal`);
    assert.equal(provider.calls.length, 1, 'no replay happened');
    assert.equal(events[0]!.healStatus, 'heal_unreachable');
  }
});

test('a heal answer that is not JSON at all fails open', async () => {
  healResponder = () => new Response('<html>200 from a captive portal</html>', { status: 200 });
  const provider = providerStub([err400]);
  const events: HealEvent[] = [];
  const fx = autofix({ fetch: provider.fn, onHeal: (e) => events.push(e) });
  assert.equal((await fx(OPENAI, reqInit(chatBody))).status, 400);
  assert.equal(events[0]!.healStatus, 'heal_unreachable');
});

test('a heal with no status at all is not served', async () => {
  healResponder = () => new Response(JSON.stringify({
    issueId: 'i1', healedBody: { model: 'gpt-5-mini', temperature: 1 },
  }), { status: 200 });
  const provider = providerStub([err400]);
  const events: HealEvent[] = [];
  const fx = autofix({ fetch: provider.fn, onHeal: (e) => events.push(e) });
  const res = await fx(OPENAI, reqInit(chatBody));
  assert.equal(res.status, 400);
  assert.equal(provider.calls.length, 1, 'no replay happened');
  assert.equal(events[0]!.healStatus, 'no_patch', 'nothing said, nothing served');
});

test('patched with no healedBody at all is not served', async () => {
  healResponder = () => new Response(JSON.stringify({ status: 'patched', issueId: 'i1' }),
    { status: 200 });
  const provider = providerStub([err400]);
  const events: HealEvent[] = [];
  const fx = autofix({ fetch: provider.fn, onHeal: (e) => events.push(e) });
  const res = await fx(OPENAI, reqInit(chatBody));
  assert.equal(res.status, 400);
  assert.equal(provider.calls.length, 1, 'no replay happened');
  assert.equal(events[0]!.healStatus, 'patched');
  assert.equal(events[0]!.summary, undefined, 'no explanation, nothing to summarise');
});

// ─── the caller owns the transport fields ───────────────────────────────────

test('the caller keeps streaming when the heal drops it', async () => {
  healResponder = () => new Response(JSON.stringify({
    status: 'patched', issueId: 'i1',
    healedBody: { model: 'gpt-5-mini', temperature: 1 }, // stream dropped → SSE reader gets JSON
  }), { status: 200 });
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn });
  await fx(OPENAI, reqInit({ ...chatBody, stream: true, stream_options: { include_usage: true } }));
  const replay = provider.calls[1]!;
  assert.equal(replay.body.stream, true, 'the SDK is already committed to parsing SSE');
  assert.deepEqual(replay.body.stream_options, { include_usage: true });
});

test('a heal cannot start a stream the caller never asked for', async () => {
  healResponder = () => new Response(JSON.stringify({
    status: 'patched', issueId: 'i1',
    healedBody: { model: 'gpt-5-mini', stream: true, stream_options: { include_usage: true } },
  }), { status: 200 });
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn });
  await fx(OPENAI, reqInit(chatBody));
  const replay = provider.calls[1]!;
  assert.equal('stream' in replay.body, false, 'the caller asked for one object');
  assert.equal('stream_options' in replay.body, false);
});

// ─── the replay, and what it costs the caller ───────────────────────────────

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
  const res = await fx(OPENAI, reqInit(chatBody));
  assert.equal(res.status, 200);

  await new Promise((r) => setTimeout(r, 20)); // fire-and-forget outcome
  assert.equal(clones, 0, 'the body the caller is reading is not copied');
  const patch = healCalls.find((c) => c.method === 'PATCH');
  assert.equal(patch!.body!.retryStatusCode, 200, 'the outcome is still reported');
  assert.deepEqual(await res.json(), { ok: true }, 'and the body is still whole');
});

test('a replay the transport cannot send returns the original error', async () => {
  const provider = providerStub([err400, () => { throw new Error('ECONNRESET'); }]);
  const events: HealEvent[] = [];
  const fx = autofix({ fetch: provider.fn, onHeal: (e) => events.push(e) });
  const res = await fx(OPENAI, reqInit(chatBody));
  assert.equal(res.status, 400);
  const original = await res.json() as { error: { message: string } };
  assert.match(original.error.message, /Unsupported value/);
  assert.equal(provider.calls.length, 2, 'the replay was attempted exactly once');

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(healCalls.filter((c) => c.method === 'PATCH').length, 0, 'no outcome to report');
  assert.equal(events[0]!.healStatus, 'replay_failed');
  assert.equal(events[0]!.replayStatusCode, undefined, 'there was no reply to report');
});

test('a failed replay with no readable error still reports the outcome', async () => {
  for (const [i, body] of ['<html>bad gateway</html>', 'null'].entries()) {
    const provider = providerStub([err400, () => new Response(body, { status: 400 })]);
    const fx = autofix({ fetch: provider.fn });
    const res = await fx(OPENAI, reqInit(chatBody));
    assert.equal(res.status, 400);

    await new Promise((r) => setTimeout(r, 20)); // fire-and-forget outcome
    const patches = healCalls.filter((c) => c.method === 'PATCH');
    assert.equal(patches.length, i + 1, `no outcome reported for ${body}`);
    assert.equal(patches[i]!.body!.retryStatusCode, 400);
    assert.equal('error' in patches[i]!.body!, false, 'a weak outcome beats no outcome');
  }
});

test('a heal with no healAttemptId is served without an outcome report', async () => {
  healResponder = () => new Response(JSON.stringify({
    status: 'patched', issueId: 'i1', healedBody: { model: 'gpt-5-mini', temperature: 1 },
  }), { status: 200 });
  const provider = providerStub([err400, ok200]);
  const events: HealEvent[] = [];
  const fx = autofix({ fetch: provider.fn, onHeal: (e) => events.push(e) });
  const res = await fx(OPENAI, reqInit(chatBody));
  assert.equal(res.status, 200, 'the caller still gets the healed response');

  await new Promise((r) => setTimeout(r, 20)); // fire-and-forget outcome, had there been one
  assert.equal(healCalls.filter((c) => c.method === 'PATCH').length, 0,
    'no attempt id, nothing to report against');
  assert.equal(events[0]!.replayStatusCode, 200);
  assert.equal(events[0]!.operations, undefined);
});

test('an outcome report that fails never reaches the caller', async () => {
  healResponder = (_body, init) => {
    if (init?.method === 'PATCH') throw new Error('outcome endpoint down');
    return new Response(JSON.stringify({
      status: 'unverified', issueId: 'i1', healAttemptId: 'a1',
      healedBody: { model: 'gpt-5-mini', temperature: 1 },
    }), { status: 200 });
  };
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn });
  const res = await fx(OPENAI, reqInit(chatBody));
  assert.equal(res.status, 200);

  await new Promise((r) => setTimeout(r, 20)); // an unhandled rejection would land here
  assert.equal(healCalls.filter((c) => c.method === 'PATCH').length, 1, 'it was attempted');
  assert.deepEqual(await res.json(), { ok: true }, 'the healed response is intact');
});

test('the original body is released once the replay wins, even if releasing fails', async () => {
  // Bodies come from whatever transport was handed to autofix(): one may be
  // absent, and one that already failed can reject when let go.
  let released = 0;
  const bodies = [
    null,
    { cancel: () => { released++; return Promise.reject(new Error('already gone')); } },
  ];
  for (const body of bodies) {
    const original = () => {
      const res = err400();
      Object.defineProperty(res, 'body', { get: () => body });
      return res;
    };
    const provider = providerStub([original, ok200]);
    const fx = autofix({ fetch: provider.fn });
    const res = await fx(OPENAI, reqInit(chatBody));
    assert.equal(res.status, 200, 'the caller gets the healed response either way');
    await new Promise((r) => setTimeout(r, 20)); // an unhandled rejection would land here
    assert.deepEqual(await res.json(), { ok: true });
  }
  assert.equal(released, 1, 'the body the caller will never read is let go');
});

// ─── the hook is for watching, never for deciding ───────────────────────────

test('a hook that throws is not allowed to become an outage', async () => {
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn, onHeal: () => { throw new Error('buggy hook'); } });
  const res = await fx(OPENAI, reqInit(chatBody));
  assert.equal(res.status, 200, 'the caller still gets its healed response');
  assert.equal(provider.calls[1]!.body.temperature, 1);
  assert.deepEqual(await res.json(), { ok: true });
});

test('a hook that throws on the fail-open paths is swallowed too', async () => {
  // Every emit() goes through the same wrapper, but a hook only ever sees the
  // path it was on: prove the two that hand back the caller's own error.
  const hostile = () => { throw new Error('buggy hook'); };
  healResponder = () => { throw new Error('down'); };
  const unreachable = providerStub([err400]);
  assert.equal((await autofix({ fetch: unreachable.fn, onHeal: hostile })(
    OPENAI, reqInit(chatBody))).status, 400);

  healResponder = () => new Response(JSON.stringify({
    status: 'unverified', issueId: 'i1',
    healedBody: { model: 'gpt-5-mini', temperature: 1 },
  }), { status: 200 });
  const failed = providerStub([err400, () => { throw new Error('ECONNRESET'); }]);
  assert.equal((await autofix({ fetch: failed.fn, onHeal: hostile })(
    OPENAI, reqInit(chatBody))).status, 400);
});

// ─── the gate: what the wrapper refuses to touch ────────────────────────────

test('a URL the wrapper cannot parse passes through instead of throwing', async () => {
  // Relative input is what a hand-rolled client hands fetch(); URL parsing
  // throws on it, and a throw here would surface instead of the response.
  for (const url of ['/v1/chat/completions', '', 'not a url']) {
    const provider = providerStub([err400]);
    const fx = autofix({ fetch: provider.fn });
    const res = await fx(url, reqInit(chatBody));
    assert.equal(res.status, 400, `${url} threw instead of passing through`);
    assert.equal(healCalls.length, 0);
  }
});

test('a Request object is routed by the URL it carries', async () => {
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn });
  const res = await fx(new Request(OPENAI), reqInit(chatBody));
  assert.equal(res.status, 200);
  assert.equal(healCalls[0]!.body!.url, OPENAI, 'the Request URL, not "[object Request]"');
  assert.equal(healCalls[0]!.body!.api, 'chat_completions');
});

test('a replay carries the headers the caller put on the Request object', async () => {
  // fetch(new Request(url, {headers}), {method, body}) is a legal shape, and the
  // credentials live on the Request. Rebuilding the replay from init alone sent
  // it out unauthenticated: a 401 in place of the heal the caller earned.
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn });
  const request = new Request(OPENAI, {
    headers: { authorization: 'Bearer sk-secret', 'content-length': '999' },
  });
  const res = await fx(request, { method: 'POST', body: JSON.stringify(chatBody) });
  assert.equal(res.status, 200, 'healed and replayed');

  const replay = provider.calls[1]!;
  assert.equal(replay.headers.authorization, 'Bearer sk-secret', 'the Request carried the key');
  assert.equal('content-length' in replay.headers, false, 'stale content-length still dropped');
  assert.equal(request.headers.get('content-length'), '999', 'the caller\'s Request is untouched');
});

test('only JSON POSTs are healable — uploads and reads pass through', async () => {
  const notJsonPosts: Array<[string, RequestInit | undefined]> = [
    ['no init at all', undefined],
    ['no method, so a GET', { body: JSON.stringify(chatBody) }],
    ['an explicit GET', { method: 'GET', body: JSON.stringify(chatBody) }],
    ['a DELETE', { method: 'DELETE', body: JSON.stringify(chatBody) }],
    ['a POST with no body', { method: 'POST' }],
    ['a multipart upload', { method: 'POST', body: new FormData() }],
    // JSON, but not as a string: still a body the wrapper does not reshape.
    ['a Buffer body', { method: 'POST', body: Buffer.from(JSON.stringify(chatBody)) }],
  ];
  for (const [what, init] of notJsonPosts) {
    const provider = providerStub([err400]);
    const fx = autofix({ fetch: provider.fn });
    const res = await fx(OPENAI, init);
    assert.equal(res.status, 400, what);
    assert.equal(healCalls.length, 0, `${what} reached the heal API`);
  }
});

test('a lowercase method is still a POST', async () => {
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn });
  const res = await fx(OPENAI, { ...reqInit(chatBody), method: 'post' });
  assert.equal(res.status, 200, 'the SDK decides the casing, not us');
});

test('a request body that is JSON but not an object is left alone', async () => {
  for (const body of ['[1,2,3]', '"gpt-5-mini"', 'null', '42', 'true']) {
    const provider = providerStub([err400]);
    const fx = autofix({ fetch: provider.fn });
    const res = await fx(OPENAI, { method: 'POST', body });
    assert.equal(res.status, 400);
    assert.equal(healCalls.length, 0, `${body} reached the heal API`);
  }
});

test('a request body that is not JSON is left alone', async () => {
  const provider = providerStub([err400]);
  const fx = autofix({ fetch: provider.fn });
  const res = await fx(OPENAI, { method: 'POST', body: 'model=gpt-5-mini' });
  assert.equal(res.status, 400);
  assert.equal(healCalls.length, 0);
});

test('an error body the gate cannot read is left alone, unread', async () => {
  for (const body of ['<html>502 Bad Gateway</html>', 'null', '{}', '{"error":{}}',
    '{"error":"a string"}', '{"error":{"message":""}}']) {
    const provider = providerStub([() => new Response(body, { status: 400 })]);
    const fx = autofix({ fetch: provider.fn });
    const res = await fx(OPENAI, reqInit(chatBody));
    assert.equal(res.status, 400);
    assert.equal(await res.text(), body, 'the caller still gets to read its own body');
    assert.equal(healCalls.length, 0, `${body} reached the heal API`);
  }
});

test('404 and 422 are healable, and the SDK\'s own retry territory is not', async () => {
  for (const status of [400, 404, 422]) {
    const provider = providerStub([() => new Response(JSON.stringify({
      error: { message: 'nope' } }), { status }), ok200]);
    const fx = autofix({ fetch: provider.fn });
    assert.equal((await fx(OPENAI, reqInit(chatBody))).status, 200, `${status} was not healed`);
  }
  for (const status of [403, 409, 502]) {
    const provider = providerStub([() => new Response(JSON.stringify({
      error: { message: 'nope' } }), { status })]);
    const fx = autofix({ fetch: provider.fn });
    assert.equal((await fx(OPENAI, reqInit(chatBody))).status, status);
  }
});

test('a degenerate schema carrier is never an outage, whatever it costs the heal', async () => {
  // `text: null` is legal JSON that anonymize walks into. Whether it can be
  // healed is one question; whether the caller keeps its own 400 and no
  // exception escapes is the guarantee, and that holds either way.
  healResponder = () => new Response(JSON.stringify({ status: 'no_patch', issueId: 'i1' }),
    { status: 200 });
  for (const text of [null, undefined, 'a string', 42, []]) {
    const provider = providerStub([err400]);
    const fx = autofix({ fetch: provider.fn });
    const res = await fx(RESPONSES, reqInit({ model: 'gpt-5-mini', input: 'SECRET', text }));
    assert.equal(res.status, 400, `text: ${JSON.stringify(text)} reached the caller as a throw`);
    assert.equal(provider.calls.length, 1, 'no replay happened');
  }
});

// ─── plumbing ───────────────────────────────────────────────────────────────

test('with no fetch option the wrapper heals through the global fetch', async () => {
  const provider = providerStub([err400, ok200]);
  const healStub = globalThis.fetch;    // installed by beforeEach — heal API only
  globalThis.fetch = (async (input: never, init?: RequestInit) => (
    String(input).startsWith(HEAL_URL) ? healStub(input, init) : provider.fn(input, init)
  )) as typeof globalThis.fetch;

  const res = await autofix()(OPENAI, reqInit(chatBody));
  assert.equal(res.status, 200);
  assert.equal(provider.calls.length, 2, 'the replay went through the global fetch too');
});

test('a workspace identity that cannot be derived is not an outage', async () => {
  const provider = providerStub([err400, ok200]);
  const fx = (() => {                   // identity is derived when the wrapper is built
    const realCwd = process.cwd;
    process.cwd = () => { throw new Error('uv_cwd ENOENT'); }; // e.g. the workdir was removed
    try { return autofix({ fetch: provider.fn }); } finally { process.cwd = realCwd; }
  })();
  const res = await fx(OPENAI, reqInit(chatBody));
  assert.equal(res.status, 200, 'healing still works without an identity');
  assert.equal('tenantId' in healCalls[0]!.body!, false, 'the payload simply omits it');
});

test('AUTOFIX_DEBUG logs the payload it sends, anonymized like the wire', async () => {
  process.env.AUTOFIX_DEBUG = '1';
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.join(' ')); };
  try {
    const provider = providerStub([err400, ok200]);
    const fx = autofix({ fetch: provider.fn });
    assert.equal((await fx(OPENAI, reqInit(chatBody))).status, 200);
  } finally {
    console.error = realError;
  }
  const debug = logged.join('\n');
  assert.match(debug, /\[autofix:debug\] heal payload/);
  assert.ok(!debug.includes('SECRET'), 'the debug log is anonymized too');
});

test('a healedBody that is an array is never replayed', async () => {
  // An array has keys, so it clears the emptiness guard. Replaying it verbatim
  // would let the heal API choose the whole request body: merging onto an array
  // sets properties JSON.stringify drops, so the caller's messages disappear.
  for (const healedBody of [[{ temperature: 1 }], 'temperature=1', 42]) {
    healResponder = () => new Response(JSON.stringify({
      status: 'patched', issueId: 'i1', healedBody,
    }), { status: 200 });
    const provider = providerStub([err400]);
    const fx = autofix({ fetch: provider.fn });
    const res = await fx(OPENAI, reqInit(chatBody));
    assert.equal(res.status, 400, `healedBody ${JSON.stringify(healedBody)} was served`);
    assert.equal(provider.calls.length, 1, 'no replay happened');
  }
});

test('a schema carrier that is not an object neither heals nor throws', async () => {
  // `{"text": null}` is legal JSON. Walking into it used to throw where the
  // caller expects the wrapper to do nothing at all.
  const provider = providerStub([err400, ok200]);
  const fx = autofix({ fetch: provider.fn });
  const res = await fx(RESPONSES, reqInit({ model: 'm', input: 'hi', text: null }));
  assert.ok(res.status === 200 || res.status === 400, 'a response, not a throw');
});
