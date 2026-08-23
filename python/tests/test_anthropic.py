"""Port of node/tests/anthropic.test.ts - the Anthropic adapter, sync + async."""

import asyncio
import json
import time

import httpx
import pytest

from mnfst_autofix.anthropic import AsyncAutofixTransport, AutofixTransport
from mnfst_autofix.anthropic import detect as anthropic_detect
from mnfst_autofix.openai import detect as openai_detect

ANTHROPIC = "https://api.anthropic.com/v1/messages"
HEAL_URL = "http://heal.test"

MESSAGES_BODY = {
    "model": "claude-opus-4-6",
    "max_tokens": 100,
    "frequency_penalty": 0.5,            # an OpenAI param, not an Anthropic one -> 400
    "system": "SECRET_SYSTEM_PROMPT",    # top-level system prompt
    "messages": [{"role": "user", "content": "SECRET"}],
    "tools": [{"name": "t", "input_schema": {"type": "object"}}],
}

# Anthropic's envelope carries NO `param` and NO `code`, unlike OpenAI.
ERR_400 = {"type": "error", "error": {
    "type": "invalid_request_error",
    "message": "frequency_penalty: Extra inputs are not permitted",
}}

# frequency_penalty is a scalar, so it travelled, so the server can speak for
# it: the healed body is the corrected parameter set, and the correction here is
# that frequency_penalty is not in it. `explanation.operations` is prose for a
# human and is never acted on.
DEFAULT_HEAL = {
    "status": "unverified", "issueId": "i1", "healAttemptId": "a1",
    "healedBody": {"model": "claude-opus-4-6", "max_tokens": 100},
    "explanation": {"summary": 'Removed the unsupported parameter "frequency_penalty".',
                    "operations": [{"type": "drop_param", "detail": "frequency_penalty"}]},
}

ok200 = (200, {"ok": True})
err400 = (400, ERR_400)


@pytest.fixture(autouse=True)
def heal_env(monkeypatch):
    monkeypatch.setenv("AUTOFIX_URL", HEAL_URL)


class ProviderStub:
    def __init__(self, script):
        self.script = script
        self.calls = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        try:
            body = json.loads(request.content)
        except Exception:
            body = None  # bodies the transport must not touch reach the provider too
        self.calls.append({"body": body, "headers": dict(request.headers),
                           "extensions": request.extensions})
        entry = self.script[min(len(self.calls) - 1, len(self.script) - 1)]
        if isinstance(entry, Exception):
            raise entry
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
        self.calls.append({"url": str(request.url), "method": request.method, "body": body})
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
        """Outcome reports are fire-and-forget (background thread) - poll."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.patches():
                return self.patches()
            time.sleep(0.01)
        return self.patches()


def make_client(provider, heal, detect=anthropic_detect, **options):
    return httpx.Client(transport=AutofixTransport(
        detect, inner=provider.transport(), heal_client=heal.client(), **options))


def post_messages(client, url=ANTHROPIC, body=MESSAGES_BODY):
    return client.post(url, content=json.dumps(body),
                       headers={"x-api-key": "sk-ant-secret",
                                "anthropic-version": "2023-06-01",
                                "content-type": "application/json"})


def test_heals_messages_strips_content_and_system_replays_keeps_key():
    provider = ProviderStub([err400, ok200])
    heal = HealStub()
    events = []
    res = post_messages(make_client(provider, heal, on_heal=events.append))
    assert res.status_code == 200

    payload = heal.calls[0]["body"]
    wire = json.dumps(payload)
    assert "SECRET" not in wire, "no message content or system prompt on the wire"
    assert "input_schema" not in wire, "tool schemas never leave"
    sent = payload["request"]
    assert "system" not in sent, "system prompt stripped"
    assert "messages" not in sent
    assert "tools" not in sent
    assert sent["max_tokens"] == 100, "settings do travel - that is the whole point"
    assert sent["frequency_penalty"] == 0.5, \
        "the param that caused the 400 travels too, though no list ever named it"
    assert payload["provider"] == "anthropic"
    assert payload["api"] == "messages"

    replay = provider.calls[1]
    assert "frequency_penalty" not in replay["body"], \
        "the healed body simply left it out, and omission is how a param is dropped"
    assert replay["body"]["system"] == "SECRET_SYSTEM_PROMPT", "system restored on replay"
    assert replay["body"]["messages"] == MESSAGES_BODY["messages"], "messages restored"
    assert replay["body"]["tools"] == MESSAGES_BODY["tools"], "tools restored"
    assert replay["headers"]["x-api-key"] == "sk-ant-secret", "key stays on its path"

    assert events[0].heal_status == "unverified"
    assert events[0].replay_status_code == 200
    assert events[0].operations == [{"type": "drop_param", "detail": "frequency_penalty"}], \
        "the server's prose reaches the hook - it is the only account of what changed"


def test_adapters_route_by_path_so_they_do_not_overlap():
    # The anthropic adapter ignores a chat/completions path...
    p1 = ProviderStub([err400])
    h1 = HealStub()
    res1 = post_messages(make_client(p1, h1),
                         url="https://api.openai.com/v1/chat/completions")
    assert res1.status_code == 400
    assert h1.calls == []

    # ...and the openai adapter ignores a messages path.
    p2 = ProviderStub([err400])
    h2 = HealStub()
    res2 = post_messages(make_client(p2, h2, detect=openai_detect))
    assert res2.status_code == 400
    assert h2.calls == []


def test_heals_through_a_custom_base_url():
    provider = ProviderStub([err400, ok200])
    heal = HealStub()
    res = post_messages(make_client(provider, heal),
                        url="https://gw.example.com/v1/messages")
    assert res.status_code == 200, "healed and replayed"
    assert heal.calls[0]["body"]["provider"] == "anthropic"
    assert "frequency_penalty" not in provider.calls[1]["body"]


def test_non_messages_anthropic_paths_stay_inert():
    provider = ProviderStub([err400])
    heal = HealStub()
    client = make_client(provider, heal)
    res = post_messages(client, url="https://api.anthropic.com/v1/complete")
    assert res.status_code == 400
    assert heal.calls == []


def test_bodies_without_a_model_stay_inert_on_the_messages_route():
    """Port of node/tests/index.test.ts. `model` is the only key that identifies
    this dialect; OpenAI's Assistants API posts {role, content} to
    /threads/{id}/messages, which ends in this dialect's tail but is none of our
    business."""
    assistants_body = {"role": "user", "content": "MY PRIVATE PROMPT",
                       "attachments": [{"file_id": "file-1"}]}
    inert = [("the Assistants message body", "https://api.openai.com/v1/threads/t1/messages",
              assistants_body),
             ("a messages body with no model", ANTHROPIC, {"max_tokens": 10})]
    for what, url, body in inert:
        provider = ProviderStub([err400])
        heal = HealStub()
        res = make_client(provider, heal).post(
            url, content=json.dumps(body), headers={"content-type": "application/json"})
        assert res.status_code == 400, what
        assert heal.calls == [], f"{what} reached the heal API"
        assert len(provider.calls) == 1, f"{what} was replayed"


def test_a_stored_prompt_reference_does_not_identify_the_messages_dialect():
    """`prompt` identifies the Responses dialect and nothing else - a key one
    dialect owns must not open the gate on another's route."""
    provider = ProviderStub([err400])
    heal = HealStub()
    res = make_client(provider, heal).post(
        ANTHROPIC, content=json.dumps({"prompt": {"id": "pmpt_abc"}, "max_tokens": 10}),
        headers={"content-type": "application/json"})
    assert res.status_code == 400
    assert heal.calls == [], "the messages dialect opened on a key it does not own"


