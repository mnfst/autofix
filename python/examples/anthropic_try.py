# E2E smoke: Anthropic SDK + autofix + the hosted heal API.
# Run:  .venv/bin/python examples/anthropic_try.py   (needs ANTHROPIC_API_KEY)

from anthropic import Anthropic

from mnfst_autofix.anthropic import autofix

client = Anthropic(http_client=autofix(on_heal=print))

res = client.messages.create(
    model="claude-haiku-4-5-20251001",
    max_tokens=64,
    system="You are terse.",       # top-level system prompt - must never travel
    messages=[{"role": "user", "content": "Say hi in exactly five words."}],
    extra_body={"frequency_penalty": 0.5},  # not an Anthropic param -> 400
)
text = "".join(b.text for b in res.content if b.type == "text").strip()
print(f"✓ {res.model}: {text}")
