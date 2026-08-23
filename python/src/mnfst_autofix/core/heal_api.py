"""The heal API client - the only code here that talks to the hosted Phoenix app.
Every call is budgeted, and the outcome report is fire-and-forget: neither can
turn into an error the calling app has to handle.

Mirrors node/src/core/heal-api.ts.
"""

from __future__ import annotations

import asyncio
import getpass
import hashlib
import json
import os
import socket
import sys
import threading
from typing import Any, Dict, Optional

import httpx

from .. import __version__

HOSTED_HEAL_URL = "https://phoenix-yc-production.up.railway.app"
# The user-agent identifies the reporting engine; x-autofix-source (per
# instance, below) is which SDK the app wrapped. Both client-claimed, analytics
# only; the trust-bearing `source` is stamped server-side from auth. Joined
# server-side they give language × SDK.
USER_AGENT = f"autofix-python/{__version__}"
HEADERS = {"content-type": "application/json", "user-agent": USER_AGENT}
# The heal call sits in front of an error the caller is already waiting on, so
# it gets a budget of its own rather than inheriting whatever the heal client
# was built with. The outcome report is held to the same budget.
HEAL_TIMEOUT_MS = 5000
# Ceiling on concurrent outcome reports. Reached only under a burst of healed
# failures, where dropping evidence beats holding threads.
MAX_OUTCOME_THREADS = 8
# The enum is the whole contract. Anything else is a caller typo or an injection
# attempt (a header value with CRLF in it makes httpx refuse the heal outright),
# so it degrades to `unknown` rather than poisoning the header or costing a heal.
_SOURCES = frozenset({"openai-sdk", "anthropic-sdk", "vercel-sdk", "unknown"})
# What the heal API actually accepts. `unknown` is ours: it classifies, it never
# travels.
_HEADER_SOURCES = _SOURCES - {"unknown"}


def derive_tenant_id() -> Optional[str]:
    """Workspace identity, derived - never persisted, nothing written anywhere.
    sha256(hostname + username + project root): stable per workspace per machine,
    opaque to the heal API. In a container the hostname IS the container id, so
    /app installs don't collide."""
    try:
        raw = f"{socket.gethostname()}|{getpass.getuser()}|{os.getcwd()}"
        return hashlib.sha256(raw.encode()).hexdigest()
    except Exception:
        return None  # identity is best-effort, never an outage


class _HealApiBase:
    """Endpoint, budget and identity. Shared by the sync and async clients."""

    def __init__(self, *, heal_timeout_ms: int = HEAL_TIMEOUT_MS,
                 source: Optional[str] = None):
        self.base_url = os.environ.get("AUTOFIX_URL") or HOSTED_HEAL_URL
        self.timeout_s = heal_timeout_ms / 1000
        self.tenant_id = derive_tenant_id()
        # `unknown` is omitted, never sent as a value: the heal API accepts only
        # the three SDK names, and 400s the rest - a rejected heal for the sake
        # of one analytics row. Sending it explicitly used to be how the server
        # told "current client that classified nothing" from "client older than
        # the header"; the user-agent already carries autofix-python/<version>,
        # so that split survives the omission. Do not re-add it.
        self.headers = dict(HEADERS)
        api_key = os.environ.get("AUTOFIX_API_KEY")
        if api_key:
            self.headers["authorization"] = f"Bearer {api_key}"
        if source in _HEADER_SOURCES:
            self.headers["x-autofix-source"] = source

    def _log_debug(self, payload: Dict[str, Any]) -> None:
        if os.environ.get("AUTOFIX_DEBUG"):
            print(f"[autofix:debug] heal payload → {json.dumps(payload)}", file=sys.stderr)

    @staticmethod
    def _result(res: httpx.Response) -> Dict[str, Any]:
        if res.is_error:
            raise RuntimeError(f"heal API {res.status_code}")
        body = res.json()
        # A 200 can still carry null, a string or a list: a proxy, a cache, a
        # bad deploy. Anything that is not an object joins the unreachable path
        # instead of becoming an AttributeError in the caller's stack.
        if not isinstance(body, dict):
            raise RuntimeError("heal API returned a non-object body")
        return body

    @staticmethod
    def outcome_payload(replay_status: int, error: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"retryStatusCode": replay_status}
        if error:
            payload["error"] = error
        return payload


