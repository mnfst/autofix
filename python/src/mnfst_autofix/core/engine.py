"""The healing engine - provider-agnostic.

gate -> ask -> merge -> replay, stateless, fail-open. On a request-shape
failure the stripped body (knobs only, never content) goes to the heal API;
the healed body comes back, is merged under the original's content, and the
request is replayed once. Anything goes wrong -> the original error, byte for
byte.

Everything provider-specific lives in a `detect` callable: which paths this
transport may touch, and what identifies a body as that dialect's. See
mnfst_autofix/openai/ and mnfst_autofix/anthropic/.

Two shells over one _Attempt (see attempt.py), which owns every decision they
share. All that differs here is how each one waits. What may be touched is in
gate.py; what may travel is in anonymize.py; talking to the heal service is
heal_api.py.

Mirrors node/src/core/engine.ts stage for stage.
"""

from __future__ import annotations

import time
from typing import Any, Callable, Optional

import httpx

from .attempt import HealEvent, _aread_error, _Attempt, _read_error
from .gate import HEALABLE_STATUS, Detect, Route, in_scope, open_gate, path_ends_with
from .heal_api import HEAL_TIMEOUT_MS, AsyncHealApi, HealApi

_DEFAULT_TIMEOUT = httpx.Timeout(600.0, connect=5.0)  # match the SDKs' own default

__all__ = [
    "AsyncAutofixTransport",
    "AutofixTransport",
    "Detect",
    "HealEvent",
    "Route",
    "make_clients",
    "path_ends_with",
]


class AutofixTransport(httpx.BaseTransport):
    """Sync transport. Wraps an inner transport (default: real HTTP)."""

    def __init__(self, detect: Detect, inner: Optional[httpx.BaseTransport] = None,
                 heal_client: Optional[httpx.Client] = None, *,
                 on_heal: Optional[Callable[[HealEvent], None]] = None,
                 heal_timeout_ms: int = HEAL_TIMEOUT_MS,
                 source: Optional[str] = None):
        self._detect = detect
        self._inner = inner or httpx.HTTPTransport()
        self._owns_inner = inner is None
        self._api = HealApi(heal_client, heal_timeout_ms=heal_timeout_ms, source=source)
        self._on_heal = on_heal

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        started = time.monotonic()
        response = self._inner.handle_request(request)

        # ── gate ── success path exits on this line: zero overhead. 401/403
        # (auth) and 429/5xx (the SDK's own retry territory) pass through
        # untouched. in_scope() runs before the body is read so a failure on a
        # path we never touch costs nothing; the rest is in open_gate.
        if response.status_code not in HEALABLE_STATUS:
            return response
        if in_scope(self._detect, request) is None:
            return response
        try:
            response.read()
        except Exception:
            return response  # a body we cannot read is a body we cannot heal
        gate = open_gate(self._detect, request, response)
        if gate is None:
            return response
        attempt = _Attempt(self._api, self._on_heal, request, response, gate,
                           int((time.monotonic() - started) * 1000))

        # ── ask ── every failure that clears the gate consults the heal API;
        # the server is the only authority on what the current fix is.
        try:
            heal = self._api.heal(attempt.start_heal())
        except Exception:
            return attempt.unreachable()
        attempt.stop_heal()
        healed = attempt.served_body(heal)
        if healed is None:
            return attempt.not_served(heal)

        # ── merge + replay ── once, through the inner transport, never this
        # one: a replay can never be healed again. The merge is inside the try
        # so a degenerate healed body falls open like everything else.
        try:
            replay = self._inner.handle_request(
                attempt.start_replay(healed))
        except Exception:
            return attempt.replay_failed()  # never worse than without us
        attempt.stop_replay()
        return attempt.finish(heal, replay, _read_error(replay))

    def close(self) -> None:
        """Closes the inner transport only if we made it. One we were handed may
        be shared with clients that still want it."""
        try:
            if self._owns_inner:
                self._inner.close()
        finally:
            self._api.close()


class AsyncAutofixTransport(httpx.AsyncBaseTransport):
    """Async twin of AutofixTransport - same flow, awaited I/O."""

    def __init__(self, detect: Detect, inner: Optional[httpx.AsyncBaseTransport] = None,
                 heal_client: Optional[httpx.AsyncClient] = None, *,
                 on_heal: Optional[Callable[[HealEvent], None]] = None,
                 heal_timeout_ms: int = HEAL_TIMEOUT_MS,
                 source: Optional[str] = None):
        self._detect = detect
        self._inner = inner or httpx.AsyncHTTPTransport()
        self._owns_inner = inner is None
        self._api = AsyncHealApi(heal_client, heal_timeout_ms=heal_timeout_ms, source=source)
        self._on_heal = on_heal

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        started = time.monotonic()
        response = await self._inner.handle_async_request(request)

        if response.status_code not in HEALABLE_STATUS:
            return response
        if in_scope(self._detect, request) is None:
            return response
        try:
            await response.aread()
        except Exception:
            return response
        gate = open_gate(self._detect, request, response)
        if gate is None:
            return response
        attempt = _Attempt(self._api, self._on_heal, request, response, gate,
                           int((time.monotonic() - started) * 1000))

        try:
            heal = await self._api.heal(attempt.start_heal())
        except Exception:
            return attempt.unreachable()
        attempt.stop_heal()
        healed = attempt.served_body(heal)
        if healed is None:
            return attempt.not_served(heal)

        try:
            replay = await self._inner.handle_async_request(
                attempt.start_replay(healed))
        except Exception:
            return attempt.replay_failed()
        attempt.stop_replay()
        return attempt.finish(heal, replay, await _aread_error(replay))

    async def aclose(self) -> None:
        """Drains outcome reports, then closes the inner transport only if we
        made it. One we were handed belongs to whoever handed it over."""
        try:
            await self._api.aclose()
        finally:
            if self._owns_inner:
                await self._inner.aclose()


def make_clients(detect: Detect, source: Optional[str] = None):
    """Build the `autofix()` / `autofix_async()` pair for one provider. `source`
    names the SDK this entry point wraps, reported on every heal call."""

    def autofix(**options: Any) -> httpx.Client:
        """An httpx.Client wired for self-healing - pass as SDK(http_client=...)."""
        options.setdefault("source", source)
        return httpx.Client(transport=AutofixTransport(detect, **options),
                            timeout=_DEFAULT_TIMEOUT)

    def autofix_async(**options: Any) -> httpx.AsyncClient:
        """The async twin - pass as AsyncSDK(http_client=...)."""
        options.setdefault("source", source)
        return httpx.AsyncClient(transport=AsyncAutofixTransport(detect, **options),
                                 timeout=_DEFAULT_TIMEOUT)

    return autofix, autofix_async
