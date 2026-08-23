// responses dialect — the newer unified API.

import type { Route } from '../core/engine.ts';

export const api = 'responses' as const;

// `model` is optional here, and only here: a call that names a stored prompt
// template (`prompt: { id, version?, variables? }`) inherits the model from the
// template. Either key means the body is genuinely this dialect's.
export const identifiedBy = ['model', 'prompt'] as const;

// This dialect's own route identity: the path tail that selects it, and what
// the heal API is told about it. Owned here so every entry point that offers
// this dialect agrees, by construction, on the same answer.
export const path = '/responses';
export const route: Route = { provider: 'openai', api, identifiedBy };
