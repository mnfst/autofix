import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';
import { autofix } from '../src/index.ts';

const HEAL_URL = 'http://heal.test';

interface ProviderExchangePayload {
  format: string;
  url: string;
  request: { body: Record<string, unknown>; redactedFields?: string[] };
}

const googleError = () => new Response(JSON.stringify({
  error: { code: 404, message: 'models/gemini-1.0-pro is not found', status: 'NOT_FOUND' },
}), { status: 404 });

const googleSuccess = () => new Response(JSON.stringify({
  candidates: [{ content: { role: 'model', parts: [{ text: 'healed' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
}), { status: 200 });

function providerStub(script: Array<() => Response>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(init?.body as string) });
    return script[Math.min(calls.length - 1, script.length - 1)]!();
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

const realFetch = globalThis.fetch;
let healCalls: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
let healedBody: Record<string, unknown>;

beforeEach(() => {
  process.env.AUTOFIX_URL = HEAL_URL;
  healCalls = [];
  healedBody = { model: 'gemini-2.5-flash', generationConfig: { temperature: 1 } };
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    healCalls.push({ body: JSON.parse(init?.body as string), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify({
      status: 'unverified', issueId: 'i1', healAttemptId: 'a1',
      healedBody,
    }), { status: 200 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.AUTOFIX_URL;
});

test('heals @ai-sdk/google GenerateContent and includes contents when opted in', async () => {
  healedBody = { model: 'models/gemini-2.5-flash', generationConfig: { temperature: 1 } };
  const provider = providerStub([googleError, googleSuccess]);
  const google = createGoogleGenerativeAI({
    apiKey: 'provider-secret',
    fetch: autofix({ fetch: provider.fn, sendMessages: true }),
  });
  const result = await generateText({
    model: google('gemini-1.0-pro'),
    prompt: 'private prompt',
    temperature: 0.2,
    maxRetries: 0,
  });

  assert.equal(result.text, 'healed');
  const payload = healCalls[0]!.body;
  assert.equal(payload.provider, 'gemini');
  assert.equal(payload.api, 'chat_completions');
  assert.deepEqual((payload.response as Record<string, unknown>).error, {
    message: 'models/gemini-1.0-pro is not found', type: 'NOT_FOUND', code: '404',
  });
  assert.equal((payload.request as Record<string, unknown>).model, 'gemini-1.0-pro');
  assert.deepEqual(
    (payload.request as Record<string, unknown>).contents,
    provider.calls[0]!.body.contents,
  );
  assert.equal(healCalls[0]!.headers.get('x-autofix-source'), 'vercel-sdk');

  const exchange = payload.providerExchange as ProviderExchangePayload;
  assert.equal(exchange.format, 'google_generate_content');
  assert.equal(exchange.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.0-pro:generateContent');
  assert.equal('model' in exchange.request.body, false);
  assert.deepEqual(exchange.request.body.contents, provider.calls[0]!.body.contents);

  assert.match(provider.calls[1]!.url, /models\/gemini-2\.5-flash:generateContent$/);
  assert.equal('model' in provider.calls[1]!.body, false);
  assert.deepEqual(provider.calls[1]!.body.contents, provider.calls[0]!.body.contents);
  assert.equal((provider.calls[1]!.body.generationConfig as Record<string, unknown>).temperature, 1);
});

test('recognizes streaming paths, redacts contents by default, and preserves the query', async () => {
  const provider = providerStub([googleError, googleSuccess]);
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'private prompt' }] }],
    systemInstruction: { parts: [{ text: 'private system' }] },
    generationConfig: { temperature: 0.2 },
  };
  const url = 'https://gateway.test/v1beta/models/gemini-1.0-pro:streamGenerateContent?alt=sse';
  const response = await autofix({ fetch: provider.fn })(url, {
    method: 'POST', body: JSON.stringify(body),
  });

  assert.equal(response.status, 200);
  const payload = healCalls[0]!.body;
  assert.equal(payload.url,
    'https://gateway.test/v1beta/models/gemini-1.0-pro:streamGenerateContent');
  assert.deepEqual(payload.request, {
    model: 'gemini-1.0-pro', generationConfig: { temperature: 0.2 },
  });
  const exchange = payload.providerExchange as ProviderExchangePayload;
  assert.deepEqual(exchange.request.redactedFields, ['contents', 'systemInstruction']);
  assert.match(provider.calls[1]!.url, /streamGenerateContent\?alt=sse$/);
  assert.deepEqual(provider.calls[1]!.body.contents, body.contents);
  assert.deepEqual(provider.calls[1]!.body.systemInstruction, body.systemInstruction);
});

test('a GenerateContent-shaped path without a model still fails open safely', async () => {
  const provider = providerStub([googleError, googleSuccess]);
  const url = 'https://gateway.test/v1beta/gemini:generateContent';
  const body = { contents: [], generationConfig: { temperature: 0.2 } };
  const response = await autofix({ fetch: provider.fn })(url, {
    method: 'POST', body: JSON.stringify(body),
  });

  assert.equal(response.status, 200);
  assert.equal('model' in (healCalls[0]!.body.request as Record<string, unknown>), false);
  assert.equal(provider.calls[1]!.url, url);
  assert.equal('model' in provider.calls[1]!.body, false);
});

test('a malformed encoded model is omitted from the logical request', async () => {
  healedBody = { generationConfig: { temperature: 1 } };
  const provider = providerStub([googleError, googleSuccess]);
  const url = 'https://gateway.test/v1beta/models/%E0%A4%A:generateContent';
  await autofix({ fetch: provider.fn })(url, {
    method: 'POST', body: JSON.stringify({ contents: [] }),
  });
  assert.equal('model' in (healCalls[0]!.body.request as Record<string, unknown>), false);
});
