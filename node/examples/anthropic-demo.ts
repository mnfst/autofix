// E2E smoke: Anthropic SDK + autofix + the hosted heal API.
// A real bad request against api.anthropic.com — normally an APIError; with
// autofix it heals and returns a 200. Run: npm run demo:anthropic

import Anthropic from '@anthropic-ai/sdk';
import { autofix, type HealEvent } from '../src/index.ts';

const events: HealEvent[] = [];

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY, // unchanged — the SDK's auth stays the SDK's
  maxRetries: 0,                         // demo clarity: no SDK-level retries in the way
  fetch: autofix({
    onHeal: (e) => {
      events.push(e);
      console.log(`   [autofix] ${e.healStatus}${e.summary ? ` — ${e.summary}` : ''}${
        e.replayStatusCode ? ` → replay ${e.replayStatusCode}` : ''}`);
    },
  }),
});

console.log('\n▶ S1 unsupported param frequency_penalty (dropped by omission)');
let failures = 0;
try {
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 64,
    system: 'You are terse.',                    // top-level system prompt — must never travel
    messages: [{ role: 'user', content: 'Say hi in exactly five words.' }],
    // Not an Anthropic parameter — the API 400s on it. Cast: the SDK's types
    // correctly reject it, but real apps send it after switching providers.
    frequency_penalty: 0.5,
  } as unknown as Anthropic.MessageCreateParamsNonStreaming);
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  console.log(`   ✓ 200 — ${res.model}: "${text}"`);
} catch (err) {
  failures++;
  const e = err as { status?: number; message?: string };
  console.log(`   ✗ failed — ${e.status ?? ''} ${String(e.message).split('\n')[0]}`);
}

console.log(`\n${1 - failures}/1 scenarios healed, ${events.length} heal events`);
process.exit(failures === 0 ? 0 : 1);
