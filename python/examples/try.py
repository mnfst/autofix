# The README example, verbatim. Zero config - hosted heal API by default.
# Run:  .venv/bin/python examples/try.py   (needs OPENAI_API_KEY in the env)

from openai import OpenAI

from mnfst_autofix.openai import autofix

client = OpenAI(http_client=autofix(on_heal=print))

# Every call on this client is self-healing:
res = client.chat.completions.create(
    model="gpt-5-mini",
    temperature=0.2,  # gpt-5 models reject this - normally a 400
    messages=[{"role": "user", "content": "Say hi in five words."}],
)
print(f"✓ {res.model}: {res.choices[0].message.content}")
