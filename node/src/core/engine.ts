// The healing engine — provider-agnostic.
//
// gate → ask → merge → replay, stateless, fail-open. On a request-shape
// failure the stripped body (knobs only, never content) goes to the heal API;
// the healed body comes back, is merged under the original's content, and the
// request is replayed once. Anything goes wrong → the original error, byte for
// byte.
//
// Everything provider-specific lives in an Adapter: which paths this wrapper
// is allowed to touch, and what identifies a body as that dialect's. See
// src/openai/ and src/anthropic/. The decision of what may be touched is in
// core/gate.ts; what may travel is in core/anonymize.ts; talking to the heal
// service is core/heal-api.ts.

import { randomUUID } from 'node:crypto';
import { isPlainObject, mergeHealedBody, stripRequest } from './anonymize.ts';
import { callerHeaders, HEALABLE_STATUS, openGate, type Adapter, type Healable } from './gate.ts';
import { healApi, type HealApi, type HealResult } from './heal-api.ts';
import type { SdkSource } from './source.ts';

export { routeTable } from './gate.ts';
export type { Dialect, Route } from './gate.ts';

export interface AutofixOptions {
  onHeal?: (e: HealEvent) => void;     // observability hook — the only way to see what happened
  fetch?: typeof globalThis.fetch;     // inner transport (default: global fetch)
  healTimeoutMs?: number;              // budget for each heal-API call, including
                                       // the outcome report (default 5000)
}

export interface HealEvent {
  traceId: string;
  url: string;
  healStatus: 'patched' | 'unverified' | 'resolving' | 'no_patch'
    | 'heal_unreachable' | 'replay_failed';
  summary?: string;                    // heal API explanation.summary — the human "why"
  operations?: { type: string; detail: string }[]; // server's explained edits, for logs
  replayStatusCode?: number;
  healMs?: number;
  replayMs?: number;
}

// The heal call sits in front of an error the caller is already waiting on, so
// it gets a budget. Without one a hung heal API holds the caller until undici's
// 300s headers timeout — the opposite of "never worse than without us".
const HEAL_TIMEOUT_MS = 5000;

/** Build a self-healing fetch for one provider's route table. */
export function createAutofix(adapter: Adapter) {
  return function autofix(options: AutofixOptions = {}): typeof globalThis.fetch {
    const inner = options.fetch ?? globalThis.fetch;
    const api = healApi(options.healTimeoutMs ?? HEAL_TIMEOUT_MS);

    return async (input, init) => {
      const started = Date.now();
      const res = await inner(input, init);

      // ── gate ── success path exits on this line: zero overhead. Everything
      // subtler about whether we may touch this failure lives in openGate.
      if (res.ok || !HEALABLE_STATUS.has(res.status)) return res;
      const healable = await openGate(adapter, res, input, init);
      if (!healable) return res;

      return healAndReplay(
        { inner, api, onHeal: options.onHeal, input, init: init!, original: res,
          providerMs: Date.now() - started },
        healable,
      );
    };
  };
}

/** One heal attempt: the transports it may use and the response it started from. */
interface Attempt {
  inner: typeof globalThis.fetch;
  api: HealApi;
  onHeal?: (e: HealEvent) => void;
  input: RequestInfo | URL;
  init: RequestInit;
  original: Response;
  providerMs: number;
}

interface Replayed { replay: Response; replayMs: number }

type Emit = (e: Omit<HealEvent, 'traceId' | 'url'>) => void;

async function healAndReplay(attempt: Attempt, gate: Healable): Promise<Response> {
  const traceId = randomUUID();
  const emit = emitter(attempt, gate, traceId);

  // ── ask ── every failure that clears the gate consults the heal API; the
  // server is the only authority on what the current fix is.
  const healStarted = Date.now();
  let heal: HealResult;
  try {
    heal = await attempt.api.heal(healPayload(attempt, gate, traceId), gate.source);
  } catch {
    emit({ healStatus: 'heal_unreachable', healMs: Date.now() - healStarted });
    return attempt.original;            // FAIL OPEN: autofix is never the outage
  }
  const healMs = Date.now() - healStarted;
  const summary = heal.explanation?.summary;

  const healedBody = servedBody(heal);
  if (!healedBody) {
    emit({ healStatus: heal.status ?? 'no_patch', summary, healMs });
    return attempt.original;            // resolving / no_patch → original error
  }

  const replayed = await replayOnce(attempt, gate, healedBody);
  if (!replayed) {
    emit({ healStatus: 'replay_failed', summary, healMs });
    return attempt.original;            // never worse than without us
  }
  return settle(attempt, heal, replayed, { healMs, emit, source: gate.source });
}

