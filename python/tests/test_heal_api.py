"""Ownership and the fire-and-forget outcome report.

Two things the transports promise that no request-level test can see: what gets
closed when the caller is done, and that an outcome report is evidence rather
than part of the request - dropped, never awaited, never raised.
"""

import asyncio
import json
import threading
import time

import httpx
import pytest

from mnfst_autofix.core.heal_api import (
    _SOURCES,
    MAX_OUTCOME_THREADS,
    AsyncHealApi,
    HealApi,
)
from mnfst_autofix.openai import AsyncAutofixTransport, AutofixTransport
from mnfst_autofix.openai import detect as openai_detect

OPENAI = "https://api.openai.com/v1/chat/completions"
HEAL_URL = "http://heal.test"

CHAT_BODY = {"model": "gpt-5-mini", "temperature": 0.2,
             "messages": [{"role": "user", "content": "SECRET"}]}

ERR_400 = {"error": {
    "message": "Unsupported value: 'temperature' does not support 0.2 with this model.",
    "type": "invalid_request_error", "param": "temperature", "code": "unsupported_value",
}}

DEFAULT_HEAL = {
    "status": "unverified", "issueId": "i1", "healAttemptId": "a1",
    "healedBody": {"model": "gpt-5-mini", "temperature": 1},
}


@pytest.fixture(autouse=True)
def heal_env(monkeypatch):
    monkeypatch.setenv("AUTOFIX_URL", HEAL_URL)
    monkeypatch.delenv("AUTOFIX_API_KEY", raising=False)


class ProviderStub:
    """Alternates the failure and the healed reply, forever."""

    def __init__(self):
        self.calls = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.calls % 2:
            return httpx.Response(400, json=ERR_400)
        return httpx.Response(200, json={"ok": True})

    def transport(self):
        return httpx.MockTransport(self.handler)

    def async_transport(self):
        async def ahandler(request):
            return self.handler(request)
        return httpx.MockTransport(ahandler)


class HealStub:
    def __init__(self, responder=None):
        self.calls = []
        self.responder = responder or (lambda body: httpx.Response(200, json=DEFAULT_HEAL))

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.calls.append({"url": str(request.url), "method": request.method, "body": body,
                           "headers": request.headers})
        return self.responder(body)

    def client(self):
        return httpx.Client(transport=httpx.MockTransport(self.handler))

    def async_client(self):
        async def ahandler(request):
            return self.handler(request)
        return httpx.AsyncClient(transport=httpx.MockTransport(ahandler))

    def patches(self):
        return [c for c in self.calls if c["method"] == "PATCH"]


def post_chat(client):
    return client.post(OPENAI, content=json.dumps(CHAT_BODY),
                       headers={"content-type": "application/json"})


# --- ownership ---------------------------------------------------------------
# Closing is not "close everything in reach": a transport or client we were
# handed may be shared with callers that still want it.


def test_closing_leaves_an_inner_transport_it_was_handed_open():
    inner = ProviderStub().transport()
    closed = []
    inner.close = lambda: closed.append(True)

    AutofixTransport(openai_detect, inner=inner, heal_client=HealStub().client()).close()
    assert closed == [], "an inner transport we were handed belongs to whoever handed it over"


def test_closing_leaves_a_heal_client_it_was_handed_open():
    heal_client = HealStub().client()
    AutofixTransport(openai_detect, inner=ProviderStub().transport(),
                     heal_client=heal_client).close()
    assert not heal_client.is_closed, "a client we were handed belongs to whoever handed it over"


def test_closing_closes_the_inner_transport_and_heal_client_it_made(monkeypatch):
    closed = []
    monkeypatch.setattr(httpx.HTTPTransport, "close", lambda self: closed.append(self))

    transport = AutofixTransport(openai_detect)  # nothing handed in: both are ours
    transport.close()
    assert closed, "the inner transport we made is ours to close"
    assert transport._api._client.is_closed, "and so is the heal client"


def test_closing_still_closes_the_heal_client_when_the_inner_close_raises(monkeypatch):
    def boom(self):
        raise RuntimeError("socket already gone")

    monkeypatch.setattr(httpx.HTTPTransport, "close", boom)
    transport = AutofixTransport(openai_detect)  # both are ours
    with pytest.raises(RuntimeError):
        transport.close()
    assert transport._api._client.is_closed, "the heal client is closed in a finally"


