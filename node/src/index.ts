// @mnfst/autofix — one self-healing fetch() for every supported SDK.
//
//     import { autofix } from '@mnfst/autofix';
//
//     new OpenAI({ fetch: autofix() });          // OpenAI SDK
//     new Anthropic({ fetch: autofix() });       // Anthropic SDK
//     createOpenAI({ fetch: autofix() });        // Vercel AI SDK
//     createAnthropic({ fetch: autofix() });     // Vercel AI SDK
//     createGoogle({ fetch: autofix() });        // Vercel AI SDK
//
// The dialect IS the path, so one route table covers every SDK: /messages is
// Anthropic's wire format, /chat/completions and /responses are OpenAI's, and
// :generateContent is Google's. Routing follows the SDK's baseURL anywhere
// (gateways, Azure, LiteLLM, localhost); an unknown path leaves the wrapper
// inert. This is the package's only entry point: there is nothing to choose
// between, and no way to install a wrapper that misses a dialect you use.

import { createAutofix, routeTable } from './core/engine.ts';
import * as messages from './anthropic/messages.ts';
import * as generateContent from './google/generate-content.ts';
import * as chat from './openai/chat.ts';
import * as responses from './openai/responses.ts';

export type { AutofixOptions, HealEvent } from './core/engine.ts';

// The union of every dialect. Each module carries its own path and route (see
// core/gate.ts), so this table is a list of dialects and nothing more.
export const autofix = createAutofix(routeTable([generateContent, messages, responses, chat]));
