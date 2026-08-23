"""responses dialect - the newer unified API."""

API = "responses"

# `model` is optional here, and only here: a call that names a stored prompt
# template (`prompt: {id, version?, variables?}`) inherits the model from the
# template. Either key means the body is genuinely this dialect's.
IDENTIFIED_BY = ("model", "prompt")