def test_aclosing_still_closes_the_async_inner_when_the_drain_raises(monkeypatch):
    closed = []

    async def record(self):
        closed.append(self)

    async def boom(self):
        raise RuntimeError("the loop is already going away")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "aclose", record)
    monkeypatch.setattr(AsyncHealApi, "aclose", boom)

    async def main():
        transport = AsyncAutofixTransport(openai_detect)
        with pytest.raises(RuntimeError):
            await transport.aclose()

    asyncio.run(main())
    assert closed, "the inner transport is closed in a finally"


def test_aclosing_leaves_an_async_inner_transport_it_was_handed_open():
    inner = ProviderStub().async_transport()
    closed = []

    async def record():
        closed.append(True)

    inner.aclose = record

    async def main():
        await AsyncAutofixTransport(openai_detect, inner=inner,
                                    heal_client=HealStub().async_client()).aclose()

    asyncio.run(main())
    assert closed == [], "an inner transport we were handed is not ours to close"


def test_aclosing_leaves_an_async_heal_client_it_was_handed_open():
    heal_client = HealStub().async_client()

    async def main():
        await AsyncAutofixTransport(openai_detect, inner=ProviderStub().async_transport(),
                                    heal_client=heal_client).aclose()

    asyncio.run(main())
    assert not heal_client.is_closed, "a client we were handed belongs to its owner"


def test_aclosing_closes_the_async_inner_transport_and_heal_client_it_made(monkeypatch):
    closed = []

    async def record(self):
        closed.append(self)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "aclose", record)

    async def main():
        transport = AsyncAutofixTransport(openai_detect)  # nothing handed in
        await transport.aclose()
        return transport

    transport = asyncio.run(main())
    assert closed, "the inner transport we made is ours to close"
    assert transport._api._client.is_closed, "and so is the heal client"


# --- the outcome report is evidence, never the request -----------------------


def test_the_async_client_drains_outcome_reports_before_it_closes():
    """`async with AsyncOpenAI(...)` exits the instant the healed response is
    returned, so the drain in aclose is the only reason the report lands."""
    provider = ProviderStub()
    heal = HealStub()

    async def main():
        transport = AsyncAutofixTransport(openai_detect, inner=provider.async_transport(),
                                          heal_client=heal.async_client(), source="openai-sdk")
        async with httpx.AsyncClient(transport=transport) as client:  # no sleep on purpose
            res = await client.post(OPENAI, content=json.dumps(CHAT_BODY),
                                    headers={"content-type": "application/json"})
        return res, heal.patches()  # read the instant aclose returned, not later

    res, patched_by_close = asyncio.run(main())
    assert res.status_code == 200
    assert patched_by_close, "the outcome landed because aclose waited for it"

    # Both async call sites end to end, on the wire rather than by attribute:
    # dropping `headers=` from either one in heal_api.py has to fail here.
    assert [c["method"] for c in heal.calls] == ["POST", "PATCH"]
    for call in heal.calls:
        assert call["headers"]["x-autofix-source"] == "openai-sdk", call["method"]
        assert call["headers"]["user-agent"].startswith("autofix-python/"), call["method"]


def test_an_async_aclose_with_nothing_pending_does_not_wait():
    """Nothing was healed, so there is nothing to drain and no reason to stall."""
    heal = HealStub()

    async def main():
        api = AsyncHealApi(heal.async_client())
        await api.aclose()

    asyncio.run(main())
    assert heal.calls == []


def test_an_async_outcome_report_with_no_loop_to_run_on_is_dropped():
    heal = HealStub()
    AsyncHealApi(heal.async_client()).report_outcome("a1", 200, None)
    assert heal.calls == [], "nothing to schedule on, and nothing raised"


