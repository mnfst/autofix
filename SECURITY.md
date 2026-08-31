# Security

## Reporting a vulnerability

Email security@manifest.build. Please don't open a public issue first. We'll
confirm within three working days.

## What the client sends

Autofix wakes up on a `400`, `404` or `422` from a path it recognises as an LLM
endpoint, on whatever host your SDK is pointed at, and sends the failed request
to a heal API. Worth knowing exactly what that means:

**Removed before anything is sent, and restored from your own copy on the
replay:** `messages`, Gemini `contents`, `input`, `instructions`, system prompts,
tools, and response schemas. The strip is a union across dialects, so a content
field is removed on every API, not just the one that normally carries it. See
`node/src/core/anonymize.ts` or
`python/src/mnfst_autofix/core/anonymize.py`.

**Sent as-is:** the provider's error message. Healing depends on it, and
providers sometimes quote part of your request back inside it.

**Sent:** the request URL trimmed to origin and path (the query string is
dropped, because gateways sometimes carry tokens there), the model, and the
remaining parameters. Plus a workspace id,
`sha256(hostname + username + working directory)`. It's derived per call and
never written anywhere, but the same machine and directory always produce the
same value, so treat it as pseudonymous.

**Never sent:** your provider API key. It stays on your SDK's request, on its
original path. Autofix is not a gateway and never sees it.

## Scope

Matching is on the request path, not the host. Passing `autofix()` to an SDK is
the opt-in; from there it follows wherever that SDK's `baseURL` points, so a
self-hosted gateway or a proxy is in scope by design. If that isn't what you
want, don't pass `autofix()` to that client. That call is the whole opt-in,
and removing it is the whole opt-out.

## What the heal API can do to a request

It decides every parameter that isn't yours, including the model. Your content
and your `stream` / `stream_options` are applied last on the replay, so a heal
response that tries to set them is overwritten rather than trusted. Everything
else it says goes.

That's a real trust relationship. If you'd rather not have it:

- Don't pass `autofix()` to the client. Nothing is wrapped, nothing is sent.
- `AUTOFIX_URL` points the client at a heal API you run.
- `AUTOFIX_DEBUG=1` prints each payload to stderr before it leaves, so you can
  see for yourself rather than take our word for it.
