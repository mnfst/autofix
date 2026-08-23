"""The heal API reads the User-Agent to know which client is calling.

A release that bumps pyproject.toml and forgets __init__.__version__ would keep
reporting the old one, silently, forever. Fail here instead. Node has the same
guard in tests/version.test.ts.
"""

import pathlib
import re

try:  # 3.11+
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - only taken on 3.9 / 3.10
    tomllib = None

import pytest

from mnfst_autofix import __version__
from mnfst_autofix.core.heal_api import USER_AGENT

PYPROJECT = pathlib.Path(__file__).resolve().parents[1] / "pyproject.toml"


@pytest.mark.skipif(tomllib is None, reason="tomllib landed in 3.11")
def test_version_matches_pyproject():
    declared = tomllib.loads(PYPROJECT.read_text())["project"]["version"]
    assert __version__ == declared


def test_user_agent_reports_the_package_version():
    assert USER_AGENT == f"autofix-python/{__version__}"


def test_version_is_a_plain_semver_string():
    """It is pasted straight into a header; anything else would ship a
    malformed User-Agent rather than fail loudly."""
    assert re.fullmatch(r"\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?", __version__)