/**
 * The caller's observability hook, wrapped. A bug in their own callback is not
 * allowed to become an outage we caused, so it is swallowed like every other
 * failure on this path.
 */
function emitter(attempt: Attempt, gate: Healable, traceId: string): Emit {
  return (e) => {
    try {
      attempt.onHeal?.({ traceId, url: gate.url, ...e });
    } catch {
      // the hook is for watching, never for deciding
    }
  };
}

/**
 * Report the outcome, tell the hook, and choose the response the caller sees.
 * Replay ALSO failed → the ORIGINAL error: never worse than without us. Replay
 * succeeded → the app never saw a failure, and the original is nobody's to read.
 */
function settle(attempt: Attempt, heal: HealResult, replayed: Replayed,
                ctx: { healMs: number; emit: Emit; source: SdkSource }): Response {
  const { replay, replayMs } = replayed;
  // On a failed replay the caller gets the original response and never reads
  // this one, so hand over the body itself: cloning would tee it for nobody.
  if (heal.healAttemptId) {
    attempt.api.reportOutcome(heal.healAttemptId, replay.status, ctx.source,
      replay.ok ? undefined : replay);
  } else if (!replay.ok) {
    replay.body?.cancel().catch(() => {}); // nobody will read it; free the connection
  }
  // No fallback on the status: settle only runs on a body servedBody stood
  // behind, and it only does that for 'patched' or 'unverified'.
  ctx.emit({ healStatus: heal.status, summary: heal.explanation?.summary,
    operations: heal.explanation?.operations, replayStatusCode: replay.status,
    healMs: ctx.healMs, replayMs });

  if (!replay.ok) return attempt.original;
  attempt.original.body?.cancel().catch(() => {});
  return replay;
}

/**
 * The body to replay, or null when the heal API has nothing to stand behind.
 *
 * An object specifically. An array has keys, so it clears the emptiness check
 * and would be replayed verbatim — the server would be choosing the entire
 * request body, content included, because merging onto an array sets
 * properties JSON.stringify then drops. The heal API's answer is untrusted.
 */
function servedBody(heal: HealResult): Record<string, unknown> | null {
  const served = heal.status === 'patched' || heal.status === 'unverified';
  if (!served || !isPlainObject(heal.healedBody)) return null;
  return Object.keys(heal.healedBody).length > 0 ? heal.healedBody : null;
}

function healPayload(attempt: Attempt, gate: Healable, traceId: string) {
  return {
    traceId,
    tenantId: attempt.api.tenantId,
    provider: gate.provider,
    api: gate.api,
    url: gate.url,
    // ANONYMIZED: the settings leave, the structure and the content stay.
    request: stripRequest(gate.request),
    response: {
      statusCode: attempt.original.status,
      error: gate.error,
    },
    responseTimeMs: attempt.providerMs,
  };
}

/**
 * Merge and replay once: same URL, same headers minus content-length (the body
 * changed size; the transport recomputes it). The provider key stays on its
 * original path. Goes through `inner`, not this wrapper, so a replay can never
 * be healed again.
 *
 * Headers come from the gate's own resolution, not from init alone: a caller
 * who put its authorization on a Request object would otherwise replay
 * unauthenticated and turn a heal into a 401. Copied before content-length goes,
 * because that Headers instance may be the caller's Request's own.
 *
 * The merge happens in here so a healedBody that can't be merged — unclonable,
 * absurdly nested — falls open like everything else instead of throwing at the
 * caller. Null on any failure. The clock starts after the merge, because
 * replayMs is meant to be the provider's time and not ours.
 */
async function replayOnce(attempt: Attempt, gate: Healable,
                          healedBody: Record<string, unknown>): Promise<Replayed | null> {
  try {
    const body = JSON.stringify(mergeHealedBody(gate.request, healedBody));
    const headers = new Headers(callerHeaders(attempt.input, attempt.init));
    headers.delete('content-length');
    const startedAt = Date.now();
    const replay = await attempt.inner(attempt.input, { ...attempt.init, headers, body });
    return { replay, replayMs: Date.now() - startedAt };
  } catch {
    return null;
  }
}
