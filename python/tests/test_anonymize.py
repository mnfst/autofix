"""Twin of node/tests/anonymize.test.ts.

The privacy boundary is stated once, in ../../tests/anonymize-cases.json, and
run here and in Node. Twin packages that agree because they read the same table,
not because someone compared them by eye.
"""

import copy
import json
import pathlib

import pytest

from mnfst_autofix.core.anonymize import merge_healed_body, strip_request

CASES = json.loads(
    (pathlib.Path(__file__).resolve().parents[2] / "tests" / "anonymize-cases.json").read_text()
)


@pytest.mark.parametrize("case", CASES["strip"], ids=lambda c: c["name"])
def test_strip(case):
    assert strip_request(case["request"]) == case["sent"]


@pytest.mark.parametrize("case", CASES["merge"], ids=lambda c: c["name"])
def test_merge(case):
    assert merge_healed_body(case["request"], case["healed"]) == case["replay"]


def test_nothing_marked_secret_survives_the_strip_in_any_case_in_the_table():
    """Whatever the table says, no secret is allowed to appear anywhere in the
    bytes that actually go out - a nesting the table's own expectations got
    wrong would still be caught here."""
    for case in CASES["strip"]:
        wire = json.dumps(strip_request(case["request"]))
        for secret in ("SECRET", "THE USERS WHOLE DOCUMENT", "acme-42", "user-99",
                       "sid-1", "cache-1", "MCP_BEARER"):
            assert secret not in wire, f"{case['name']}: {secret}"


def test_strip_request_copies_the_callers_own_request_is_never_touched():
    original = {
        "model": "m",
        "thinking": {"type": "enabled", "budget_tokens": 8000},
        "modalities": ["text"],
    }
    stripped = strip_request(original)
    stripped["thinking"]["budget_tokens"] = 1
    stripped["modalities"].append("audio")
    assert original["thinking"] == {"type": "enabled", "budget_tokens": 8000}
    assert original["modalities"] == ["text"]


def test_merge_healed_body_mutates_neither_argument():
    original = {"model": "a", "messages": ["m"], "thinking": {"type": "enabled"}}
    healed = {"model": "b", "thinking": {"type": "disabled"}}
    before = copy.deepcopy((original, healed))
    merge_healed_body(original, healed)
    assert (original, healed) == before
