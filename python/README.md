# Autofix Python

Self-healing HTTP transport for OpenAI, Anthropic, and native Google Gemini requests. When a request fails with a fixable request-shape error — a renamed parameter, a restricted value, a retired model — autofix repairs it at runtime and retries. Your code doesn't change; your users never see the failure.

## Installation

Use one import per SDK. Routing follows the request path, including custom
`base_url` values.

```bash
pip install mnfst-autofix
```

## Usage

```python
from openai import OpenAI
from mnfst_autofix.openai import autofix

client = OpenAI(http_client=autofix())

res = client.chat.completions.create(
    model="gpt-5-mini",
    temperature=0.2,  # gpt-5 models reject this - normally a 400
    messages=[{"role": "user", "content": "Hello!"}],
)
# -> healed at runtime (temperature set to 1), returns a normal 200
```

That's the whole integration — every call on this client is self-healing.

Async works the same way:

```python
from openai import AsyncOpenAI
from mnfst_autofix.openai import autofix_async

client = AsyncOpenAI(http_client=autofix_async())
```

For Anthropic:

```python
from anthropic import Anthropic
from mnfst_autofix.anthropic import autofix

client = Anthropic(http_client=autofix())
```

For a native Google GenerateContent request:

```python
from mnfst_autofix.google import autofix

client = autofix(send_messages=True)
response = client.post(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    headers={"x-goog-api-key": "..."},
    json={"contents": [{"role": "user", "parts": [{"text": "Hello!"}]}]},
)
```

For LiteLLM:

```python
from openai import OpenAI
from mnfst_autofix.openai import autofix

client = OpenAI(
    base_url="http://localhost:4000/v1",
    http_client=autofix(),
)
```

## How it works

On a `400`, `404` or `422`, autofix applies the privacy filter described below, asks the heal API for the current fix, applies it, and replays once. Anything goes wrong → your original error, unchanged.

## Never worse than without it

- **Zero overhead on success** — the transport only wakes up on a healable failure.
- **Fail open** — heal API down, slow, or out of ideas: you get the original error. The heal call has a 5s budget, so it can't sit on top of a failure you're already waiting for.
- **Your key never leaves** — the provider API key stays on your SDK's request, on its original path.

## Privacy

The heal API receives settings, not prompt data:

```jsonc
// sent to the heal API
{
  "model": "gpt-5-mini",
  "temperature": 0.2
}

// kept local and restored on replay
{
  "messages": [{ "role": "user", "content": "Hello!" }],
  "tools": [...]
}
```

Scalar settings and scalar-only arrays may travel. Prompts, tools, nested arrays,
schema bodies, identity fields, and credential fields stay local. The provider error,
endpoint origin and path, derived workspace id, and SDK source are also sent.

`autofix(send_messages=True)` (default `False`) opts the top-level `messages` or
Gemini `contents` list in, verbatim. It is observability only: the heal API still
cannot author or rewrite the conversation on the way back.

## See heals

```python
client = OpenAI(
    http_client=autofix(
        on_heal=lambda event: print(event.heal_status, event.summary),
    ),
)
```

## License

MIT © Manifest
