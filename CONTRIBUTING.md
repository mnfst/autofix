# Contributing

Two packages, one behaviour. `node/` and `python/` are ports of each other and
are meant to stay that way: same stages, same decisions, same guarantees. A fix
that lands in one and not the other is half a fix.

## Layout

The healing engine is provider-agnostic. Providers only bring a route table.

```
node/src/core/anonymize.ts   the privacy boundary: strip and merge
node/src/core/gate.ts        what may be touched
node/src/core/heal-api.ts    the only code that talks to the heal service
node/src/core/engine.ts      orchestration, and createAutofix(adapter)
node/src/openai/             OpenAI's routes, /chat/completions + /responses
node/src/anthropic/          Anthropic's routes, /messages
node/src/google/             Google's native :generateContent routes
```

`python/src/mnfst_autofix/core/` mirrors that, plus `attempt.py`, which holds
the decisions the sync and async transports share so there is one copy of them.

`tests/anonymize-cases.json` states the privacy boundary once, and both test
suites run every case in it. A change to what travels goes there first, or the
twins drift where nobody is looking. The contract must stay explicit that
unknown custom scalar fields and scalar-only arrays can travel.

Adding a provider is a route table and a dialect file. If it needs an engine
change, that change has to be provider-agnostic.

## Running things

```bash
cd node && npm ci && npm run lint && npx tsc --noEmit && npm run test:coverage && npm run build
```

```bash
cd python && pip install -e ".[dev]" && ruff check . && pytest -q --cov=mnfst_autofix
```

`test:coverage` fails under 100% lines and functions on `src/`. Python fails
under 100% statements. CI runs the same commands, plus Python on 3.9 through
3.13 and Node on 18.17 through 22, because that's what the manifests promise.

Hooks, once:

```bash
pip install pre-commit && pre-commit install
```

## The one rule

Autofix runs inside somebody else's request path. It is never allowed to be the
reason a call fails. Every new branch either returns the caller's original
response or is wrapped in something that does. If you can't see how your change
falls open, it isn't finished.

Four corollaries, because all four have been broken before:

- Nothing autofix calls may sit on the caller's clock without a budget.
- The heal API's answer is untrusted input. It can be null, a string, a list.
- Content fields and `stream` / `stream_options` belong to the caller. The heal
  API can't set them, drop them, or smuggle them back in.
- The `onHeal` hook is for watching, never for deciding. A callback that throws
  is the caller's bug and must not become ours.

## House style

- Files under 300 lines, functions under 50. eslint and ruff enforce it.
- Comments say why. The code already says what.
- Tests describe a guarantee in their name and assert what the caller sees, not
  which internal function ran.
- No new runtime dependencies. Node has zero, Python has httpx, and that's the
  budget.

## Versions

`node/src/core/version.ts` and `node/package.json` have to agree, and
`mnfst_autofix.__version__` has to match `pyproject.toml`. Tests enforce both:
the version is what the heal API sees in the User-Agent, so drift is silent
otherwise.

## Releases

Bump the two files for a package in their own commit. Merging that to `main`
publishes it: the workflow skips any version the registry already has, tags
`js-v*` or `py-v*`, and opens a GitHub release. Release notes are generated
from the commits since the last tag of that package, which is the other reason
to keep one concern per commit.

The two packages version independently. A fix that lands in both usually ships
as two bumps.

## Commits and PRs

Conventional prefixes (`fix:`, `feat:`, `refactor:`, `docs:`, `ci:`, `chore:`).
One concern per commit. Branch off `main`, open a PR, don't push to `main`.

Be kind. Reports and reviews are about code, not people. Anything that isn't,
mail conduct@manifest.build.
