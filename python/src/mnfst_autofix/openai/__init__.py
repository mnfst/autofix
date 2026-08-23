"""mnfst-autofix/openai - self-healing httpx transport for the OpenAI SDK.

Integration (the whole thing):

    from openai import OpenAI
    from mnfst_autofix.openai import autofix

    client = OpenAI(http_client=autofix())

The healing engine is provider-agnostic (see core/engine.py); this module is
only OpenAI's route table. The Node twin unifies its dialects into a single
entry point (node/src/index.ts); Python keeps them per-SDK, because the
x-autofix-source value follows which module you import.
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
from .chat import API as CHAT_API
from .chat import IDENTIFIED_BY as CHAT_IDENTIFIED_BY
from .responses import API as RESPONSES_API
from .responses import IDENTIFIED_BY as RESPONSES_IDENTIFIED_BY


def detect(url: httpx.URL) -> Optional[Route]:
    """Api inferred from the URL PATH - any host. Whatever base_url the SDK
    points at (OpenAI, a gateway, Azure, LiteLLM, localhost) is followed; a
    non-LLM path leaves the transport inert. See core/engine.py."""
    if path_ends_with(url, "/responses"):
        return Route("openai", RESPONSES_API, RESPONSES_IDENTIFIED_BY)
    if path_ends_with(url, "/chat/completions"):
        return Route("openai", CHAT_API, CHAT_IDENTIFIED_BY)
    return None


autofix, autofix_async = make_clients(detect, source="openai-sdk")

__all__ = [
    "autofix",
    "autofix_async",
    "detect",
    "AutofixTransport",
    "AsyncAutofixTransport",
    "HealEvent",
]
