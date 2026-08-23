"""Port of packages/js/tests/wrapper.test.ts - transport behavior, sync + async."""

import asyncio
import gc
import json
import threading
import time

import httpx
import pytest

from mnfst_autofix import __version__
from mnfst_autofix.core.gate import open_gate
from mnfst_autofix.openai import AsyncAutofixTransport, AutofixTransport, autofix, autofix_async
from mnfst_autofix.openai import detect as openai_detect

OPENAI = "https://api.openai.com/v1/chat/completions"
RESPONSES = "https://api.openai.com/v1/responses"
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
    "explanation": {"summary": 'Set "temperature" to 1.',
                    "operations": [{"type": "set_param", "detail": "temperature → 1"}]},
}

ok200 = (200, {"ok": True})
err400 = (400, ERR_400)


@pytest.fixture(autouse=True)
def heal_env(monkeypatch):
    monkeypatch.setenv("AUTOFIX_URL", HEAL_URL)


class ExplodingStream(httpx.SyncByteStream):
    """A body that fails on the wire the moment anyone reads it."""

    def __iter__(self):
        raise httpx.ReadError("connection reset")


class AsyncExplodingStream(httpx.AsyncByteStream):
    async def __aiter__(self):
        raise httpx.ReadError("connection reset")
        yield b""  # unreachable - it is what makes this an async generator


class WatchedStream(httpx.SyncByteStream):
    """A body that records whether anyone read it."""

    def __init__(self, payload: bytes):
        self.payload = payload
        self.reads = 0

    def __iter__(self):
        self.reads += 1
        yield self.payload


def uncloseable(response: httpx.Response) -> httpx.Response:
    """A response we can read but not hand back: closing it raises."""
    def boom() -> None:
        raise RuntimeError("socket already gone")

    response.close = boom
    return response


def async_uncloseable(response: httpx.Response) -> httpx.Response:
    async def boom() -> None:
        raise RuntimeError("socket already gone")

    response.aclose = boom
    return response


def down_on_outcome(body):
    """A heal API that answers the heal but drops the outcome report on the floor."""
    if "retryStatusCode" in body:  # the outcome PATCH, not the heal POST
        raise RuntimeError("outcome endpoint down")
    return httpx.Response(200, json=DEFAULT_HEAL)


