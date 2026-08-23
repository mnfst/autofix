// messages dialect — Anthropic's /v1/messages API.
//

import type { Route } from '../core/engine.ts';

export const api = 'messages' as const;

// `model` is required on every Anthropic message, and it is the whole reason
// OpenAI's Assistants API — which posts `{role, content, attachments}` to
// `/threads/{id}/messages`, this dialect's tail — stays inert.
export const identifiedBy = ['model'] as const;

// This dialect's own route identity: the path tail that selects it, and what
// the heal API is told about it. Owned here so every entry point that offers
// this dialect agrees, by construction, on the same answer. The tail must END
// with `/messages`, which is what keeps `/v1/messages/batches` — a different
// request shape, not a single failing call — inert.
export const path = '/messages';
export const route: Route = { provider: 'anthropic', api, identifiedBy };
