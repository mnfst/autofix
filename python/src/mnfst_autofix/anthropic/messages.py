"""messages dialect - Anthropic's /v1/messages API."""

API = "messages"

# `model` is required on every Anthropic message, and it is the whole reason
# OpenAI's Assistants API - which posts `{role, content, attachments}` to
# `/threads/{id}/messages`, this dialect's tail - stays inert.
IDENTIFIED_BY = ("model",)
