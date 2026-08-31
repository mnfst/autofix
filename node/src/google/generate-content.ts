// Native Google Gemini GenerateContent dialect used by @ai-sdk/google.

import type { ReplayRequest, Route } from '../core/engine.ts';

export const api = 'chat_completions' as const;
export const identifiedBy = ['contents'] as const;
export const path = [':generateContent', ':streamGenerateContent'] as const;

const MODEL_MARKER = '/models/';

function modelBounds(url: URL): { start: number; end: number } | null {
  const end = url.pathname.lastIndexOf(':');
  const marker = url.pathname.lastIndexOf(MODEL_MARKER, end);
  return marker < 0 || end < marker ? null : { start: marker + MODEL_MARKER.length, end };
}

function modelFromUrl(url: URL): string | undefined {
  const bounds = modelBounds(url);
  if (!bounds) return undefined;
  try {
    return decodeURIComponent(url.pathname.slice(bounds.start, bounds.end));
  } catch {
    return undefined;
  }
}

function replay(url: URL, body: Record<string, unknown>): ReplayRequest {
  const nextBody = { ...body };
  const model = typeof nextBody.model === 'string' ? nextBody.model : undefined;
  delete nextBody.model;
  if (!model) return { url, body: nextBody };
  const bounds = modelBounds(url);
  if (!bounds) return { url, body: nextBody };
  const nextUrl = new URL(url);
  const bareModel = model.startsWith('models/') ? model.slice(MODEL_MARKER.length - 1) : model;
  nextUrl.pathname = `${url.pathname.slice(0, bounds.start)}${bareModel}${url.pathname.slice(bounds.end)}`;
  return { url: nextUrl, body: nextBody };
}

export function route(url: URL): Route {
  return {
    provider: 'gemini',
    api,
    identifiedBy,
    model: modelFromUrl(url),
    providerExchange: {
      format: 'google_generate_content',
      redactedFields: ['contents', 'systemInstruction', 'tools'],
    },
    replay,
  };
}