def test_heal_api_down_fails_open():
    def down(body):
        raise RuntimeError("down")
    provider = ProviderStub([err400])
    heal = HealStub(down)
    events = []
    res = post_messages(make_client(provider, heal, on_heal=events.append))
    assert res.status_code == 400
    assert len(provider.calls) == 1, "no replay happened"
    assert events[0].heal_status == "heal_unreachable"


def test_async_transport_heals_messages_end_to_end():
    provider = ProviderStub([err400, ok200])
    heal = HealStub()
    events = []

    async def main():
        transport = AsyncAutofixTransport(anthropic_detect, inner=provider.async_transport(),
                                          heal_client=heal.async_client(),
                                          on_heal=events.append)
        async with httpx.AsyncClient(transport=transport) as client:
            res = await client.post(ANTHROPIC, content=json.dumps(MESSAGES_BODY),
                                    headers={"content-type": "application/json"})
            await asyncio.sleep(0.05)  # let the fire-and-forget outcome task run
            return res

    res = asyncio.run(main())
    assert res.status_code == 200
    assert provider.calls[1]["body"]["system"] == "SECRET_SYSTEM_PROMPT"
    assert len(heal.heal_posts()) == 1
    assert events[0].heal_status == "unverified"


# --- the shared engine, seen from the /v1/messages route ---------------------
# These guarantees live in core/engine.py and core/attempt.py, not in either
# route table. They are asserted again here because "it works on OpenAI" is not
# evidence that the adapter a caller actually installed gets them.


def test_a_hung_heal_api_gives_up_on_its_budget_on_the_messages_route():
    class Hanging(httpx.BaseTransport):
        def handle_request(self, request):
            budget = request.extensions.get("timeout", {}).get("read")
            assert budget is not None, "a heal call with no deadline would hang forever"
            time.sleep(budget)
            raise httpx.ReadTimeout("timed out", request=request)

    provider = ProviderStub([err400])
    events = []
    transport = AutofixTransport(anthropic_detect, inner=provider.transport(),
                                 heal_client=httpx.Client(transport=Hanging()),
                                 heal_timeout_ms=50, on_heal=events.append)
    started = time.monotonic()
    res = post_messages(httpx.Client(transport=transport))

    assert res.status_code == 400, "the caller gets its own error, not a hang"
    assert time.monotonic() - started < 2.0, "it gave up on the budget"
    assert len(provider.calls) == 1, "no replay happened"
    assert events[0].heal_status == "heal_unreachable"


