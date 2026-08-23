// The heal API client — the only code here that talks to the hosted Phoenix app.
// Every call is budgeted, and the outcome report is fire-and-forget: neither
// can turn into an error the calling app has to handle.

import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import type { ProviderError } from './gate.ts';
import type { SdkSource } from './source.ts';
import { VERSION } from './version.ts';

export interface HealResult {
  status: 'patched' | 'unverified' | 'resolving' | 'no_patch';
  issueId: string;
  healAttemptId?: string;
  healedBody?: Record<string, unknown>;
  /** Prose for a human, handed to onHeal. Nothing here is ever acted on. */
  explanation?: { summary: string; operations: { type: string; detail: string }[] };
}

export interface HealApi {
  /** Derived workspace id, sent with every heal. Undefined if it can't be derived. */
  readonly tenantId: string | undefined;
  heal(payload: unknown, source: SdkSource): Promise<HealResult>;
  /** The result of a replay. Fire and forget — never awaited, never throws. */
  reportOutcome(healAttemptId: string, replayStatus: number, source: SdkSource,
                failed?: Response): void;
}

const HOSTED_HEAL_URL = 'https://phoenix-yc-production.up.railway.app';
// user-agent identifies the reporting engine; x-autofix-source is which SDK
// the app wrapped. Both client-claimed, analytics only; the trust-bearing
// `source` is stamped server-side from auth. Joined server-side they give
// language × SDK (autofix-node can only wrap JS SDKs).
const HEADERS = {
  'content-type': 'application/json',
  'user-agent': `autofix-node/${VERSION}`,
};
// `unknown` is omitted, never sent as a value: the heal API accepts only the
// three SDK names, and 400s the rest — a rejected heal for the sake of one
// analytics row. Sending it explicitly used to be how the server told "current
// client that classified nothing" from "client older than the header"; the
// user-agent already carries autofix-node/<version>, so that split survives the
// omission. Do not re-add it.
const headersFor = (source: SdkSource): Record<string, string> => {
  const apiKey = process.env.AUTOFIX_API_KEY;
  return {
    ...HEADERS,
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(source === 'unknown' ? {} : { 'x-autofix-source': source }),
  };
};

/**
 * Workspace identity, derived — never persisted, nothing written anywhere.
 * sha256(hostname + username + project root): stable per workspace per
 * machine, opaque to the heal API. In a container the hostname IS the
 * container id, so /app installs don't collide.
 */
function deriveTenantId(): string | undefined {
  try {
    return createHash('sha256')
      .update(`${hostname()}|${userInfo().username}|${process.cwd()}`)
      .digest('hex');
  } catch {
    return undefined;                   // identity is best-effort, never an outage
  }
}

export function healApi(timeoutMs: number): HealApi {
  const baseUrl = process.env.AUTOFIX_URL ?? HOSTED_HEAL_URL;

  async function patchOutcome(healAttemptId: string, replayStatus: number, source: SdkSource,
                              failed?: Response) {
    let error: ProviderError | undefined;
    if (failed) {
      try { error = (await failed.json())?.error; } catch { /* weak outcome is fine */ }
    }
    await fetch(`${baseUrl}/api/heal-attempts/${healAttemptId}`, {
      method: 'PATCH',
      headers: headersFor(source),
      body: JSON.stringify({ retryStatusCode: replayStatus, ...(error ? { error } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return {
    tenantId: deriveTenantId(),

    async heal(payload, source) {
      if (process.env.AUTOFIX_DEBUG) {
        console.error('[autofix:debug] heal payload →', JSON.stringify(payload));
      }
      const res = await fetch(`${baseUrl}/api/heal`, {
        method: 'POST',
        headers: headersFor(source),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`heal API ${res.status}`);
      const body: unknown = await res.json();
      // A 200 can still carry null, a string, or an array: a proxy, a cache, a
      // bad deploy. Anything that isn't an object joins the unreachable path
      // instead of becoming a TypeError in the caller's stack.
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new Error('heal API returned a non-object body');
      }
      return body as HealResult;
    },

    reportOutcome(healAttemptId, replayStatus, source, failed) {
      // Best effort. A failed outcome report is the heal API's problem, and it
      // must never reach the app that just got a working response.
      void patchOutcome(healAttemptId, replayStatus, source, failed).catch(() => {});
    },
  };
}
