# Coverage — how to run and what the numbers mean

The Node fixture runner (`tests/run_tests_node.js`) doubles as a V8 line-coverage
tool. A line counts as **covered if any non-whitespace byte on it executed** in
any fixture run (coverage is unioned across fixtures).

## Commands

| Command | What it does |
|---|---|
| `node tests/run_tests_node.js --all` | Correctness only; no coverage, no interaction driver. Fast. |
| `node tests/run_tests_node.js --all --coverage` | Coverage with the base interaction driver on every fixture. |
| `node tests/run_tests_node.js --all --coverage --coverage-faults` | Adds the fault-injection driver. **This is the command that produces the committed `coverage-summary.json` (95.2%).** |
| `node tests/run_tests_node.js --coverage-diff --coverage-faults` | Runs `pages/` and `synthetic/` as separate groups and writes `pages-vs-synthetic.{md,json}`. |
| `node tests/run_tests_node.js tests/fixtures/synthetic --coverage --coverage-faults` | Coverage over the synthetic fixtures only (fast coverage signal). |

Driver intensity flags: `--coverage-driver-lite` (base driver only, no extended),
`--coverage-driver-off` (no driver). The heavy **extended** and **fault** drivers
are opt-in per fixture via `_coverage: { extended, faults }` in that fixture's
`expected.json` — currently `synthetic/wrong_ref_orange` (extended + faults) and
`synthetic/cap_hit` (extended). This keeps the expensive paths pinned to a couple
of fixtures regardless of renames.

## Time vs. coverage (measured 2026-05-23)

Wall-clock times are **approximate and machine-dependent** (the extended driver
has a bridge wait that varies by a few seconds per run). Coverage percentages are
stable.

| Command | Full suite (59 fixtures) | Synthetic only (11 fixtures) |
|---|---|---|
| `--all` (no coverage) | ~0:58 · 59/59 pass | ~0:11 · 11/11 pass |
| `--all --coverage` (no faults) | ~2:33 · **94.2%** | ~2:18 · **94.2%** |
| `--all --coverage --coverage-faults` | ~2:30 · **95.2%** | ~1:30 · **95.1%** |

## Key finding: real pages barely move coverage

Coverage is driven almost entirely by the **synthetic** fixtures (they carry the
extended/fault drivers and are engineered to hit specific code paths). The 48 real
`pages/` fixtures contribute **~0.0–0.1 pp** on top of synthetic.

`--coverage-diff` makes this explicit (see `pages-vs-synthetic.md`):

| Group | Line % |
|---|---|
| `pages/` only | **88.3%** |
| `synthetic/` only | **95.1%** |
| Delta (pages − synthetic) | **−6.8 pp** |

**Implication:** the `pages/` fixtures earn their keep as *correctness* regression
tests (real-world citation shapes that must stay classified correctly), not as
coverage drivers. For a fast coverage signal during development, run coverage over
`tests/fixtures/synthetic` alone — it lands within ~0.1 pp of the full suite.

## Artifacts in this directory

- `coverage-summary.json` — overall + per-file line coverage (committed; regenerate with the `--coverage-faults` command above).
- `uncovered.md` — human-readable uncovered-line ranges per file.
- `pages-vs-synthetic.{md,json}` — per-group / per-file coverage diff from `--coverage-diff`.
