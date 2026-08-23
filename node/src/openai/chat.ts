// chat_completions dialect — the classic completions API.

import type { Route } from '../core/engine.ts';

export const api = 'chat_completions' as const;

// `model` is required on every chat completion, stored prompts included, so a
// body without one is not this dialect.
export const identifiedBy = ['model'] as const;

// This dialect's own route identity: the path tail that selects it, and what
// the heal API is told about it. Owned here so every entry point that offers
// this dialect agrees, by construction, on the same answer.
export const path = '/chat/completions';
export const route: Route = { provider: 'openai', api, identifiedBy };