def test_an_outcome_report_beyond_the_thread_ceiling_is_dropped():
    """Over the ceiling the report is dropped: it is evidence, not the request."""
    burst = MAX_OUTCOME_THREADS + 1
    holding = threading.Event()

    def hold_every_outcome(body):
        if "retryStatusCode" in body:
            holding.wait(2.0)  # every reporting thread stays busy
        return httpx.Response(200, json=DEFAULT_HEAL)

    provider = ProviderStub()
    heal = HealStub(hold_every_outcome)
    client = httpx.Client(transport=AutofixTransport(
        openai_detect, inner=provider.transport(), heal_client=heal.client()))
    try:
        for _ in range(burst):
            assert post_chat(client).status_code == 200, "every caller is healed regardless"
        deadline = time.monotonic() + 2.0
        while len(heal.patches()) < MAX_OUTCOME_THREADS and time.monotonic() < deadline:
            time.sleep(0.01)
        time.sleep(0.05)  # the one over the ceiling would show up here
        assert len(heal.patches()) == MAX_OUTCOME_THREADS, "threads are capped, not the requests"
    finally:
        holding.set()


def test_a_dropped_report_does_not_leak_the_slot_it_never_took():
    """The ceiling is a high-water mark, not a budget that runs out: once the
    busy threads finish, the next failure reports again."""
    burst = MAX_OUTCOME_THREADS + 1
    holding = threading.Event()

    def hold_every_outcome(body):
        if "retryStatusCode" in body:
            holding.wait(2.0)
        return httpx.Response(200, json=DEFAULT_HEAL)

    provider = ProviderStub()
    heal = HealStub(hold_every_outcome)
    client = httpx.Client(transport=AutofixTransport(
        openai_detect, inner=provider.transport(), heal_client=heal.client()))
    for _ in range(burst):
        post_chat(client)
    holding.set()  # the held threads drain and give their slots back

    deadline = time.monotonic() + 5.0
    while len(heal.patches()) < MAX_OUTCOME_THREADS and time.monotonic() < deadline:
        time.sleep(0.01)
    before = len(heal.patches())
    # Retry rather than sleep on a guess: the slot comes back when the held
    # thread returns, which is a moment after its PATCH was recorded.
    while len(heal.patches()) == before and time.monotonic() < deadline:
        post_chat(client)
        time.sleep(0.02)
    assert len(heal.patches()) > before, "reporting resumes once the threads are free"


def test_an_outcome_report_that_cannot_get_a_thread_is_dropped(monkeypatch):
    def out_of_threads(self):
        raise RuntimeError("can't start new thread")

    monkeypatch.setattr(threading.Thread, "start", out_of_threads)
    provider = ProviderStub()
    heal = HealStub()
    client = httpx.Client(transport=AutofixTransport(
        openai_detect, inner=provider.transport(), heal_client=heal.client()))
    assert post_chat(client).status_code == 200, "the caller is healed either way"
    assert heal.patches() == [], "the evidence is dropped, never the request"


def test_a_report_that_lost_its_thread_gives_the_slot_back(monkeypatch):
    """Otherwise a machine that briefly ran out of threads would stop reporting
    outcomes for the rest of the process's life."""
    api = HealApi(HealStub().client())
    monkeypatch.setattr(threading.Thread, "start",
                        lambda self: (_ for _ in ()).throw(RuntimeError("no threads")))
    for _ in range(MAX_OUTCOME_THREADS + 2):
        api.report_outcome("a1", 200, None)
    monkeypatch.undo()

    assert api._slots.acquire(blocking=False), "every slot it took, it gave back"
    api._slots.release()


def test_the_outcome_payload_carries_an_error_only_when_there_is_one():
    assert HealApi.outcome_payload(200, None) == {"retryStatusCode": 200}
    assert HealApi.outcome_payload(400, {"message": "still bad"}) == {
        "retryStatusCode": 400, "error": {"message": "still bad"}}
    assert HealApi.outcome_payload(400, {}) == {"retryStatusCode": 400}, "empty is no error"


# --- x-autofix-source: which SDK the app wrapped -----------------------------
# The entry point IS the source here - one module per SDK, so nothing has to be
# sniffed off the request the way node's single union export must.