class ProviderStub:
    """Scripted provider: returns responses from `script` in order, sticking on the last.

    A `(status, body)` entry becomes that response - a dict body is sent as JSON,
    a str as-is. An exception entry is raised instead, standing in for a
    transport that could not send at all, and a hand-built httpx.Response is
    returned as-is for the cases where the body itself is the hostile part.
    """

    def __init__(self, script):
        self.script = script
        self.calls = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        try:
            body = json.loads(request.content)
        except Exception:
            body = None  # uploads and bodyless requests reach the provider too
        self.calls.append({"body": body, "headers": dict(request.headers),
                           "extensions": request.extensions})
        entry = self.script[min(len(self.calls) - 1, len(self.script) - 1)]
        if isinstance(entry, Exception):
            raise entry
        if isinstance(entry, httpx.Response):
            return entry
        status, payload = entry
        if isinstance(payload, str):
            return httpx.Response(status, text=payload)
        return httpx.Response(status, json=payload)

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
                           "headers": dict(request.headers),
                           "timeout": request.extensions.get("timeout", {}).get("read")})
        return self.responder(body)

    def client(self):
        return httpx.Client(transport=httpx.MockTransport(self.handler))

    def async_client(self):
        async def ahandler(request):
            return self.handler(request)
        return httpx.AsyncClient(transport=httpx.MockTransport(ahandler))

    def heal_posts(self):
        return [c for c in self.calls if c["url"].endswith("/api/heal")]

    def patches(self):
        return [c for c in self.calls if c["method"] == "PATCH"]

    def wait_for_patch(self, timeout=2.0):
        """Outcome reports are fire-and-forget (background thread/task) - poll."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.patches():
                return self.patches()
            time.sleep(0.01)
        return self.patches()


def make_client(provider, heal, **options):
    transport = AutofixTransport(openai_detect, inner=provider.transport(),
                                 heal_client=heal.client(), **options)
    return httpx.Client(transport=transport)


def post_chat(client, body=CHAT_BODY):
    return client.post(OPENAI, content=json.dumps(body),
                       headers={"authorization": "Bearer sk-secret",
                                "content-type": "application/json"})


def make_async_client(provider, heal, **options):
    transport = AsyncAutofixTransport(openai_detect, inner=provider.async_transport(),
                                      heal_client=heal.async_client(), **options)
    return httpx.AsyncClient(transport=transport)


def run_async_post(provider, heal, body=CHAT_BODY, url=OPENAI, **options):
    """The async twin of post_chat: one request, driven to completion."""
    async def main():
        async with make_async_client(provider, heal, **options) as client:
            res = await client.post(url, content=json.dumps(body),
                                    headers={"authorization": "Bearer sk-secret",
                                             "content-type": "application/json"})
            await asyncio.sleep(0.05)  # let the fire-and-forget outcome task run
            return res

    return asyncio.run(main())


def test_success_and_non_healable_statuses_pass_through():
    for status in (200, 401, 429, 500):
        provider = ProviderStub([(status, {})])
        heal = HealStub()
        res = post_chat(make_client(provider, heal))
        assert res.status_code == status
        assert heal.calls == []


def test_non_llm_paths_leave_the_transport_inert():
    provider = ProviderStub([err400])
    heal = HealStub()
    client = make_client(provider, heal)
    res = client.post("https://api.example.com/v1/embeddings",
                      content=json.dumps(CHAT_BODY),
                      headers={"content-type": "application/json"})
    assert res.status_code == 400
    assert heal.calls == []


# A custom base_url is the norm, not the exception: gateways, proxies, Azure,
# LiteLLM, localhost. Routing follows the SDK wherever it points.
@pytest.mark.parametrize("url", [
    "https://api.example.com/v1/chat/completions",      # self-hosted proxy
    "https://openrouter.ai/api/v1/chat/completions",    # extra path prefix
    "https://x.openai.azure.com/openai/deployments/gpt-4/chat/completions?api-version=2024-06-01",
])
def test_heals_through_a_custom_base_url(url):
    provider = ProviderStub([err400, ok200])
    heal = HealStub()
    client = make_client(provider, heal)
    res = client.post(url, content=json.dumps(CHAT_BODY),
                      headers={"content-type": "application/json"})
    assert res.status_code == 200, "healed and replayed"
    assert len(heal.heal_posts()) == 1
    assert provider.calls[1]["body"]["temperature"] == 1


def test_litellm_base_url_heals():
    provider = ProviderStub([err400, ok200])
    heal = HealStub()
    client = make_client(provider, heal)
    res = client.post("http://localhost:4000/v1/chat/completions",
                      content=json.dumps(CHAT_BODY),
                      headers={"content-type": "application/json"})

    assert res.status_code == 200, "healed and replayed"
    assert heal.heal_posts()[0]["body"]["url"] == (
        "http://localhost:4000/v1/chat/completions"
    )
    assert provider.calls[1]["body"]["temperature"] == 1


def test_reported_url_drops_query_strings():
    provider = ProviderStub([err400, ok200])
    heal = HealStub()
    events = []
    client = make_client(provider, heal, on_heal=events.append)
    client.post("https://gw.example.com/v1/chat/completions?api-key=SECRET_TOKEN",
                content=json.dumps(CHAT_BODY),
                headers={"content-type": "application/json"})
    payload = heal.calls[0]["body"]
    assert payload["url"] == "https://gw.example.com/v1/chat/completions"
    assert "SECRET_TOKEN" not in json.dumps(payload), "query token never travels"
    assert "SECRET_TOKEN" not in events[0].url


def test_heals_strips_content_sends_identity_merges_replays_reports_outcome():
    provider = ProviderStub([err400, ok200])
    heal = HealStub()
    events = []
    res = post_chat(make_client(provider, heal, on_heal=events.append))
    assert res.status_code == 200

    payload = heal.calls[0]["body"]
    assert "SECRET" not in json.dumps(payload), "no message content on the wire"
    assert "messages" not in payload["request"]
    assert len(payload["tenantId"]) == 64, "derived sha256 workspace id"
    assert payload["provider"] == "openai"
    assert payload["api"] == "chat_completions"

    replay = provider.calls[1]
    assert replay["body"]["temperature"] == 1, "healed knob applied"
    assert replay["body"]["messages"] == CHAT_BODY["messages"], "replay keeps original messages"
    assert replay["headers"]["authorization"] == "Bearer sk-secret", "key stays on its path"

    patches = heal.wait_for_patch()
    assert patches and "/api/heal-attempts/a1" in patches[0]["url"]
    assert patches[0]["body"]["retryStatusCode"] == 200

    # Both heal calls carry the SDK's User-Agent — which SDK reported.
    assert heal.calls[0]["headers"]["user-agent"] == f"autofix-python/{__version__}"
    assert patches[0]["headers"]["user-agent"] == f"autofix-python/{__version__}"

    assert len(events) == 1
    assert events[0].heal_status == "unverified"
    assert events[0].replay_status_code == 200
    assert events[0].summary == 'Set "temperature" to 1.'


def test_healed_body_smuggling_content_is_overwritten_by_the_original():
    injected = {"status": "patched", "issueId": "i1",
                "healedBody": {"model": "gpt-5-mini",
                               "messages": [{"role": "user", "content": "INJECTED"}]}}
    provider = ProviderStub([err400, ok200])
    heal = HealStub(lambda body: httpx.Response(200, json=injected))
    post_chat(make_client(provider, heal))
    assert provider.calls[1]["body"]["messages"] == CHAT_BODY["messages"]


def test_resolving_returns_original_error_without_replay():
    resolving = {"status": "resolving", "issueId": "i1",
                 "explanation": {"summary": "Working on it.", "operations": []}}
    provider = ProviderStub([err400])
    heal = HealStub(lambda body: httpx.Response(200, json=resolving))
    events = []
    res = post_chat(make_client(provider, heal, on_heal=events.append))
    assert res.status_code == 400
    assert len(provider.calls) == 1, "no replay happened"
    assert events[0].heal_status == "resolving"
    assert events[0].summary == "Working on it."


def test_patched_with_an_empty_healed_body_is_not_served():
    empty = {"status": "patched", "issueId": "i1", "healedBody": {}}
    provider = ProviderStub([err400])
    heal = HealStub(lambda body: httpx.Response(200, json=empty))
    res = post_chat(make_client(provider, heal))
    assert res.status_code == 400
    assert len(provider.calls) == 1


def test_heal_api_down_fails_open_with_original_error():
    def down(body):
        raise RuntimeError("down")
    provider = ProviderStub([err400])
    heal = HealStub(down)
    events = []
    res = post_chat(make_client(provider, heal, on_heal=events.append))
    assert res.status_code == 400
    assert events[0].heal_status == "heal_unreachable"


def test_heal_api_5xx_fails_open_with_original_error():
    provider = ProviderStub([err400])
    heal = HealStub(lambda body: httpx.Response(500, text="oops"))
    res = post_chat(make_client(provider, heal))
    assert res.status_code == 400


def test_replay_failure_returns_original_error_and_reports_failed_outcome():
    provider = ProviderStub([err400, (400, {"error": {"message": "still bad"}})])
    heal = HealStub()
    res = post_chat(make_client(provider, heal))
    assert res.status_code == 400
    assert "Unsupported value" in res.json()["error"]["message"]

    patches = heal.wait_for_patch()
    assert patches[0]["body"]["retryStatusCode"] == 400
    assert patches[0]["body"]["error"]["message"] == "still bad"


def test_no_autofix_url_uses_the_hosted_endpoint(monkeypatch):
    monkeypatch.delenv("AUTOFIX_URL", raising=False)
    no_patch = {"status": "no_patch", "issueId": "i1"}
    provider = ProviderStub([err400])
    heal = HealStub(lambda body: httpx.Response(200, json=no_patch))
    post_chat(make_client(provider, heal))
    assert heal.calls[0]["url"] == "https://autofix.manifest.build/api/heal"


def test_async_success_and_non_healable_statuses_pass_through():
    """The async twin of the sync gate: the wrapper wakes for 400/404/422 and
    for nothing else."""
    for status in (200, 401, 429, 500):
        provider = ProviderStub([(status, {})])
        heal = HealStub()
        res = run_async_post(provider, heal)
        assert res.status_code == status
        assert heal.calls == [], f"{status} should not reach the heal API"


def test_async_transport_heals_end_to_end():
    provider = ProviderStub([err400, ok200])
    heal = HealStub()
    events = []

    async def main():
        transport = AsyncAutofixTransport(openai_detect, inner=provider.async_transport(),
                                          heal_client=heal.async_client(),
                                          on_heal=events.append)
        async with httpx.AsyncClient(transport=transport) as client:
            res = await client.post(OPENAI, content=json.dumps(CHAT_BODY),
                                    headers={"content-type": "application/json"})
            await asyncio.sleep(0.05)  # let the fire-and-forget outcome task run
            return res

    res = asyncio.run(main())
    assert res.status_code == 200
    assert provider.calls[1]["body"]["messages"] == CHAT_BODY["messages"]
    assert len(heal.heal_posts()) == 1
    assert events[0].heal_status == "unverified" and events[0].replay_status_code == 200
    assert heal.patches(), "outcome reported"


def test_responses_dialect_heals_text_format_type_without_ever_seeing_the_schema():
    """The shape of the structured output is a setting and heals like one; the
    schema inside it is the caller's data model and never leaves the process."""
    healed = {"status": "patched", "issueId": "i1",
              "healedBody": {"model": "gpt-5-mini", "temperature": 1,
                             "text": {"format": {"type": "json_object"}}}}
    provider = ProviderStub([err400, ok200])
    heal = HealStub(lambda body: httpx.Response(200, json=healed))
    client = make_client(provider, heal)
    res = client.post(RESPONSES, content=json.dumps({
        "model": "gpt-5-mini", "temperature": 0.2,
        "input": "SECRET_INPUT", "instructions": "SECRET_INSTRUCTIONS",
        "text": {"format": {"type": "json_schema", "schema": {"name": "SECRET_SCHEMA"}}},
    }), headers={"content-type": "application/json"})
    assert res.status_code == 200

    payload = heal.calls[0]["body"]
    req = payload["request"]
    assert "SECRET" not in json.dumps(payload), "nothing SECRET on the wire"
    assert "input" not in req, "input stripped from the heal payload"
    assert "instructions" not in req, "instructions stripped from the heal payload"
    assert req["text"] == {"format": {"type": "json_schema"}}, "the shape, not the schema"
    assert payload["api"] == "responses"

    replay = provider.calls[1]
    assert replay["body"]["input"] == "SECRET_INPUT", "replay keeps original input"
    assert replay["body"]["instructions"] == "SECRET_INSTRUCTIONS", "replay keeps instructions"
    assert replay["body"]["text"] == {
        "format": {"type": "json_object", "schema": {"name": "SECRET_SCHEMA"}}
    }, "the healed shape, over a schema the heal API never saw"


