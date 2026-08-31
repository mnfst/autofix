"""One heal attempt: the trace id, the timings, and every decision the sync and
async transports share. The shells differ only in how they wait, so the policy
lives here and there is exactly one copy of it.

Mirrors the free functions around healAndReplay in node/src/core/engine.ts.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Protocol

import httpx

from .anonymize import merge_healed_body, strip_request
from .gate import Healable, parse_provider_error


@dataclass
class HealEvent:
    trace_id: str
    url: str
    heal_status: str  # patched | unverified | resolving | no_patch |
                      # heal_unreachable | replay_failed
    summary: Optional[str] = None       # heal API explanation.summary - the human "why"
    operations: Optional[List[Dict[str, str]]] = None  # server's explained edits, for logs
    replay_status_code: Optional[int] = None
    heal_ms: Optional[int] = None
    replay_ms: Optional[int] = None


def _quietly(fn: Callable[[], Any]) -> None:
    """Cleanup that is courtesy, not correctness."""
    try:
        fn()
    except Exception:
        pass


async def _aquietly(fn: Callable[[], Any]) -> None:
    try:
        await fn()
    except Exception:
        pass


def _read_error(replay: httpx.Response) -> Optional[Dict[str, Any]]:
    """The provider error behind a failed replay, for the outcome report. A
    successful replay is left untouched: reading it here would consume the body
    the caller is about to read. A failed one the caller never sees, so closing
    it is on us - including when the read itself fails."""
    if replay.is_success:
        return None
    try:
        replay.read()
        return parse_provider_error(json.loads(replay.content).get("error"))
    except Exception:
        return None  # weak outcome is fine
    finally:
        _quietly(replay.close)


async def _aread_error(replay: httpx.Response) -> Optional[Dict[str, Any]]:
    """Async twin of _read_error."""
    if replay.is_success:
        return None
    try:
        await replay.aread()
        return parse_provider_error(json.loads(replay.content).get("error"))
    except Exception:
        return None
    finally:
        await _aquietly(replay.aclose)


def _explanation(heal: Dict[str, Any]) -> Dict[str, Any]:
    return heal.get("explanation") or {}


def _provider_exchange(gate: Healable, body: Dict[str, Any], status_code: int):
    redacted = [
        field for field in gate.route.redacted_fields
        if field in gate.request and field not in body
    ]
    return {
        "format": gate.route.provider_format,
        "url": gate.url,
        "request": {"body": body, **({"redactedFields": redacted} if redacted else {})},
        "response": {"statusCode": status_code, "body": {"error": gate.error}},
    }


class _OutcomeReporter(Protocol):
    """All _Attempt needs from a heal client. Keeps it blind to sync vs async."""

    tenant_id: Optional[str]

    def report_outcome(self, attempt_id: str, replay_status: int,
                       error: Optional[Dict[str, Any]]) -> None: ...


class _Attempt:
    """One heal attempt: trace id, timings, and every decision except the I/O."""

    def __init__(self, api: _OutcomeReporter, on_heal: Optional[Callable[[HealEvent], None]],
                 request: httpx.Request, response: httpx.Response,
                 gate: Healable, provider_ms: int, *, send_messages: bool = False):
        self._api = api
        self._on_heal = on_heal
        self._request = request
        self._gate = gate
        self._provider_ms = provider_ms
        self._send_messages = send_messages
        self.original = response
        self.trace_id = str(uuid.uuid4())
        self.url = gate.url
        self._heal_started = 0.0
        self._heal_ms: Optional[int] = None
        self._replay_started = 0.0
        self._replay_ms: Optional[int] = None

    def start_heal(self) -> Dict[str, Any]:
        """Start the heal clock and return the payload to send."""
        self._heal_started = time.monotonic()
        native_request = strip_request(self._gate.request, send_messages=self._send_messages)
        request = (
            {"model": self._gate.route.model, **native_request}
            if self._gate.route.model else native_request
        )
        return {
            "traceId": self.trace_id,
            "tenantId": self._api.tenant_id,
            "provider": self._gate.route.provider,
            "api": self._gate.route.api,
            "url": self.url,
            # ANONYMIZED: the settings leave, the structure and the content stay -
            # unless the caller opted the messages in.
            "request": request,
            "response": {
                "statusCode": self.original.status_code,
                "error": self._gate.error,
            },
            **({"providerExchange": _provider_exchange(
                self._gate, native_request, self.original.status_code,
            )} if self._gate.route.provider_format else {}),
            "responseTimeMs": self._provider_ms,
        }

    def stop_heal(self) -> None:
        """Called the moment the heal API answers, one way or the other."""
        self._heal_ms = int((time.monotonic() - self._heal_started) * 1000)

    def unreachable(self) -> httpx.Response:
        """The heal API did not answer. FAIL OPEN: autofix is never the outage."""
        self.stop_heal()
        self._emit(HealEvent(self.trace_id, self.url, "heal_unreachable",
                             heal_ms=self._heal_ms))
        return self.original

    def served_body(self, heal: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """The body to replay, or None when the heal API has nothing to stand behind."""
        healed = heal.get("healedBody")
        if heal.get("status") in ("patched", "unverified") and isinstance(healed, dict) and healed:
            return healed
        return None

    def not_served(self, heal: Dict[str, Any]) -> httpx.Response:
        """resolving / no_patch / empty body -> the caller's original error."""
        self._emit(HealEvent(self.trace_id, self.url, heal.get("status") or "no_patch",
                             summary=_explanation(heal).get("summary"),
                             heal_ms=self._heal_ms))
        return self.original

    def start_replay(self, healed: Dict[str, Any]) -> httpx.Request:
        """Merge, then build the replay: same URL, same headers minus
        content-length (the body changed size; httpx recomputes it). The
        provider key stays on its original path, and `extensions` carries the
        caller's own timeout - a hand-built request without it has no deadline
        at all, so a hung replay would hang the app forever.

        The clock starts after the merge: replay_ms is the provider's time.
        """
        body = merge_healed_body(self._gate.request, healed)
        url = self._request.url
        if self._gate.route.replay:
            url, body = self._gate.route.replay(url, body)
        headers = self._request.headers.copy()
        headers.pop("content-length", None)
        self._replay_started = time.monotonic()
        return httpx.Request("POST", url, headers=headers,
                             content=json.dumps(body).encode(),
                             extensions=self._request.extensions)

    def stop_replay(self) -> None:
        """Called the moment the provider answers, before the body is touched."""
        self._replay_ms = int((time.monotonic() - self._replay_started) * 1000)

    def replay_failed(self) -> httpx.Response:
        """The heal worked and the replay could not be sent. The one outcome an
        operator most wants in the log, and the caller still gets its error."""
        self._emit(HealEvent(self.trace_id, self.url, "replay_failed",
                             heal_ms=self._heal_ms))
        return self.original

    def finish(self, heal: Dict[str, Any], replay: httpx.Response,
               error: Optional[Dict[str, Any]]) -> httpx.Response:
        """Report the outcome, then hand back whichever response the caller
        should see. Replay succeeded -> the app never saw a failure. Replay ALSO
        failed -> the app sees the ORIGINAL error: never worse than without us."""
        if heal.get("healAttemptId"):
            self._api.report_outcome(heal["healAttemptId"], replay.status_code, error)
        explanation = _explanation(heal)
        # No fallback on the status: finish only runs on a body served_body
        # stood behind, and it only does that for "patched" or "unverified".
        self._emit(HealEvent(self.trace_id, self.url, heal["status"],
                             summary=explanation.get("summary"),
                             operations=explanation.get("operations"),
                             replay_status_code=replay.status_code,
                             heal_ms=self._heal_ms, replay_ms=self._replay_ms))
        return replay if replay.is_success else self.original

    def _emit(self, event: HealEvent) -> None:
        if not self._on_heal:
            return
        try:
            self._on_heal(event)
        except Exception:
            # A bug in the caller's own hook is not allowed to become an outage
            # we caused. Swallowed like every other failure on this path.
            pass
