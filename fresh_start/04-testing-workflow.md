# Testing Workflow

## Principle

Tests must run the real extension JavaScript. Python test tools should not reimplement Quran citation matching.

The Python scripts are orchestration tools only: they open a browser, load the extension files, scan HTML or live pages, collect the same stats/matches the extension would produce, and compare them to reviewed JSON.

## Test Directory Shape

Use this structure:

- `tests/run_tests.py`: run saved HTML fixtures or direct text snippets through the real JS code.
- `tests/add_fixture.py`: create a new fixture from a URL.
- `tests/run_live_url.py`: run the extension against a live URL for real-site comparison.
- `tests/fixtures/*.html`: saved article HTML.
- `tests/fixtures/*.expected.json`: reviewed expected output.
- `tests/.gitignore`: ignore temporary browser profiles and observed outputs.

## Fixture Runner

Run one fixture:

```bash
python tests/run_tests.py tests/fixtures/174389.html
```

Run all fixtures:

```bash
python tests/run_tests.py --all
```

Debug a pasted paragraph:

```bash
python tests/run_tests.py --text "قوله تعالى: {وقليل من عبادي الشكور} (سبأ:13)" --json
```

Write observed output for review:

```bash
python tests/run_tests.py --all --write-observed
```

After manual review, update expected files:

```bash
python tests/run_tests.py --all --update-expected
```

The runner should print a summary at the end, including total fixtures, pass count, review/fail count, and important stat mismatches.

## Adding Fixtures

Create a fixture from a URL:

```bash
python tests/add_fixture.py "https://www.islamweb.net/ar/article/174389/..." --name 174389
```

Prefer rendered capture when the live site uses markup that differs from raw HTML:

```bash
python tests/add_fixture.py "https://www.islamweb.net/ar/article/238996/..." --name 238996 --rendered --scan
```

Use article IDs as fixture names when possible, for example:

- `174389`
- `202459`
- `238996`
- `241627`

This keeps fixtures easy to map back to Islamweb URLs.

## Live URL Runner

Use the live runner when fixture results differ from the real extension on the website:

```bash
python tests/run_live_url.py "https://www.islamweb.net/ar/article/238996/..." --single-scan
```

This is important because saved HTML can differ from the rendered DOM. The live runner helps identify whether the gap is a fixture capture issue, page timing issue, or scanner bug.

## Expected JSON

Expected files should store:

- Source URL and fixture metadata.
- Expected stats, including all eight debug values.
- Expected matches with the highlighted text and references.
- Empty fields should not be kept unless they are intentionally meaningful.

Stats use this order:

```text
yellowMatches, redMatches, yellowReferences, partialReferences, refsSeen, refCandidates, refVerified, refRejected
```

## Regression Fixture Set

Preserve fixtures covering:

- Standard Islamweb article citations.
- Multiple exact references for the same phrase.
- Partial and non-ordered references.
- Explicit refs with shortened or variant surah names.
- Back-reference extraction.
- Range citations.
- Long `إلى قوله` range citations that should split into multiple citation spans.
- Short one-word and two-word citations with explicit references.
- False-positive-heavy Arabic prose.

Current useful fixture IDs:

- `120981`
- `174389`
- `202459`
- `228475`
- `228994`
- `238996`
- `241627`
- `246487`
- `246814`
- `41337`

## When To Accept Expected Changes

Only update expected JSON after checking that:

- Red count did not increase unexpectedly.
- Known exact citations are still green.
- Multi-reference tooltips still include all intended references.
- Partial references remain marked as partial.
- Explicit reference metadata is not highlighted as ayah text.
- Live URL output and fixture output match, or the difference is understood and documented.