def test_heal_call_carries_its_own_timeout_budget():
    provider = ProviderStub([err400])
    heal = HealStub()
    post_chat(make_client(provider, heal, heal_timeout_ms=250))
    assert heal.calls[0]["timeout"] == 0.25, "the caller is not left waiting on the heal API"


def test_the_heal_budget_is_its_own_and_not_the_callers():
    """The caller's 600s read timeout must not become the heal API's."""
    provider = ProviderStub([err400])
    heal = HealStub()
    with autofix(inner=provider.transport(), heal_client=heal.client()) as client:
        assert client.timeout.read == 600.0, "the SDK's own default, untouched"
        post_chat(client)
    assert heal.calls[0]["timeout"] == 5.0, "the default heal budget, not the caller's"


class HangingHealTransport(httpx.BaseTransport):
    """A heal API that never answers. Hangs for exactly the budget it was given
    and then fails the way httpx itself fails, so the wall clock below is
    measuring the budget and not the stub."""

    def __init__(self):
        self.waited = None

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        budget = request.extensions.get("timeout", {}).get("read")
        assert budget is not None, "a heal call with no deadline would hang forever"
        self.waited = budget
        time.sleep(budget)
        raise httpx.ReadTimeout("timed out", request=request)


def test_a_hung_heal_api_gives_up_on_its_budget_instead_of_stalling_the_caller():
    hanging = HangingHealTransport()
    provider = ProviderStub([err400])
    events = []
    transport = AutofixTransport(openai_detect, inner=provider.transport(),
                                 heal_client=httpx.Client(transport=hanging),
                                 heal_timeout_ms=50, on_heal=events.append)
    started = time.monotonic()
    res = post_chat(httpx.Client(transport=transport))
    elapsed = time.monotonic() - started

    assert res.status_code == 400, "the caller gets its own error, not a hang"
    assert hanging.waited == 0.05, "and it waited the budget it was given"
    assert elapsed < 2.0, "it gave up on the budget, not on the stub"
    assert len(provider.calls) == 1, "no replay happened"
    assert events[0].heal_status == "heal_unreachable"


