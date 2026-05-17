# Quickstart: Arabic Quran Citation Auditor (V1)

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Constitution**: [../../.specify/memory/constitution.md](../../.specify/memory/constitution.md)

Practical workflow for developers picking up V1 work. Get the extension loaded, run the fixture suite, add a fixture, ship a change.

---

## 1. Load the extension (Chrome / Chromium / Edge / Brave)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked**.
4. Pick the repo root: `C:\Users\mosta\PycharmProjects\QuranAuditPlugin`.
5. Extension icon appears in the toolbar.

The extension is MV3, vanilla JS, no build step — what you load is what runs.

## 2. Run the fixture suite

```powershell
python tests/run_tests.py
```

This launches Chromium via Playwright with the unpacked extension, opens each saved fixture from `tests/fixtures/`, runs the scan, and asserts on:

- `window.__quranScan` — completed-scan summary (FR-029 language, FR-031 cap, FR-027 finalState)
- `window.__quranStats` — counters per strategy (per FR-017 only the first three may yield green)
- `window.__quranMatches` — every Finding with category, references, `priorFindingId`, etc.

See [`contracts/window-globals.md`](./contracts/window-globals.md) for the full shape.

**Constitution rule**: A regression on a previously-passing fixture is a stop-the-line event (Development Workflow item 3).

## 3. Add a fixture

```powershell
python tests/add_fixture.py "<live-url>"
```

This saves the page HTML under `tests/fixtures/<slug>/page.html` and records the *intended* expected output as `tests/fixtures/<slug>/expected.json`.

**Read this carefully**: `expected.json` MUST encode the **intended** verdicts, not whatever the current extension produces against the live page (per [research.md](./research.md) §2 — "do not capture the rebuild's broken Phase 1 output as a regression target"). If you don't know the intended output yet, leave `expected.json` empty and revisit when verifier work surfaces the truth.

## 4. Run the extension against a live URL (no fixture saved)

```powershell
python tests/run_live_url.py "<live-url>"
```

Useful for comparing live-page behavior against a saved fixture before promoting changes.

## 5. Where each module lives

After Phase 1 design ([plan.md](./plan.md) > Project Structure):

| Concern | File / Directory | Constitution touchpoint |
|---|---|---|
| Service worker, message routing, Quran index | `js/background.js` | Tech Constraints (rebuild on activation, `return true` discipline) |
| Per-frame scan orchestrator, `MutationObserver`, progressive reveal, cap | `js/content.js` | FR-019, FR-023, FR-031 |
| Popup UI, preferences, font picker, Re-scan All, Continue scanning, Clear remembered | `js/popup.js` + `html/popup.html` + `css/popup.css` | FR-009, FR-024, FR-026, FR-031 |
| Verifier — normalization, indexes, five-color classifier, **orange pipeline (new)**, references | `js/verifier/` | Principles I/II/III/V — read advanced copy for *cases*, redesign shape |
| Authentic-text swap engine | `js/render/swap.js` | Principle IV, FR-008, SC-013 |
| Bundled Quran fonts | `js/render/fonts.js` + `resources/fonts/*` + `css/fonts.css` | FR-008/FR-009 |
| Findings panel — both surfaces, identity, actions, keyboard | `js/panel/` + `html/sidebar.html` + `css/sidebar.css` | FR-010, FR-011, FR-022, FR-025, FR-030 |
| Preferences + per-URL persisted store (30-day TTL) | `js/storage/` | FR-024 |
| Stateful action badge | `js/badge/badge.js` | FR-028 |

## 6. The porting discipline (Principle V, NON-NEGOTIABLE)

The "advanced copy" at `C:\Users\mosta\PycharmProjects\QuranChromePlugin` (read-only) is more battle-tested than this rebuild. It has **17 verified, 0 red** on fixture 174389; the rebuild currently has **6 verified, 16 red** on the same fixture.

**Do**: Open the advanced copy when working on extraction / verification / range handling. Catalog the *cases* it handles (Islamweb DOM quirks, surah-name variants, range constructs, drift normalization).

**Don't**: Copy `background.js` (1300 lines) or `content.js` (1883 lines) verbatim. Their size encodes accumulated case-by-case patches — that's exactly what we're rewriting away from.

**Smell test**: If a fixture forces an `if (url === ...)` or a hardcoded patch in production code, the design is wrong. Step back, reshape, don't ship the carve-out.

## 7. Editing the Quran data file

Don't. `resources/quran-uthmani_desc-v2.json` is the single source of truth (constitution Tech Constraints). Any change to it is a major decision that needs explicit ratification.

## 8. Common dev gotchas

- **MV3 service worker eviction**: the worker can be evicted while idle. Index is rebuilt on next activation (~50–100 ms). If a scan message arrives mid-eviction, the request reaches the new worker and replays cleanly. Don't add `IndexedDB` to "fix" this — see Open Question Q6.
- **`return true` in message handlers**: omitting this closes the channel and the popup hangs on `sendResponse`. Every async handler returns `true` synchronously.
- **Content script `<all_urls>` matches**: the extension is installed with broad host access. Combine with the `scanTrigger: "manual"` default (FR-026) so we don't *use* it on pages where the user hasn't asked us to.
- **Highlight focus traversal**: every highlight is `tabindex="0"` (FR-032). On a long article with many citations, Tab traversal is noisy by design — that's the cost of full keyboard accessibility. Don't add an opt-out toggle in V1.
- **`window.__quran*` shape**: Playwright fixtures depend on the shape in [`contracts/window-globals.md`](./contracts/window-globals.md). Treat that file as a wire contract — additions OK, removals/renames need a contract-version bump.

## 9. Where to look when intent is unclear

Order of authority (per [research.md](./research.md) §3):

1. [spec.md](./spec.md) — what V1 must do (32 FRs + 13 SCs + 20 clarifications)
2. [../../.specify/memory/constitution.md](../../.specify/memory/constitution.md) — non-negotiable principles
3. [`fresh_start/`](../../fresh_start/) — the V1 PRD and supporting design docs (`00-V1-PRD.md`, `06-verifier-design.md`, etc.)
4. The advanced copy — for cases, not implementation

If product intent and the advanced copy disagree, `fresh_start/` wins for *what*; the advanced copy wins for *which cases exist*.

## 10. What `/speckit-plan` did NOT decide

The plan stops at design contracts. The following are deliberately left for `/speckit-tasks` (Phase 2):

- Per-task ordering and dependencies
- Per-task acceptance criteria mapped to specific FR/SC IDs
- Assignment of tasks to Milestones A–E from the V1 PRD
- Estimation, sequencing, parallelization opportunities

Next command: `/speckit-tasks`.
