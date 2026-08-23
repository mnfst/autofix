// The request privacy boundary, mirrored by
// python/src/mnfst_autofix/core/anonymize.py.
//
// A structural forbid list keeps audited content, identity, schema, location,
// and credential fields home at any depth. Arrays travel only when every element
// is a scalar; arrays containing nested structure stay home and are never walked.
// Plain objects are walked, so scalar leaves and scalar-only arrays under unknown
// custom keys can travel. That lets new provider controls reach the heal API
// without waiting for a package release, but it does not make arbitrary custom
// scalar fields private.
//
// On the way back the healed body is authoritative for what it names, and
// everything that stayed home comes from the caller's own copy. So a heal can
// correct a setting it was shown, and can delete one by leaving it out, but it
// can neither author nor delete anything it never saw.

/**
 * Key names that never travel, at any depth, whatever they hold.
 *
 * `content`, `input`, `instructions`, `system`, `prompt`, `stop` and
 * `stop_sequences` are free-form user text — the prompt under another name.
 * `schema` and `json_schema` are the caller's own JSON Schema: their data model,
 * field by field. `user`, `safety_identifier`, `prompt_cache_key` and `metadata`
 * say who the end user is and what they are billed and cached under.
 * `prediction` is the user's verbatim document, quoted back to the model.
 * `authorization_token` is a live bearer token for somebody else's server.
 * `user_location` is where the end user physically is.
 */
const NEVER_TRAVELS: ReadonlySet<string> = new Set([
  'content', 'input', 'instructions', 'system', 'prompt', 'stop', 'stop_sequences',
  'schema', 'json_schema',
  'user', 'metadata', 'safety_identifier', 'prompt_cache_key', 'user_location',
  'prediction', 'authorization_token',
]);

/**
 * These travel so the heal API can diagnose them, but its answer never gets to
 * change them. Streaming is fixed once the SDK chooses how to parse the
 * response; n and store control spend and retention.
 */
const CALLER_OWNED: ReadonlySet<string> = new Set(['stream', 'stream_options', 'n', 'store']);

/** An object we can safely walk into. Arrays and null are not that. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * An array with no structure in it: a fixed vocabulary like `["text", "audio"]`,
 * not a payload. Anything nested is a place bulk content could hide, so one
 * object or one array anywhere in it keeps the whole thing home. An empty array
 * qualifies because it carries nothing.
 */
function isScalarArray(value: unknown[]): boolean {
  return value.every((item) => !isPlainObject(item) && !Array.isArray(item));
}

/**
 * Return [travels, what the heal API is shown] for one key of a request.
 *
 * The name check runs before the shape check because `stop` and `stop_sequences`
 * are arrays of scalars and would otherwise qualify — but those scalars are the
 * user's own words, so the name has to win.
 *
 * An object whose every leaf stayed home returns false rather than `{}`: an
 * empty container would tell the heal API the caller sent nothing there, which
 * is the one thing that is not true.
 */
function sent(key: string, value: unknown): [boolean, unknown] {
  if (NEVER_TRAVELS.has(key)) return [false, undefined];
  // Copied, like every other level, so nothing that travels aliases the caller.
  if (Array.isArray(value)) return isScalarArray(value) ? [true, [...value]] : [false, undefined];
  if (!isPlainObject(value)) return [true, value];
  const inner = sentObject(value);
  return [Object.keys(inner).length > 0, inner];
}

/** One level of the walk, rebuilt from scratch so nothing aliases the caller. */
function sentObject(source: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const [travels, shown] = sent(key, value);
    if (travels) kept[key] = shown;
  }
  return kept;
}

/** The request as the heal API sees it: the settings, and nothing else. */
export function stripRequest(request: Record<string, unknown>): Record<string, unknown> {
  return sentObject(request);
}

/**
 * The body to replay: the healed answer over the caller's own request.
 *
 * The healed body is put through the same walk as the request before it is
 * believed, so the server can only ever speak in the vocabulary the client
 * speaks — no arrays with anything nested in them, none of the forbidden names.
 * That is what stops a heal from smuggling `messages` back in, and it costs the
 * server nothing it could legitimately want to say.
 *
 * Then, key by key at every depth: what the client withheld is the caller's,
 * always. What the client sent, the healed body settles — its value if it names
 * one, and DROPPED if it does not. Deletion by omission is how a parameter gets
 * removed now, and unlike a list of known knobs it works for a parameter nobody
 * has ever heard of.
 */
export function mergeHealedBody(
  original: Record<string, unknown>,
  healedBody: Record<string, unknown>,
): Record<string, unknown> {
  return mergeLevel(original, sentObject(healedBody));
}

function mergeLevel(original: Record<string, unknown>,
                    healed: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(original)) {
    if (CALLER_OWNED.has(key) || !sent(key, value)[0]) {
      merged[key] = value;              // never travelled → not the server's to touch
      continue;
    }
    const answered = Object.hasOwn(healed, key);
    const answer = answered ? healed[key] : undefined;
    if (isPlainObject(value)) {
      // A container is settled one leaf at a time: silence about the container
      // still drops every leaf that travelled, and still restores every leaf
      // that did not — a user schema inside a healed `text` outlives the heal.
      const kept = mergeLevel(value, isPlainObject(answer) ? answer : {});
      if (Object.keys(kept).length > 0) merged[key] = kept;
    } else if (answered) {
      merged[key] = answer;
    }
  }
  for (const [key, value] of Object.entries(healed)) {
    // A setting the caller never sent: the server may add it, unless it is one
    // of the caller's own.
    if (!Object.hasOwn(original, key) && !CALLER_OWNED.has(key)) merged[key] = value;
  }
  return merged;
}