def test_an_async_hung_heal_api_gives_up_on_its_budget_too():
    class AsyncHanging(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            budget = request.extensions.get("timeout", {}).get("read")
            assert budget is not None, "a heal call with no deadline would hang forever"
            await asyncio.sleep(budget)
            raise httpx.ReadTimeout("timed out", request=request)

    provider = ProviderStub([err400])
    events = []

    async def main():
        transport = AsyncAutofixTransport(
            openai_detect, inner=provider.async_transport(),
            heal_client=httpx.AsyncClient(transport=AsyncHanging()),
            heal_timeout_ms=50, on_heal=events.append)
        async with httpx.AsyncClient(transport=transport) as client:
            return await client.post(OPENAI, content=json.dumps(CHAT_BODY),
                                     headers={"content-type": "application/json"})

    res = asyncio.run(main())
    assert res.status_code == 400, "the caller gets its own error, not a hang"
    assert len(provider.calls) == 1, "no replay happened"
    assert events[0].heal_status == "heal_unreachable"


def test_the_replay_carries_the_callers_own_timeout():
    """A hand-built request without `extensions` has no deadline at all, so a
    hung replay would hang the app forever."""
    provider = ProviderStub([err400, ok200])
    assert post_chat(make_client(provider, HealStub())).status_code == 200

    original, replay = provider.calls[0]["extensions"], provider.calls[1]["extensions"]
    assert replay["timeout"] == original["timeout"], "a replay without a deadline never ends"
    assert replay["timeout"]["read"] is not None


def test_the_async_replay_carries_the_callers_own_timeout():
    provider = ProviderStub([err400, ok200])
    assert run_async_post(provider, HealStub()).status_code == 200
    assert provider.calls[1]["extensions"]["timeout"] == provider.calls[0]["extensions"]["timeout"]


# --- the heal answer is untrusted input --------------------------------------


@pytest.mark.parametrize("body", [None, "patched", [{"status": "patched"}], 42])
def test_a_heal_answer_that_is_not_an_object_fails_open(body):
    """A 200 can still carry null, a string or a list: a proxy, a cache, a bad
    deploy. None of them may become an AttributeError in the caller's stack."""
    provider = ProviderStub([err400])
    heal = HealStub(lambda _body, b=body: httpx.Response(200, json=b))
    events = []
    res = post_chat(make_client(provider, heal, on_heal=events.append))
    assert res.status_code == 400, f"{body!r} was treated as a heal"
    assert len(provider.calls) == 1, "no replay happened"
    assert events[0].heal_status == "heal_unreachable"


def test_a_heal_answer_that_is_not_json_at_all_fails_open():
    provider = ProviderStub([err400])
    heal = HealStub(lambda body: httpx.Response(200, text="<html>captive portal</html>"))
    events = []
    res = post_chat(make_client(provider, heal, on_heal=events.append))
    assert res.status_code == 400
    assert events[0].heal_status == "heal_unreachable"


def test_an_async_heal_answer_that_is_not_an_object_fails_open():
    provider = ProviderStub([err400])
    events = []
    res = run_async_post(provider, HealStub(lambda body: httpx.Response(200, json=None)),
                         on_heal=events.append)
    assert res.status_code == 400
    assert len(provider.calls) == 1, "no replay happened"
    assert events[0].heal_status == "heal_unreachable"


def test_a_heal_with_no_status_at_all_is_not_served():
    nameless = {"issueId": "i1", "healedBody": {"model": "gpt-5-mini", "temperature": 1}}
    provider = ProviderStub([err400])
    heal = HealStub(lambda body: httpx.Response(200, json=nameless))
    events = []
    res = post_chat(make_client(provider, heal, on_heal=events.append))
    assert res.status_code == 400
    assert len(provider.calls) == 1, "no replay happened"
    assert events[0].heal_status == "no_patch", "nothing said, nothing served"


def test_patched_with_no_healed_body_at_all_is_not_served():
    provider = ProviderStub([err400])
    heal = HealStub(lambda body: httpx.Response(200, json={"status": "patched", "issueId": "i1"}))
    events = []
    res = post_chat(make_client(provider, heal, on_heal=events.append))
    assert res.status_code == 400
    assert events[0].heal_status == "patched"
    assert events[0].summary is None, "no explanation, nothing to summarise"


def test_a_healed_body_that_is_not_an_object_is_not_served():
    for healed in (None, "temperature=1", [{"temperature": 1}]):
        answer = {"status": "patched", "issueId": "i1", "healedBody": healed}
        provider = ProviderStub([err400])
        heal = HealStub(lambda body, a=answer: httpx.Response(200, json=a))
        assert post_chat(make_client(provider, heal)).status_code == 400
        assert len(provider.calls) == 1, f"{healed!r} was replayed"


def test_async_no_patch_returns_the_original_error_without_replay():
    no_patch = {"status": "no_patch", "issueId": "i1",
                "explanation": {"summary": "Nothing to fix.", "operations": []}}
    provider = ProviderStub([err400])
    events = []
    res = run_async_post(provider, HealStub(lambda body: httpx.Response(200, json=no_patch)),
                         on_heal=events.append)
    assert res.status_code == 400
    assert len(provider.calls) == 1, "no replay happened"
    assert events[0].heal_status == "no_patch"
    assert events[0].summary == "Nothing to fix."


def test_async_patched_with_an_empty_healed_body_is_not_served():
    empty = {"status": "patched", "issueId": "i1", "healedBody": {}}
    provider = ProviderStub([err400])
    res = run_async_post(provider, HealStub(lambda body: httpx.Response(200, json=empty)))
    assert res.status_code == 400
    assert len(provider.calls) == 1


def test_async_heal_api_5xx_fails_open_with_original_error():
    provider = ProviderStub([err400])
    res = run_async_post(provider, HealStub(lambda body: httpx.Response(500, text="oops")))
    assert res.status_code == 400


def test_async_heal_api_down_fails_open_with_original_error():
    def down(body):
        raise RuntimeError("down")

    provider = ProviderStub([err400])
    events = []
    res = run_async_post(provider, HealStub(down), on_heal=events.append)
    assert res.status_code == 400
    assert len(provider.calls) == 1, "no replay happened"
    assert events[0].heal_status == "heal_unreachable"


# --- the caller owns the transport fields ------------------------------------


def test_the_caller_keeps_streaming_when_the_heal_drops_it():
    dropped = {"status": "patched", "issueId": "i1",
               "healedBody": {"model": "gpt-5-mini", "temperature": 1}}  # stream gone
    provider = ProviderStub([err400, ok200])
    heal = HealStub(lambda body: httpx.Response(200, json=dropped))
    streaming = dict(CHAT_BODY, stream=True, stream_options={"include_usage": True})
    post_chat(make_client(provider, heal), body=streaming)

    replay = provider.calls[1]["body"]
    assert replay["stream"] is True, "the SDK is already committed to parsing SSE"
    assert replay["stream_options"] == {"include_usage": True}


def test_a_heal_cannot_start_a_stream_the_caller_never_asked_for():
    added = {"status": "patched", "issueId": "i1",
             "healedBody": {"model": "gpt-5-mini", "stream": True,
                            "stream_options": {"include_usage": True}}}
    provider = ProviderStub([err400, ok200])
    heal = HealStub(lambda body: httpx.Response(200, json=added))
    post_chat(make_client(provider, heal))

    replay = provider.calls[1]["body"]
    assert "stream" not in replay, "the caller asked for one object"
    assert "stream_options" not in replay


# --- the replay, and what it costs the caller --------------------------------


def test_a_successful_replay_body_is_never_read_out_from_under_the_caller():
    """_read_error leaves a successful replay untouched: reading it for the
    outcome report would consume the body the caller is about to read."""
    provider = ProviderStub([err400, ok200])
    heal = HealStub()
    res = post_chat(make_client(provider, heal))
    assert res.status_code == 200
    assert res.json() == {"ok": True}, "the body is whole and the caller gets all of it"

    patches = heal.wait_for_patch()
    assert patches[0]["body"]["retryStatusCode"] == 200, "the outcome is still reported"
    assert "error" not in patches[0]["body"], "a success has no error to report"


def test_a_replay_the_transport_cannot_send_returns_the_original_error():
    provider = ProviderStub([err400, httpx.ConnectError("connection reset")])
    heal = HealStub()
    events = []
    res = post_chat(make_client(provider, heal, on_heal=events.append))
    assert res.status_code == 400
    assert "Unsupported value" in res.json()["error"]["message"]
    assert len(provider.calls) == 2, "the replay was attempted exactly once"
    assert heal.patches() == [], "no outcome to report"
    assert events[0].heal_status == "replay_failed"
    assert events[0].replay_status_code is None, "there was no reply to report"


def test_an_async_replay_the_transport_cannot_send_returns_the_original_error():
    provider = ProviderStub([err400, httpx.ConnectError("connection reset")])
    heal = HealStub()
    events = []
    res = run_async_post(provider, heal, on_heal=events.append)
    assert res.status_code == 400
    assert "Unsupported value" in res.json()["error"]["message"]
    assert len(provider.calls) == 2, "the replay was attempted exactly once"
    assert heal.patches() == [], "no outcome to report"
    assert events[0].heal_status == "replay_failed"


def test_a_failed_replay_with_no_readable_error_still_reports_the_outcome():
    provider = ProviderStub([err400, (400, "<html>bad gateway</html>")])
    heal = HealStub()
    res = post_chat(make_client(provider, heal))
    assert res.status_code == 400
    assert "Unsupported value" in res.json()["error"]["message"], "the caller's own error"

    patches = heal.wait_for_patch()
    assert patches[0]["body"]["retryStatusCode"] == 400
    assert "error" not in patches[0]["body"], "a weak outcome beats no outcome"


def test_an_async_failed_replay_with_no_readable_error_still_reports_the_outcome():
    provider = ProviderStub([err400, (400, "<html>bad gateway</html>")])
    heal = HealStub()
    res = run_async_post(provider, heal)
    assert res.status_code == 400
    patches = heal.patches()
    assert patches[0]["body"]["retryStatusCode"] == 400
    assert "error" not in patches[0]["body"], "a weak outcome beats no outcome"


def test_an_async_replay_failure_returns_original_error_and_reports_the_outcome():
    provider = ProviderStub([err400, (400, {"error": {"message": "still bad"}})])
    heal = HealStub()
    res = run_async_post(provider, heal)
    assert res.status_code == 400
    assert "Unsupported value" in res.json()["error"]["message"]
    assert heal.patches()[0]["body"]["error"]["message"] == "still bad"


def test_a_failed_replay_we_cannot_even_close_is_still_reported():
    failed = uncloseable(httpx.Response(400, json={"error": {"message": "still bad"}}))
    provider = ProviderStub([err400, failed])
    heal = HealStub()
    res = post_chat(make_client(provider, heal))
    assert res.status_code == 400
    assert "Unsupported value" in res.json()["error"]["message"], "the caller's own error"

    patches = heal.wait_for_patch()
    assert patches[0]["body"]["error"]["message"] == "still bad", "the evidence still lands"


def test_an_async_failed_replay_we_cannot_even_close_is_still_reported():
    failed = async_uncloseable(httpx.Response(400, json={"error": {"message": "still bad"}}))
    provider = ProviderStub([err400, failed])
    heal = HealStub()
    res = run_async_post(provider, heal)
    assert res.status_code == 400
    assert heal.patches()[0]["body"]["error"]["message"] == "still bad", "the evidence lands"


def test_a_heal_with_no_attempt_id_is_served_without_an_outcome_report():
    anonymous = {"status": "patched", "issueId": "i1",
                 "healedBody": {"model": "gpt-5-mini", "temperature": 1}}
    provider = ProviderStub([err400, ok200])
    heal = HealStub(lambda body: httpx.Response(200, json=anonymous))
    events = []
    res = post_chat(make_client(provider, heal, on_heal=events.append))
    assert res.status_code == 200, "the caller still gets the healed response"

    time.sleep(0.05)  # a fire-and-forget report would have landed by now
    assert heal.patches() == [], "no attempt id, nothing to report against"
    assert events[0].replay_status_code == 200
    assert events[0].operations is None


def test_an_outcome_report_that_fails_never_reaches_the_caller():
    provider = ProviderStub([err400, ok200])
    heal = HealStub(down_on_outcome)
    crashes = []
    real_hook = threading.excepthook
    threading.excepthook = crashes.append  # the reporting thread is the only one running
    try:
        res = post_chat(make_client(provider, heal))
        assert heal.wait_for_patch(), "the outcome was attempted"
        time.sleep(0.05)  # a thread dying on it would land here
    finally:
        threading.excepthook = real_hook

    assert res.status_code == 200
    assert res.json() == {"ok": True}, "the healed response is intact"
    assert crashes == [], "the failure escaped the reporting thread"


def test_an_async_outcome_report_that_fails_never_reaches_the_caller():
    provider = ProviderStub([err400, ok200])
    heal = HealStub(down_on_outcome)
    crashes = []

    async def main():
        asyncio.get_running_loop().set_exception_handler(lambda loop, ctx: crashes.append(ctx))
        async with make_async_client(provider, heal) as client:
            res = await client.post(OPENAI, content=json.dumps(CHAT_BODY),
                                    headers={"content-type": "application/json"})
            await asyncio.sleep(0.05)  # the outcome task runs and is dropped here
        gc.collect()                   # a task that died on it would be reported here
        return res

    res = asyncio.run(main())
    assert res.status_code == 200
    assert heal.patches(), "the outcome was attempted"
    assert res.json() == {"ok": True}, "the healed response is intact"
    assert crashes == [], "the failure escaped the reporting task"


# --- the hook is for watching, never for deciding ----------------------------


def test_a_hook_that_throws_is_not_allowed_to_become_an_outage():
    def hostile(event):
        raise RuntimeError("the observability hook is buggy")

    provider = ProviderStub([err400, ok200])
    heal = HealStub()
    res = post_chat(make_client(provider, heal, on_heal=hostile))
    assert res.status_code == 200, "the caller still gets its healed response"
    assert provider.calls[1]["body"]["temperature"] == 1
    assert res.json() == {"ok": True}


def test_a_hook_that_throws_on_the_fail_open_paths_is_swallowed_too():
    """Every emit goes through the same guard, but a hook only ever sees the
    path it was on: prove the two that hand back the caller's own error."""
    def hostile(event):
        raise RuntimeError("the observability hook is buggy")

    def down(body):
        raise RuntimeError("down")

    unreachable = ProviderStub([err400])
    assert post_chat(make_client(unreachable, HealStub(down), on_heal=hostile)).status_code == 400

    failed = ProviderStub([err400, httpx.ConnectError("connection reset")])
    assert post_chat(make_client(failed, HealStub(), on_heal=hostile)).status_code == 400


def test_an_async_hook_that_throws_is_not_allowed_to_become_an_outage():
    def hostile(event):
        raise RuntimeError("the observability hook is buggy")

    provider = ProviderStub([err400, ok200])
    res = run_async_post(provider, HealStub(), on_heal=hostile)
    assert res.status_code == 200, "the caller still gets its healed response"


# --- the gate: what the transport refuses to touch ---------------------------


def test_in_scope_short_circuits_before_the_response_body_is_read():
    """A failure on a path we were never going to touch must not cost a read."""
    watched = WatchedStream(json.dumps(ERR_400).encode())
    provider = ProviderStub([httpx.Response(400, stream=watched)])
    heal = HealStub()
    transport = AutofixTransport(openai_detect, inner=provider.transport(),
                                 heal_client=heal.client())
    res = transport.handle_request(
        httpx.Request("GET", OPENAI, content=json.dumps(CHAT_BODY)))
    assert res.status_code == 400
    assert watched.reads == 0, "a GET never gets as far as the body"
    assert heal.calls == []

    # ...and the same body on a POST does get read, so the counter is real.
    watched2 = WatchedStream(json.dumps(ERR_400).encode())
    provider2 = ProviderStub([httpx.Response(400, stream=watched2)])
    transport2 = AutofixTransport(openai_detect, inner=provider2.transport(),
                                  heal_client=HealStub().client())
    transport2.handle_request(httpx.Request("POST", OPENAI, content=json.dumps(CHAT_BODY)))
    assert watched2.reads == 1, "an on-route POST is read exactly once"


def test_an_off_route_path_short_circuits_before_the_response_body_is_read():
    watched = WatchedStream(json.dumps(ERR_400).encode())
    provider = ProviderStub([httpx.Response(400, stream=watched)])
    heal = HealStub()
    transport = AutofixTransport(openai_detect, inner=provider.transport(),
                                 heal_client=heal.client())
    res = transport.handle_request(httpx.Request(
        "POST", "https://api.openai.com/v1/embeddings", content=json.dumps(CHAT_BODY)))
    assert res.status_code == 400
    assert watched.reads == 0, "an off-route path never gets as far as the body"


@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE", "PATCH"])
def test_only_posts_are_healable_everything_else_passes_through(method):
    provider = ProviderStub([err400])
    heal = HealStub()
    res = make_client(provider, heal).request(  # a JSON body the gate would otherwise like
        method, OPENAI, content=json.dumps(CHAT_BODY),
        headers={"content-type": "application/json"})
    assert res.status_code == 400
    assert heal.calls == [], f"a {method} is never a request the transport may reshape"


def test_a_lowercase_method_is_still_a_post():
    provider = ProviderStub([err400, ok200])
    heal = HealStub()
    transport = AutofixTransport(openai_detect, inner=provider.transport(),
                                 heal_client=heal.client())
    res = transport.handle_request(httpx.Request(
        "post", OPENAI, content=json.dumps(CHAT_BODY),
        headers={"content-type": "application/json"}))
    assert res.status_code == 200, "the SDK decides the casing, not us"


@pytest.mark.parametrize("body", [b"model=gpt-5-mini", b"[1, 2, 3]", b'"gpt-5-mini"',
                                  b"null", b"42", b""])
def test_a_request_body_the_gate_cannot_read_is_left_alone(body):
    provider = ProviderStub([err400])
    heal = HealStub()
    res = make_client(provider, heal).post(
        OPENAI, content=body, headers={"content-type": "application/json"})
    assert res.status_code == 400
    assert heal.calls == [], f"{body!r} reached the heal API"


def test_an_error_body_the_gate_cannot_read_is_left_alone_unread():
    for body in ("<html>502 Bad Gateway</html>", "null", "{}", '{"error": {}}',
                 '{"error": "a string"}', '{"error": {"message": ""}}'):
        provider = ProviderStub([(400, body)])
        heal = HealStub()
        res = post_chat(make_client(provider, heal))
        assert res.status_code == 400
        assert res.text == body, "the caller still gets to read its own body"
        assert heal.calls == [], f"{body} reached the heal API"


def test_an_async_error_body_the_gate_cannot_read_is_left_alone():
    provider = ProviderStub([(400, "<html>502 Bad Gateway</html>")])
    heal = HealStub()
    res = run_async_post(provider, heal)
    assert res.status_code == 400
    assert res.text == "<html>502 Bad Gateway</html>", "the caller keeps its own body"
    assert heal.calls == []


def test_a_response_body_that_cannot_be_read_is_never_healed():
    # Driven through the transport itself: the caller's own read of a dead body
    # is the caller's business, and this is about what we do before that.
    provider = ProviderStub([httpx.Response(400, stream=ExplodingStream())])
    heal = HealStub()
    transport = AutofixTransport(openai_detect, inner=provider.transport(),
                                 heal_client=heal.client())
    res = transport.handle_request(httpx.Request("POST", OPENAI, content=json.dumps(CHAT_BODY)))
    assert res.status_code == 400, "the caller keeps its own response"
    assert heal.calls == [], "a body we cannot read is a body we cannot heal"


def test_an_async_response_body_that_cannot_be_read_is_never_healed():
    provider = ProviderStub([httpx.Response(400, stream=AsyncExplodingStream())])
    heal = HealStub()

    async def main():
        transport = AsyncAutofixTransport(openai_detect, inner=provider.async_transport(),
                                          heal_client=heal.async_client())
        return await transport.handle_async_request(
            httpx.Request("POST", OPENAI, content=json.dumps(CHAT_BODY)))

    res = asyncio.run(main())
    assert res.status_code == 400, "the caller keeps its own response"
    assert heal.calls == [], "a body we cannot read is a body we cannot heal"


def test_an_async_off_route_path_stays_inert():
    provider = ProviderStub([err400])
    heal = HealStub()
    res = run_async_post(provider, heal, url="https://api.openai.com/v1/embeddings")
    assert res.status_code == 400
    assert heal.calls == [], "in_scope answers the same on either shell"


def test_an_async_non_post_stays_inert():
    provider = ProviderStub([err400])
    heal = HealStub()

    async def main():
        async with make_async_client(provider, heal) as client:
            return await client.request("GET", OPENAI, content=json.dumps(CHAT_BODY),
                                        headers={"content-type": "application/json"})

    assert asyncio.run(main()).status_code == 400
    assert heal.calls == []


def test_open_gate_re_checks_the_route_it_is_handed():
    """in_scope is an optimisation in front of open_gate, not the only thing
    between a caller and a heal: open_gate decides for itself too."""
    healable = httpx.Response(400, json=ERR_400)
    healable.read()
    for request in (httpx.Request("GET", OPENAI, content=json.dumps(CHAT_BODY)),
                    httpx.Request("POST", "https://api.openai.com/v1/embeddings",
                                  content=json.dumps(CHAT_BODY))):
        assert open_gate(openai_detect, request, healable) is None


@pytest.mark.parametrize("status", [400, 404, 422])
def test_every_healable_status_is_healed(status):
    provider = ProviderStub([(status, {"error": {"message": "nope"}}), ok200])
    assert post_chat(make_client(provider, HealStub())).status_code == 200


@pytest.mark.parametrize("status", [403, 409, 502])
def test_the_sdks_own_retry_territory_is_left_alone(status):
    provider = ProviderStub([(status, {"error": {"message": "nope"}})])
    heal = HealStub()
    assert post_chat(make_client(provider, heal)).status_code == status
    assert heal.calls == []


# --- plumbing ----------------------------------------------------------------


def test_the_factory_returns_a_client_that_heals():
    provider = ProviderStub([err400, ok200])
    heal = HealStub()
    with autofix(inner=provider.transport(), heal_client=heal.client()) as client:
        res = post_chat(client)
        assert client.timeout.read == 600.0, "the SDK's own default timeout"
    assert res.status_code == 200
    assert provider.calls[1]["body"]["temperature"] == 1, "healed knob applied"


def test_the_async_factory_returns_a_client_that_heals():
    provider = ProviderStub([err400, ok200])
    heal = HealStub()

    async def main():
        async with autofix_async(inner=provider.async_transport(),
                                 heal_client=heal.async_client()) as client:
            assert client.timeout.read == 600.0, "the SDK's own default timeout"
            res = await client.post(OPENAI, content=json.dumps(CHAT_BODY),
                                    headers={"content-type": "application/json"})
            await asyncio.sleep(0.05)
            return res

    res = asyncio.run(main())
    assert res.status_code == 200
    assert provider.calls[1]["body"]["temperature"] == 1, "healed knob applied"


def test_an_underivable_workspace_identity_is_not_an_outage(monkeypatch):
    def no_hostname():
        raise OSError("hostname unavailable")

    monkeypatch.setattr("mnfst_autofix.core.heal_api.socket.gethostname", no_hostname)
    provider = ProviderStub([err400, ok200])
    heal = HealStub()
    res = post_chat(make_client(provider, heal))
    assert res.status_code == 200, "healing still works without an identity"
    assert heal.calls[0]["body"]["tenantId"] is None, "the payload simply carries no id"


def test_autofix_debug_logs_the_payload_it_sends_anonymized_like_the_wire(monkeypatch, capsys):
    monkeypatch.setenv("AUTOFIX_DEBUG", "1")
    provider = ProviderStub([err400, ok200])
    heal = HealStub()
    assert post_chat(make_client(provider, heal)).status_code == 200

    logged = capsys.readouterr().err
    assert "[autofix:debug] heal payload" in logged
    assert "SECRET" not in logged, "the debug log is anonymized too"


def test_a_degenerate_schema_carrier_is_never_an_outage():
    """`text: null` is legal JSON that anonymize walks into. Whether it can be
    healed is one question; whether the caller keeps its own 400 and no
    exception escapes is the guarantee, and that holds either way."""
    no_patch = {"status": "no_patch", "issueId": "i1"}
    for text in (None, "a string", 42, []):
        provider = ProviderStub([err400])
        heal = HealStub(lambda body: httpx.Response(200, json=no_patch))
        res = make_client(provider, heal).post(
            RESPONSES, content=json.dumps({"model": "gpt-5-mini", "input": "SECRET",
                                           "text": text}),
            headers={"content-type": "application/json"})
        assert res.status_code == 400, f"text: {text!r} reached the caller as a raise"
        assert len(provider.calls) == 1, "no replay happened"


def test_a_healed_body_that_is_not_a_dict_is_never_replayed():
    """A list has length, so it clears the emptiness guard. Replaying it would
    let the heal API choose the whole request body."""
    for healed in ([{"temperature": 1}], "temperature=1", 42):
        provider = ProviderStub([err400])
        heal = HealStub(lambda body, h=healed: httpx.Response(
            200, json={"status": "patched", "issueId": "i1", "healedBody": h}))
        res = post_chat(make_client(provider, heal))
        assert res.status_code == 400, f"healedBody {healed!r} was served"
        assert len(provider.calls) == 1, "no replay happened"


def test_a_schema_carrier_that_is_not_a_dict_neither_heals_nor_raises():
    """`{"text": None}` is legal JSON. Walking into it used to raise where the
    caller expects the transport to do nothing at all."""
    provider = ProviderStub([err400, ok200])
    heal = HealStub()
    client = make_client(provider, heal)
    res = client.post(RESPONSES, content=json.dumps({"model": "m", "input": "hi", "text": None}),
                      headers={"content-type": "application/json"})
    assert res.status_code in (200, 400), "a response, not a raise"
