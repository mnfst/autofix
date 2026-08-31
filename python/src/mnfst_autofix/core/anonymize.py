"""The request privacy boundary, mirrored by node/src/core/anonymize.ts.

A structural forbid list keeps audited content, identity, schema, location, and
credential fields home at any depth. Lists travel only when every element is a
scalar; lists containing nested structure stay home and are never walked. Dicts
are walked, so scalar leaves and scalar-only lists under unknown custom keys can
travel. That lets new provider controls reach the heal API without waiting for a
package release, but it does not make arbitrary custom scalar fields private.

On the way back the healed body is authoritative for what it names, and
everything that stayed home comes from the caller's own copy. So a heal can
correct a setting it was shown, and can delete one by leaving it out, but it can
neither author nor delete anything it never saw.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, Tuple

# Key names that never travel, at any depth, whatever they hold.
#
# `content`, `input`, `instructions`, `system`, `prompt`, `stop` and
# `stop_sequences` are free-form user text - the prompt under another name.
# `schema` and `json_schema` are the caller's own JSON Schema: their data model,
# field by field. `user`, `safety_identifier`, `prompt_cache_key` and `metadata`
# say who the end user is and what they are billed and cached under.
# `prediction` is the user's verbatim document, quoted back to the model.
# `authorization_token` is a live bearer token for somebody else's server.
# `user_location` is where the end user physically is.
NEVER_TRAVELS = frozenset((
    "content", "contents", "input", "instructions", "system", "systemInstruction",
    "prompt", "stop", "stop_sequences", "stopSequences",
    "schema", "json_schema", "responseSchema",
    "user", "metadata", "labels", "safety_identifier", "prompt_cache_key", "user_location",
    "cachedContent",
    "prediction", "authorization_token",
))

# These travel so the heal API can diagnose them, but its answer never gets to
# change them. Streaming is fixed once the SDK chooses how to parse the
# response; n and store control spend and retention.
CALLER_OWNED = frozenset(("stream", "stream_options", "n", "store"))


def _is_scalar_list(value: Any) -> bool:
    """A list with no structure in it: a fixed vocabulary like ["text", "audio"],
    not a payload. Anything nested is a place bulk content could hide, so one dict
    or one list anywhere in it keeps the whole thing home. An empty list qualifies
    because it carries nothing.
    """
    return not any(isinstance(item, (dict, list, tuple)) for item in value)


def _sent(key: str, value: Any) -> Tuple[bool, Any]:
    """Return (travels, what the heal API is shown) for one key of a request.

    The name check runs before the shape check because `stop` and `stop_sequences`
    are lists of scalars and would otherwise qualify - but those scalars are the
    user's own words, so the name has to win.

    A dict whose every leaf stayed home returns False rather than {}: an empty
    container would tell the heal API the caller sent nothing there, which is
    the one thing that is not true.
    """
    if key in NEVER_TRAVELS:
        return False, None
    if isinstance(value, (list, tuple)):
        # Copied, like every other level, so nothing that travels aliases the caller.
        return (True, list(value)) if _is_scalar_list(value) else (False, None)
    if not isinstance(value, dict):
        return True, value
    inner = _sent_dict(value)
    return bool(inner), inner


def _sent_dict(source: Dict[str, Any]) -> Dict[str, Any]:
    """One level of the walk, rebuilt from scratch so nothing aliases the caller."""
    kept: Dict[str, Any] = {}
    for key, value in source.items():
        travels, shown = _sent(key, value)
        if travels:
            kept[key] = shown
    return kept


def strip_request(request: Dict[str, Any], *, send_messages: bool = False) -> Dict[str, Any]:
    """The request as the heal API sees it: the settings, and nothing else.

    ``send_messages=True`` sends the top-level ``messages`` or Gemini
    ``contents`` list verbatim, content and all. Off by default. For callers who
    want the conversation visible next to the failure it caused.
    Observability only: ``merge_healed_body`` never consults this, so the heal
    API still cannot author or rewrite a message even after being shown them.
    """
    kept = _sent_dict(request)
    if send_messages and isinstance(request.get("messages"), list):
        kept["messages"] = copy.deepcopy(request["messages"])
    if send_messages and isinstance(request.get("contents"), list):
        kept["contents"] = copy.deepcopy(request["contents"])
    return kept


def merge_healed_body(original: Dict[str, Any], healed_body: Dict[str, Any]) -> Dict[str, Any]:
    """The body to replay: the healed answer over the caller's own request.

    The healed body is put through the same walk as the request before it is
    believed, so the server can only ever speak in the vocabulary the client
    speaks - no lists with anything nested in them, none of the forbidden names.
    That is what stops a heal from smuggling `messages` back in, and it costs the
    server nothing it could legitimately want to say.

    Then, key by key at every depth: what the client withheld is the caller's,
    always. What the client sent, the healed body settles - its value if it names
    one, and DROPPED if it does not. Deletion by omission is how a parameter gets
    removed now, and unlike a list of known knobs it works for a parameter nobody
    has ever heard of.
    """
    return _merge_level(original, _sent_dict(healed_body))


def _merge_level(original: Dict[str, Any], healed: Dict[str, Any]) -> Dict[str, Any]:
    merged: Dict[str, Any] = {}
    for key, value in original.items():
        if key in CALLER_OWNED or not _sent(key, value)[0]:
            merged[key] = value  # never travelled -> not the server's to touch
            continue
        answered = key in healed
        answer = healed.get(key)
        if isinstance(value, dict):
            # A container is settled one leaf at a time: silence about the
            # container still drops every leaf that travelled, and still restores
            # every leaf that did not - a user schema inside a healed `text`
            # outlives the heal.
            kept = _merge_level(value, answer if isinstance(answer, dict) else {})
            if kept:
                merged[key] = kept
        elif answered:
            merged[key] = answer
    for key, value in healed.items():
        # A setting the caller never sent: the server may add it, unless it is
        # one of the caller's own.
        if key not in original and key not in CALLER_OWNED:
            merged[key] = value
    return merged
