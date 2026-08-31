// E2E demo: Vercel AI SDK + autofix + the hosted heal API.
// One autofix() fetch shared by both providers — the root export routes by
// path. Each scenario would normally throw; with autofix it heals to a 200.
// Needs OPENAI_API_KEY and ANTHROPIC_API_KEY (via .env or the environment).
//
// Why all three defects are retired model ids: the AI SDK normalizes parameters
// client-side before it builds the request (it deletes temperature and top_p
// for reasoning models, and drops frequency_penalty/presence_penalty/seed on
// the Responses API), so a bad *param* never reaches the provider through this
// SDK and there is nothing for autofix to heal. The model id is the one field
// the SDK forwards verbatim. The three scenarios below therefore cover the
// three distinct paths exercised here — /chat/completions, /responses and
// /messages — which is the claim this demo exists to prove.

import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { autofix, type HealEvent } from '../src/index.ts';

const events: HealEvent[] = [];
const healingFetch = autofix({
  onHeal: (e) => {
    events.push(e);
    console.log(`   [autofix] ${e.healStatus}${e.summary ? ` — ${e.summary}` : ''}${
      e.replayStatusCode ? ` → replay ${e.replayStatusCode}` : ''}`);
  },
});

// One fetch, two providers: routing is by path, not by import.
const openai = createOpenAI({ fetch: healingFetch });
const anthropic = createAnthropic({ fetch: healingFetch });

type Scenario = { name: string; run: () => Promise<string> };

const scenarios: Scenario[] = [
  {
    // Retired preview model on the chat dialect — expect remap o1-preview → o3.
    // openai.chat() pins this to /v1/chat/completions.
    name: 'S1 AI SDK + retired model o1-preview, /chat/completions (remap)',
    run: async () => {
      const { text } = await generateText({
        model: openai.chat('o1-preview'),
        maxRetries: 0,                  // demo clarity: no SDK-level retries in the way
        prompt: 'Say hi in exactly five words.',
      });
      return text;
    },
  },
  {
    // Model deprecated in 2024, on the responses dialect (the provider's
    // default endpoint) — expect remap gpt-4-0314 → gpt-5
    name: 'S2 AI SDK + deprecated model gpt-4-0314, /responses (remap)',
    run: async () => {
      const { text } = await generateText({
        model: openai('gpt-4-0314'),
        maxRetries: 0,
        prompt: 'Say hi in exactly five words.',
      });
      return text;
    },
  },
  {
    // Retired Anthropic model on the messages dialect — expect a remap to a
    // current Claude
    name: 'S3 AI SDK + retired model claude-3-sonnet-20240229, /messages (remap)',
    run: async () => {
      const { text } = await generateText({
        model: anthropic('claude-3-sonnet-20240229'),
        maxRetries: 0,
        prompt: 'Say hi in exactly five words.',
      });
      return text;
    },
  },
];

let failures = 0;
for (const s of scenarios) {
  console.log(`\n▶ ${s.name}`);
  try {
    console.log(`   ✔ ${await s.run()}`);
  } catch (err) {
    failures++;
    console.log(`   ✘ ${(err as Error).message}`);
  }
}
// A scenario that succeeds without a heal is not a heal — it is a defect that
// quietly stopped being one, which is exactly how a broken scenario reads as a
// clean run. So the count, the wording and the exit code are all the HEALS: a
// replay that came back under 400. `succeeded` is reported next to it, never
// instead of it.
const healed = events.filter(
  (e) => e.replayStatusCode !== undefined && e.replayStatusCode < 400).length;
const succeeded = scenarios.length - failures;
console.log(`\n${healed}/${scenarios.length} scenarios healed ` +
  `(${succeeded}/${scenarios.length} succeeded, ${events.length} heal event(s) observed)`);
if (healed < scenarios.length) {
  console.log(`   ✘ ${scenarios.length - healed} scenario(s) never healed — a scenario ` +
    `that succeeds without a heal has stopped being a defect and proves nothing`);
}
process.exit(failures === 0 && healed === scenarios.length ? 0 : 1);
