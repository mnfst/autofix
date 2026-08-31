"""The gate - everything that decides whether a failed response is one autofix
is allowed to touch. It reads and it decides; it never acts.

Mirrors node/src/core/gate.ts.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Dict, NamedTuple, Optional, Sequence, Tuple

import httpx


@dataclass(frozen=True)
class Route:
    """Provider + api for one URL, plus what identifies the dialect's bodies.

    `identified_by` names the top-level body keys that say "this body really is
    this dialect". At least one must be present, or the request is none of our
    business - this is what makes matching on a path TAIL safe. Owned by the
    dialect because only the dialect knows what identifies it: `/responses` also
    answers to a stored prompt reference, `/chat/completions` and `/messages`
    do not.
    """

    provider: str
    api: str
    identified_by: Sequence[str] = ("model",)
    model: Optional[str] = None
    provider_format: Optional[str] = None
    redacted_fields: Sequence[str] = ()
    replay: Optional[
        Callable[[httpx.URL, Dict[str, Any]], Tuple[httpx.URL, Dict[str, Any]]]
    ] = None


# A provider's route table: URL -> Route, or None to stay inert.
#
# Routes match on the URL's PATH, not its host: you opted in by passing this
# transport to that SDK, so autofix follows wherever the SDK's base_url points
# - a gateway, a proxy, Azure, localhost. A host allowlist would make the
# transport silently inert for most real deployments.
#
# The safety boundary is therefore: (1) you chose this adapter explicitly,
# (2) the path is an LLM endpoint shape, and (3) only scalar settings can travel
# or be written back - structure and content never do (core/anonymize.py).
Detect = Callable[[httpx.URL], Optional[Route]]

# Statuses worth waking up for. Checked by the caller before anything else so
# the success path stays a single comparison: 401/403 (auth) and 429/5xx (the
# SDK's own retry territory) never get this far.
HEALABLE_STATUS = frozenset({400, 404, 422})


class Healable(NamedTuple):
    """A failure autofix may act on, carrying everything the heal call needs."""

    url: str
    route: Route
    request: Dict[str, Any]
    error: Dict[str, Any]


def parse_provider_error(value: Any) -> Optional[Dict[str, str]]:
    """Normalize provider error envelopes to the fields the heal API accepts."""
    if not isinstance(value, dict) or not isinstance(value.get("message"), str):
        return None
    error = {"message": value["message"]}
    error_type = value.get("type") if isinstance(value.get("type"), str) else value.get("status")
    if isinstance(error_type, str):
        error["type"] = error_type
    if isinstance(value.get("param"), str):
        error["param"] = value["param"]
    if isinstance(value.get("code"), (str, int)):
        error["code"] = str(value["code"])
    return error


def path_ends_with(url: httpx.URL, suffix: str) -> bool:
    """Endpoint paths vary by deployment - `/v1/chat/completions` on OpenAI,
    `/api/v1/chat/completions` on OpenRouter,
    `/openai/deployments/<name>/chat/completions` on Azure - but the tail is
    stable, so match that."""
    return url.path == suffix or url.path.endswith(suffix)


def safe_url(url: httpx.URL) -> str:
    """What we tell the heal API the request went to. Scheme + host + path only:
    query strings are dropped because some gateways carry tokens there
    (`?api-key=...`), and with arbitrary hosts allowed we can no longer assume
    the query is safe to forward."""
    port = f":{url.port}" if url.port else ""
    return f"{url.scheme}://{url.host}{port}{url.path}"


def in_scope(detect: Detect, request: httpx.Request) -> Optional[Route]:
    """The cheap half of the gate: could this request be healed at all? Answered
    before the response body is read, so a failure from a path we were never
    going to touch costs nothing."""
    if request.method.upper() != "POST":
        return None
    return detect(request.url)


def open_gate(detect: Detect, request: httpx.Request,
              response: httpx.Response) -> Optional[Healable]:
    """The healable failure behind this response, or None to leave it alone.
    Uploads, off-route paths and bodies that don't parse all return None: when
    in doubt the transport does nothing and the caller keeps its own response.

    The caller must have read the response body already.
    """
    route = in_scope(detect, request)
    if route is None:
        return None
    try:
        req = json.loads(request.content)  # raises for streamed bodies -> not our problem
        error = parse_provider_error(json.loads(response.content).get("error"))
    except Exception:
        return None
    if not isinstance(req, dict) or not any(key in req for key in route.identified_by):
        # The route's identifying keys are the second half of the route check,
        # and they are what makes the path tail safe to match on. Almost always
        # that means `model` (Azure included - the deployment goes in the path
        # and `model` stays in the body); the Responses API also accepts a
        # stored prompt template in its place. Endpoints that merely END in one
        # of our tails carry neither: OpenAI's Assistants API posts
        # `{role, content, attachments}` to `/threads/{id}/messages`, which is
        # the Anthropic dialect's tail and none of our business.
        return None
    if not error or not error.get("message"):
        return None
    return Healable(safe_url(request.url), route, req, error)