def _heal_calls_for(source=None):
    """Drives one heal end to end and hands back what reached the heal API."""
    provider = ProviderStub()
    heal = HealStub()
    kwargs = {"source": source} if source else {}
    transport = AutofixTransport(openai_detect, inner=provider.transport(),
                                 heal_client=heal.client(), **kwargs)
    with httpx.Client(transport=transport) as client:
        assert post_chat(client).status_code == 200
        deadline = time.monotonic() + 2.0
        while not heal.patches() and time.monotonic() < deadline:
            time.sleep(0.01)
    assert [c["method"] for c in heal.calls] == ["POST", "PATCH"]
    return heal.calls


@pytest.mark.parametrize("source", ["openai-sdk", "anthropic-sdk", "vercel-sdk"])
def test_source_header_travels_on_heal_post_and_outcome_patch(source):
    """Both heal-API calls carry it, next to the user-agent that names the
    engine: joined server-side they give language × SDK."""
    for call in _heal_calls_for(source):
        assert call["headers"]["x-autofix-source"] == source, call["method"]
        assert call["headers"]["user-agent"].startswith("autofix-python/"), call["method"]


def test_api_key_authenticates_the_heal_and_outcome_calls(monkeypatch):
    monkeypatch.setenv("AUTOFIX_API_KEY", "demo-secret")
    for call in _heal_calls_for("openai-sdk"):
        assert call["headers"]["authorization"] == "Bearer demo-secret", call["method"]


def test_neither_heal_call_carries_a_source_it_could_not_declare():
    """On the wire, not by attribute: `unknown` must not reach either call in
    any form - the heal API 400s the value and an empty one alike."""
    for call in _heal_calls_for():
        assert "x-autofix-source" not in call["headers"], call["method"]


def test_an_undeclared_source_sends_no_header_at_all():
    """The heal API 400s `x-autofix-source: unknown`, and a 400 is a dead heal.
    Absence carries the same meaning for free - and it has to be absence, not an
    empty value, which would be rejected just the same."""
    api = HealApi(HealStub().client())
    assert "x-autofix-source" not in api.headers


def test_a_source_outside_the_enum_sends_no_header_either():
    """`source` is a kwarg, so a caller can put anything there. A value with CRLF
    in it makes httpx refuse the heal call outright - the header is not worth a
    heal, and an invented enum value is not worth a row of analytics."""
    client = HealStub().client()
    assert "x-autofix-source" not in HealApi(client, source="x\r\nX-Injected: 1").headers
    assert "x-autofix-source" not in HealApi(client, source="totally-made-up").headers
    assert HealApi(client, source="vercel-sdk").headers["x-autofix-source"] == "vercel-sdk"


def test_async_client_carries_the_source_too():
    inner = HealStub().async_client()
    api = AsyncHealApi(inner, source="anthropic-sdk")
    assert api.headers["x-autofix-source"] == "anthropic-sdk"
    asyncio.run(inner.aclose())


def test_entry_points_declare_their_sdk():
    """Reaching into the transport on purpose: the wiring from entry point to
    heal client is what this asserts, and nothing public exposes it."""
    from mnfst_autofix import anthropic as anthropic_mod
    from mnfst_autofix import openai as openai_mod

    for mod, expected in ((openai_mod, "openai-sdk"), (anthropic_mod, "anthropic-sdk")):
        client = mod.autofix()
        try:
            assert client._transport._api.headers["x-autofix-source"] == expected
        finally:
            client.close()

        aclient = mod.autofix_async()
        try:
            assert aclient._transport._api.headers["x-autofix-source"] == expected
        finally:
            asyncio.run(aclient.aclose())


def test_every_source_the_client_can_emit_is_one_the_heal_api_accepts():
    """The incident (issue #11): the client emitted `vercel-ai-sdk` and
    `unknown`, the heal API accepts neither, and the 400 it answered with killed
    the heal outright. The list below is a hardcoded copy of the server's
    accepted set, never fetched: a rename on this side has to fail here rather
    than in production."""
    accepted_by_server = ["anthropic-sdk", "openai-sdk", "vercel-sdk"]
    client = HealStub().client()
    emitted = set()
    for source in _SOURCES:  # everything the classifier can hand the heal client
        headers = HealApi(client, source=source).headers
        if "x-autofix-source" in headers:
            emitted.add(headers["x-autofix-source"])
    assert sorted(emitted) == accepted_by_server