class HealApi(_HealApiBase):
    """Sync heal client."""

    def __init__(self, client: Optional[httpx.Client] = None, **kwargs: Any):
        super().__init__(**kwargs)
        self._client = client or httpx.Client()
        self._owns_client = client is None
        # Outcome reports are daemon threads, so they can't delay interpreter
        # exit, and capped, so a burst of healed failures can't spawn one each.
        # Over the cap the report is dropped: it is evidence, not the request.
        self._slots = threading.Semaphore(MAX_OUTCOME_THREADS)

    def heal(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        self._log_debug(payload)
        return self._result(self._client.post(
            f"{self.base_url}/api/heal", json=payload,
            headers=self.headers, timeout=self.timeout_s))

    def report_outcome(self, attempt_id: str, replay_status: int,
                       error: Optional[Dict[str, Any]]) -> None:
        """Fire and forget - never awaited, never raises."""
        if not self._slots.acquire(blocking=False):
            return  # already reporting as much as we're willing to spend threads on
        try:
            threading.Thread(target=self._send, daemon=True,
                             args=(attempt_id, replay_status, error)).start()
        except Exception:
            self._slots.release()  # out of threads entirely - not the app's problem

    def _send(self, attempt_id: str, replay_status: int,
              error: Optional[Dict[str, Any]]) -> None:
        try:
            self._client.patch(
                f"{self.base_url}/api/heal-attempts/{attempt_id}",
                json=self.outcome_payload(replay_status, error),
                headers=self.headers, timeout=self.timeout_s)
        except Exception:
            pass  # best effort - must never surface to the app
        finally:
            self._slots.release()

    def close(self) -> None:
        """Closes the heal client only if we made it. One we were handed belongs
        to whoever handed it over."""
        if self._owns_client:
            self._client.close()


class AsyncHealApi(_HealApiBase):
    """Async twin - same calls, awaited."""

    def __init__(self, client: Optional[httpx.AsyncClient] = None, **kwargs: Any):
        super().__init__(**kwargs)
        self._client = client or httpx.AsyncClient()
        self._owns_client = client is None
        self._pending: set = set()  # strong refs to fire-and-forget outcome tasks

    async def heal(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        self._log_debug(payload)
        return self._result(await self._client.post(
            f"{self.base_url}/api/heal", json=payload,
            headers=self.headers, timeout=self.timeout_s))

    def report_outcome(self, attempt_id: str, replay_status: int,
                       error: Optional[Dict[str, Any]]) -> None:
        """Fire and forget - never awaited, never raises."""
        try:
            task = asyncio.get_running_loop().create_task(
                self._send(attempt_id, replay_status, error))
        except Exception:
            return  # no loop, or a closing one - not the app's problem
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)

    async def _send(self, attempt_id: str, replay_status: int,
                    error: Optional[Dict[str, Any]]) -> None:
        try:
            await self._client.patch(
                f"{self.base_url}/api/heal-attempts/{attempt_id}",
                json=self.outcome_payload(replay_status, error),
                headers=self.headers, timeout=self.timeout_s)
        except Exception:
            pass  # best effort - must never surface to the app

    async def aclose(self) -> None:
        """Give in-flight outcome reports their moment, then close what we made.
        `async with AsyncOpenAI(...)` exits the instant the healed response is
        returned, so without this the report almost never lands."""
        if self._pending:
            await asyncio.wait(set(self._pending), timeout=self.timeout_s)
        if self._owns_client:
            await self._client.aclose()
