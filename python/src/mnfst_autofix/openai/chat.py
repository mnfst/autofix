"""chat_completions dialect - the classic completions API."""

API = "chat_completions"

# `model` is required on every chat completion, stored prompts included, so a
# body without one is not this dialect.
IDENTIFIED_BY = ("model",)
