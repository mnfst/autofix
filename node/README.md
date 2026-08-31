# Autofix Node

Self-healing `fetch()` for OpenAI, Anthropic, and native Google Gemini requests. When a request fails with a fixable request-shape error — a renamed parameter, a restricted value, a retired model — autofix repairs it at runtime and retries. Your code doesn't change; your users never see the failure.

## Installation

Use one import per SDK. Routing follows the request path, including custom
`baseURL` values.

```bash
npm install @mnfst/autofix
```

## Usage

```ts
import OpenAI from 'openai';
import { autofix } from '@mnfst/autofix';

const client = new OpenAI({
  fetch: autofix(),
});

const res = await client.chat.completions.create({
  model: 'gpt-5-mini',
  temperature: 0.2,                         // gpt-5 models reject this — normally a 400
  messages: [{ role: 'user', content: 'Hello!' }],
});
// → healed at runtime (temperature set to 1), returns a normal 200
```

```ts
const response = await client.responses.create({
  model: 'gpt-5-mini',
  temperature: 0.2,
  input: 'Hello!',
});
```

```ts
import Anthropic from '@anthropic-ai/sdk';
import { autofix } from '@mnfst/autofix';

const client = new Anthropic({ fetch: autofix() });
const message = await client.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 256,
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

```ts
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { autofix } from '@mnfst/autofix';

const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  fetch: autofix({ sendMessages: true }),
});
```

OpenRouter uses the OpenAI SDK with its own `baseURL`:

```ts
import OpenAI from 'openai';
import { autofix } from '@mnfst/autofix/openai';

const client = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  fetch: autofix(),
});
```

## How it works

On a `400`, `404` or `422`, autofix applies the privacy filter described below, asks the heal API for the current fix, applies it, and replays once. Anything goes wrong → your original error, unchanged.

## Never worse than without it

- **Zero overhead on success** — the wrapper only wakes up on a healable failure.
- **Fail open** — heal API down, slow, or out of ideas: you get the original error. The heal call has a 5s budget, so it can't sit on top of a failure you're already waiting for.
- **Your key never leaves** — the provider API key stays on your SDK's request, on its original path.

## Privacy

The heal API receives settings, not prompt data:

```jsonc
// sent to the heal API
{
  "model": "gpt-5-mini",
  "temperature": 0.2
}

// kept local and restored on replay
{
  "messages": [{ "role": "user", "content": "Hello!" }],
  "tools": [...]
}
```

Scalar settings and scalar-only arrays may travel. Prompts, tools, nested arrays,
schema bodies, identity fields, and credential fields stay local. The provider error,
endpoint origin and path, derived workspace id, and SDK source are also sent.

`autofix({ sendMessages: true })` (default `false`) opts the top-level `messages`
or Gemini `contents` array in, verbatim. It is observability only: the heal API
still cannot author or rewrite the conversation on the way back.

## See heals

```ts
const client = new OpenAI({
  fetch: autofix({
    onHeal: ({ healStatus, summary }) => {
      console.log(`[autofix] ${healStatus}: ${summary ?? ''}`);
    },
  }),
});
```

## License

MIT © Manifest
