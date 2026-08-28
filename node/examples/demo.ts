// E2E demo: OpenAI SDK + autofix + the hosted heal API.
// Three canned bad requests against real api.openai.com — each would normally
// throw an APIError; with autofix they heal and return a 200.

import OpenAI from 'openai';
import { autofix, type HealEvent } from '../src/index.ts';

const events: HealEvent[] = [];

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // unchanged — the SDK's auth stays the SDK's
  maxRetries: 0,                      // demo clarity: no SDK-level retries in the way
  fetch: autofix({
    // heal API: AUTOFIX_URL env if set, hosted autofix.manifest.build otherwise
    onHeal: (e) => {
      events.push(e);
      console.log(`   [autofix] ${e.healStatus}${e.summary ? ` — ${e.summary}` : ''}${
        e.replayStatusCode ? ` → replay ${e.replayStatusCode}` : ''}`);
    },
  }),
});

type Scenario = { name: string; run: () => Promise<string> };

const scenarios: Scenario[] = [
  {
    // S1: model deprecated in 2024 — expect remap gpt-4-0314 → gpt-5
    name: 'S1 deprecated model gpt-4-0314 (remap)',
    run: async () => {
      const res = await client.chat.completions.create({
        model: 'gpt-4-0314',
        messages: [{ role: 'user', content: 'Say hi in exactly five words.' }],
      });
      return `${res.model}: ${res.choices[0]?.message?.content ?? '(no text)'}`;
    },
  },
  {
    // S2: reasoning models only accept the default temperature — expect set_param temperature=1
    name: 'S2 gpt-5-mini + temperature 0.2 (set_param)',
    run: async () => {
      const res = await client.chat.completions.create({
        model: 'gpt-5-mini',
        temperature: 0.2,
        messages: [{ role: 'user', content: 'Say hi in exactly five words.' }],
      });
      return `${res.model}: ${res.choices[0]?.message?.content ?? '(no text)'}`;
    },
  },
  {
    // S3: retired preview model — expect remap o1-preview → o3
    name: 'S3 retired model o1-preview (remap)',
    run: async () => {
      const res = await client.chat.completions.create({
        model: 'o1-preview',
        messages: [{ role: 'user', content: 'Say hi in exactly five words.' }],
      });
      return `${res.model}: ${res.choices[0]?.message?.content ?? '(no text)'}`;
    },
  },
];

let failures = 0;
for (const s of scenarios) {
  console.log(`\n▶ ${s.name}`);
  try {
    const text = await s.run();
    console.log(`   ✓ 200 — "${text.trim()}"`);
  } catch (err) {
    failures++;
    const e = err as { status?: number; message?: string };
    console.log(`   ✗ failed — ${e.status ?? ''} ${String(e.message).split('\n')[0]}`);
  }
}

console.log(`\n${scenarios.length - failures}/${scenarios.length} scenarios healed, ${
  events.length} heal events`);
process.exit(failures === 0 ? 0 : 1);
