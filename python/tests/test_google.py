"""Native Google Gemini GenerateContent transport behavior."""

import json

import httpx

from mnfst_autofix.google import AutofixTransport, detect

HEAL_URL = "http://heal.test"
ERR_404 = (404, {"error": {
    "code": 404, "message": "models/gemini-1.0-pro is not found", "status": "NOT_FOUND",
}})
OK_200 = (200, {"candidates": []})


class ProviderStub:
    def __init__(self, script):
        self.script = script
        self.calls = []

    def handler(self, request):
        self.calls.append({"url": str(request.url), "body": json.loads(request.content)})
        status, body = self.script[min(len(self.calls) - 1, len(self.script) - 1)]
        return httpx.Response(status, json=body)

    def transport(self):
        return httpx.MockTransport(self.handler)


class HealStub:
    def __init__(self, healed_body):
        self.healed_body = healed_body
        self.calls = []

    def handler(self, request):
        body = json.loads(request.content) if request.content else None
        self.calls.append({"method": request.method, "body": body})
        return httpx.Response(200, json={
            "status": "unverified", "issueId": "i1", "healAttemptId": "a1",
            "healedBody": self.healed_body,
        })

    def client(self):
        return httpx.Client(transport=httpx.MockTransport(self.handler))


def client(provider, heal, **options):
    return httpx.Client(transport=AutofixTransport(
        detect, inner=provider.transport(), heal_client=heal.client(), **options,
    ))


def post(client_, url, body):
    return client_.post(url, content=json.dumps(body), headers={"x-goog-api-key": "secret"})


def test_heals_generate_content_and_includes_contents_when_opted_in(monkeypatch):
    monkeypatch.setenv("AUTOFIX_URL", HEAL_URL)
    provider = ProviderStub([ERR_404, OK_200])
    heal = HealStub({"model": "models/gemini-2.5-flash",
                     "generationConfig": {"temperature": 1}})
    body = {
        "contents": [{"role": "user", "parts": [{"text": "private prompt"}]}],
        "generationConfig": {"temperature": 0.2},
    }
    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.0-pro:generateContent"

    response = post(client(provider, heal, send_messages=True), url, body)

    assert response.status_code == 200
    payload = heal.calls[0]["body"]
    assert payload["provider"] == "gemini"
    assert payload["api"] == "chat_completions"
    assert payload["response"]["error"] == {
        "message": "models/gemini-1.0-pro is not found", "type": "NOT_FOUND", "code": "404",
    }
    assert payload["request"] == {"model": "gemini-1.0-pro", **body}
    exchange = payload["providerExchange"]
    assert exchange["format"] == "google_generate_content"
    assert exchange["request"]["body"] == body
    assert "redactedFields" not in exchange["request"]
    assert provider.calls[1]["url"].endswith("/models/gemini-2.5-flash:generateContent")
    assert "model" not in provider.calls[1]["body"]
    assert provider.calls[1]["body"]["contents"] == body["contents"]


def test_stream_path_redacts_content_and_preserves_query(monkeypatch):
    monkeypatch.setenv("AUTOFIX_URL", HEAL_URL)
    provider = ProviderStub([ERR_404, OK_200])
    heal = HealStub({"model": "gemini-2.5-flash", "generationConfig": {"temperature": 1}})
    body = {
        "contents": [{"role": "user", "parts": [{"text": "private prompt"}]}],
        "systemInstruction": {"parts": [{"text": "private system"}]},
        "generationConfig": {"temperature": 0.2},
    }
    url = "https://gateway.test/v1beta/models/gemini-1.0-pro:streamGenerateContent?alt=sse"

    response = post(client(provider, heal), url, body)

    assert response.status_code == 200
    payload = heal.calls[0]["body"]
    assert payload["url"].endswith("gemini-1.0-pro:streamGenerateContent")
    assert "?alt=sse" not in payload["url"]
    assert payload["providerExchange"]["request"]["redactedFields"] == [
        "contents", "systemInstruction",
    ]
    assert provider.calls[1]["url"].endswith("streamGenerateContent?alt=sse")
    assert provider.calls[1]["body"]["contents"] == body["contents"]


def test_non_google_paths_and_model_less_routes_are_safe():
    assert detect(httpx.URL("https://gateway.test/v1/messages")) is None
    url = httpx.URL("https://gateway.test/v1beta/gemini:generateContent")
    route = detect(url)
    assert route is not None
    assert route.model is None
    assert route.replay is not None
    replay_url, replay_body = route.replay(url, {"model": "gemini-2.5-flash", "contents": []})
    assert replay_url == url
    assert replay_body == {"contents": []}