@pytest.mark.parametrize("body", [None, "patched", [{"status": "patched"}]])
def test_a_heal_answer_that_is_not_an_object_fails_open(body):
    provider = ProviderStub([err400])
    heal = HealStub(lambda _b, b=body: httpx.Response(200, json=b))
    events = []
    res = post_messages(make_client(provider, heal, on_heal=events.append))
    assert res.status_code == 400, f"{body!r} was treated as a heal"
    assert len(provider.calls) == 1, "no replay happened"
    assert events[0].heal_status == "heal_unreachable"


def test_a_hook_that_throws_is_not_allowed_to_become_an_outage():
    def hostile(event):
        raise RuntimeError("the observability hook is buggy")

    provider = ProviderStub([err400, ok200])
    res = post_messages(make_client(provider, HealStub(), on_heal=hostile))
    assert res.status_code == 200, "the caller still gets its healed response"
    assert "frequency_penalty" not in provider.calls[1]["body"]


def test_a_replay_the_transport_cannot_send_returns_the_original_error():
    provider = ProviderStub([err400, httpx.ConnectError("connection reset")])
    heal = HealStub()
    events = []
    res = post_messages(make_client(provider, heal, on_heal=events.append))
    assert res.status_code == 400
    assert "Extra inputs are not permitted" in res.json()["error"]["message"]
    assert len(provider.calls) == 2, "the replay was attempted exactly once"
    assert heal.patches() == [], "no outcome to report"
    assert events[0].heal_status == "replay_failed"


def test_the_caller_keeps_streaming_when_the_heal_drops_it():
    provider = ProviderStub([err400, ok200])  # DEFAULT_HEAL carries no `stream`
    post_messages(make_client(provider, HealStub()),
                  body=dict(MESSAGES_BODY, stream=True))
    assert provider.calls[1]["body"]["stream"] is True, "the SDK is committed to parsing SSE"


def test_a_heal_cannot_start_a_stream_the_caller_never_asked_for():
    added = {"status": "patched", "issueId": "i1",
             "healedBody": {"model": "claude-opus-4-6", "max_tokens": 100, "stream": True}}
    provider = ProviderStub([err400, ok200])
    heal = HealStub(lambda body: httpx.Response(200, json=added))
    post_messages(make_client(provider, heal))
    assert "stream" not in provider.calls[1]["body"], "the caller asked for one object"


# Omission is a deletion only for what the caller disclosed. A heal that says
# nothing about the prompt is a heal that never saw it - and a prompt-less
# request is the one edit that could be worse than not healing at all: the
# provider may still answer it with a 200, billed to a caller who asked nothing.
def test_a_heal_cannot_drop_the_prompt_or_the_tools_out_of_the_replay():
    provider = ProviderStub([err400, ok200])
    post_messages(make_client(provider, HealStub()))

    replay = provider.calls[1]["body"]
    assert replay["messages"] == MESSAGES_BODY["messages"]
    assert replay["system"] == "SECRET_SYSTEM_PROMPT"
    assert replay["tools"] == MESSAGES_BODY["tools"]
    assert replay["model"] == "claude-opus-4-6"
    assert "frequency_penalty" not in replay, "the legitimate drop still happened"


def test_the_replay_carries_the_callers_own_timeout():
    provider = ProviderStub([err400, ok200])
    assert post_messages(make_client(provider, HealStub())).status_code == 200
    assert provider.calls[1]["extensions"]["timeout"] == provider.calls[0]["extensions"]["timeout"]


def test_a_successful_replay_body_is_never_read_out_from_under_the_caller():
    provider = ProviderStub([err400, ok200])
    heal = HealStub()
    res = post_messages(make_client(provider, heal))
    assert res.json() == {"ok": True}, "the caller gets the whole body"

    patches = heal.wait_for_patch()
    assert patches[0]["body"]["retryStatusCode"] == 200, "the outcome is still reported"
    assert "error" not in patches[0]["body"]


def test_a_failed_replay_hands_back_the_original_error_and_reports_its_own():
    provider = ProviderStub([err400, (400, {"type": "error",
                                            "error": {"message": "still bad"}})])
    heal = HealStub()
    res = post_messages(make_client(provider, heal))
    assert res.status_code == 400
    assert "Extra inputs are not permitted" in res.json()["error"]["message"], "the caller's own"

    patches = heal.wait_for_patch()
    assert patches[0]["body"]["retryStatusCode"] == 400
    assert patches[0]["body"]["error"]["message"] == "still bad"


def test_non_posts_and_non_object_bodies_stay_inert_on_the_messages_route():
    inert = [("a GET", "GET", json.dumps(MESSAGES_BODY)),
             ("a POST of an array", "POST", "[1, 2, 3]"),
             ("a POST of a bare string", "POST", '"claude-opus-4-6"'),
             ("a POST of something that is not JSON", "POST", "model=claude")]
    for what, method, body in inert:
        provider = ProviderStub([err400])
        heal = HealStub()
        res = make_client(provider, heal).request(
            method, ANTHROPIC, content=body, headers={"content-type": "application/json"})
        assert res.status_code == 400, what
        assert heal.calls == [], f"{what} reached the heal API"
