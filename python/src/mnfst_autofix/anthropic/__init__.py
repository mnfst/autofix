"""mnfst-autofix/anthropic - self-healing httpx transport for the Anthropic SDK.

Integration (the whole thing):

    from anthropic import Anthropic
    from mnfst_autofix.anthropic import autofix

    client = Anthropic(http_client=autofix())

The healing engine is provider-agnostic (see core/engine.py); this module is
only Anthropic's route table. Anthropic nests its error under `error` like
OpenAI ({"type":"error","error":{"type","message"}}), so the engine's error
parse works unchanged - but the payload carries no `param`/`code`, so the heal
API fingerprints these on the message signature.

The Node twin unifies its dialects into a single entry point
(node/src/index.ts); Python keeps them per-SDK, because the x-autofix-source
value follows which module you import.
"""

from __future__ import annotations

from typing import Optional

import httpx

from ..core.engine import (
    AsyncAutofixTransport,
    AutofixTransport,
    HealEvent,
    Route,
    make_clients,
    path_ends_with,
)
from .messages import API as MESSAGES_API
from .messages import IDENTIFIED_BY as MESSAGES_IDENTIFIED_BY


def detect(url: httpx.URL) -> Optional[Route]:
    """Api inferred from the URL PATH - any host. Whatever base_url the SDK
    points at (Anthropic, a gateway, a proxy, localhost) is followed; a non-LLM
    path leaves the transport inert. `/v1/messages/batches` is excluded: it is a
    different request shape, not a single failing call."""
    if path_ends_with(url, "/messages"):
        return Route("anthropic", MESSAGES_API, MESSAGES_IDENTIFIED_BY)
    return None


autofix, autofix_async = make_clients(detect, source="anthropic-sdk")

__all__ = [
    "autofix",
    "autofix_async",
    "detect",
    "AutofixTransport",
    "AsyncAutofixTransport",
    "HealEvent",
]
