// The gate — everything that decides whether a failed response is one autofix
// is allowed to touch. It reads and it decides; it never acts.

import { detectSource, type SdkSource } from './source.ts';

/**
 * A provider's route table.
 *
 * Routes match on the URL's PATH, not its host: you opted in by passing this
 * fetch to that SDK, so autofix follows wherever the SDK's baseURL points —
 * a gateway, a proxy, Azure, localhost. A host allowlist would make the
 * wrapper silently inert for most real deployments.
 *
 * The safety boundary is therefore: (1) you chose this adapter explicitly,
 * (2) the path is an LLM endpoint shape, and (3) only scalar settings can
 * travel or be written back — structure and content never do (core/anonymize.ts).
 */
export interface Adapter {
  /** Provider + api for a URL, or null when this wrapper must stay inert. */
  detect(url: URL): Route | null;
}

export interface Route {
  provider: string;
  api: string;
  /**
   * Top-level body keys that say "this body really is this dialect". At least
   * one must be present, or the request is none of our business — this is what
   * makes matching on a path TAIL safe. Owned by the dialect because only the
   * dialect knows what identifies it: `/responses` also answers to a stored
   * prompt reference, `/chat/completions` and `/messages` do not.
   */
  identifiedBy: readonly string[];
}

/**
 * One wire dialect: the path tail that selects it, and the route it resolves
 * to. Each dialect module (src/openai/chat.ts, src/anthropic/messages.ts, …)
 * exports its own, so an entry point never restates path or provider.
 */
export interface Dialect {
  path: string;
  route: Route;
}

/** The provider's own error, forwarded to the heal API unmodified. */
export interface ProviderError {
  message: string;
  type?: string;
  param?: string;
  code?: string;
}

/** A failure autofix may act on, carrying everything the heal call needs. */
export interface Healable {
  url: string;
  provider: string;
  api: string;
  request: Record<string, unknown>;
  error: ProviderError;
  /** Which SDK the app wrapped — classified from the request's own headers. */
  source: SdkSource;
}

/**
 * Statuses worth waking up for. Checked by the caller before anything else so
 * the success path stays a single comparison: 401/403 (auth) and 429/5xx (the
 * SDK's own retry territory) never get this far.
 */
export const HEALABLE_STATUS = new Set([400, 404, 422]);

/**
 * Endpoint paths vary by deployment — `/v1/chat/completions` on OpenAI,
 * `/api/v1/chat/completions` on OpenRouter,
 * `/openai/deployments/<name>/chat/completions` on Azure — but the tail is
 * stable, so match that.
 */
export function pathEndsWith(url: URL, suffix: string): boolean {
  return url.pathname === suffix || url.pathname.endsWith(suffix);
}

/**
 * An adapter over a list of dialects: the first whose path tail matches wins,
 * and no match leaves the wrapper inert. Every entry point is one of these, so
 * a single-provider export and the universal export can only ever be different
 * subsets of the same table — never different answers for the same URL.
 */
export function routeTable(dialects: readonly Dialect[]): Adapter {
  return {
    detect: (url) => dialects.find((d) => pathEndsWith(url, d.path))?.route ?? null,
  };
}

/**
 * What we tell the heal API the request went to. Origin + path only: query
 * strings and fragments are dropped because some gateways carry tokens there
 * (`?api-key=…`), and with arbitrary hosts allowed we can no longer assume the
 * query is safe to forward.
 */
export function safeUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

// A URL we can't parse is a URL we can't route. Parsing throws on relative
// input, and a throw here would surface instead of the caller's own response.
function parseUrl(input: RequestInfo | URL): URL | null {
  try {
    return new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return null;
  }
}

/**
 * The wrapped SDK's outgoing headers. SDKs pass them in init; a caller using
 * a Request object carries them there instead. Missing entirely → empty.
 *
 * Throws on a HeadersInit the Headers constructor refuses, and each caller
 * decides what that costs: classification degrades to 'unknown' below, while
 * the engine's replay gives up rather than send a request stripped of the
 * caller's credentials.
 */
export function callerHeaders(input: RequestInfo | URL, init: RequestInit | undefined): Headers {
  if (init?.headers) return new Headers(init.headers as HeadersInit);
  return input instanceof Request ? input.headers : new Headers();
}

// Which SDK the app wrapped. A HeadersInit the Headers constructor refuses is a
// caller oddity, not a reason to skip their heal: classification is analytics,
// so it degrades to 'unknown' and the healing goes ahead.
function classifySource(input: RequestInfo | URL, init: RequestInit | undefined): SdkSource {
  try {
    return detectSource(callerHeaders(input, init));
  } catch {
    return 'unknown';
  }
}

/**
 * The cheap half of the gate: could this request be healed at all? Answered
 * without touching a body, so a call we were never going to touch costs a
 * couple of string comparisons.
 */
function inScope(adapter: Adapter, input: RequestInfo | URL, init: RequestInit | undefined):
{ url: URL; route: Route } | null {
  const url = parseUrl(input);
  if (!url) return null;
  const route = adapter.detect(url);
  if (!route) return null;
  // JSON POST bodies only — no uploads, no multipart.
  if ((init?.method ?? 'GET').toUpperCase() !== 'POST') return null;
  if (typeof init?.body !== 'string') return null;
  return { url, route };
}

/**
 * A JSON object this route recognizes as its own dialect, or null for
 * everything else valid JSON is allowed to be.
 *
 * The route's identifying keys are the second half of the route check, and they
 * are what makes the path tail safe to match on. Almost always that means
 * `model` (Azure included — the deployment goes in the path and `model` stays
 * in the body); the Responses API also accepts a stored prompt template in its
 * place. Endpoints that merely END in one of our tails carry neither: OpenAI's
 * Assistants API posts `{role, content, attachments}` to
 * `/threads/{id}/messages`, which is the Anthropic dialect's tail and none of
 * our business. The key has to be the body's OWN so a polluted
 * `Object.prototype.model` can't reopen the gate on a body that never carried
 * one.
 */
function parseObjectBody(body: string, route: Route): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(body);
  const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  if (!isObject) return null;
  const request = parsed as Record<string, unknown>;
  return route.identifiedBy.some((key) => Object.hasOwn(request, key)) ? request : null;
}

/**
 * The healable failure behind this response, or null to leave it alone.
 * Uploads, off-route paths, and bodies that don't parse all return null: when
 * in doubt the wrapper does nothing and the caller keeps its own response.
 */
export async function openGate(
  adapter: Adapter,
  res: Response,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Healable | null> {
  const scope = inScope(adapter, input, init);
  if (!scope) return null;
  try {
    const request = parseObjectBody(init!.body as string, scope.route);
    if (!request) return null;
    const error: ProviderError | undefined = (await res.clone().json())?.error; // clone: original stays readable
    if (!error?.message) return null;
    return {
      url: safeUrl(scope.url),
      provider: scope.route.provider,
      api: scope.route.api,
      request,
      error,
      source: classifySource(input, init),
    };
  } catch {
    return null;                        // unparseable → not our problem
  }
}
