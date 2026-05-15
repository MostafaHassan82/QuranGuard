"""
Quran Citation Extension — Fixture Test Runner

Runs the real extension JavaScript in Chromium via Playwright.
Does NOT reimplement any matching logic — only orchestrates the real JS.

Usage:
    python tests/run_tests.py tests/fixtures/174389.html
    python tests/run_tests.py --all
    python tests/run_tests.py --text "قوله تعالى: {وقليل من عبادي الشكور} (سبأ:13)" [--json]
    python tests/run_tests.py --all --write-observed
    python tests/run_tests.py --all --update-expected
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

# ── Playwright import guard ───────────────────────────────────────────────────
try:
    from playwright.sync_api import sync_playwright, Playwright
except ImportError:
    print("ERROR: Playwright not installed. Run: pip install playwright && playwright install chromium")
    sys.exit(1)

# ── Paths ─────────────────────────────────────────────────────────────────────
TESTS_DIR = Path(__file__).parent
PROJECT_DIR = TESTS_DIR.parent
FIXTURES_DIR = TESTS_DIR / 'fixtures'

# ── Extension loader ──────────────────────────────────────────────────────────

def load_extension(playwright: Playwright):
    """Launch Chromium with the extension loaded. Returns (browser, context)."""
    ext_path = str(PROJECT_DIR.resolve())
    context = playwright.chromium.launch_persistent_context(
        user_data_dir=str(TESTS_DIR / 'browser_profile'),
        headless=False,  # Extensions require non-headless in Playwright
        args=[
            f'--disable-extensions-except={ext_path}',
            f'--load-extension={ext_path}',
            '--no-first-run',
            '--no-default-browser-check',
        ],
        ignore_https_errors=True,
    )
    return context

# ── JS helpers injected into the page ────────────────────────────────────────

WAIT_FOR_SCAN_JS = """
async () => {
    // Poll until scan is no longer running (up to 30s)
    const start = Date.now();
    while (Date.now() - start < 30000) {
        if (window.__quranStats && !window.__scanRunning) {
            await new Promise(r => setTimeout(r, 200));
            return true;
        }
        await new Promise(r => setTimeout(r, 300));
    }
    return false;
}
"""

TRIGGER_SCAN_JS = """
async () => {
    if (typeof window.__quranScan !== 'function') {
        return { error: '__quranScan not available — content script may not be injected' };
    }
    window.__scanRunning = true;
    try {
        const stats = await window.__quranScan();
        window.__scanRunning = false;
        return { ok: true, stats };
    } catch(e) {
        window.__scanRunning = false;
        return { error: e.message };
    }
}
"""

COLLECT_RESULTS_JS = """
() => {
    const stats = window.__quranStats ? window.__quranStats() : null;
    const matches = window.__quranMatches ? window.__quranMatches() : [];
    return { stats, matches };
}
"""

# ── Single fixture runner ─────────────────────────────────────────────────────

def run_fixture(context, html_source: str, source_label: str = '') -> dict:
    """
    Run the extension against html_source (a full HTML string).
    Returns a ScanResult dict.
    """
    page = context.new_page()
    try:
        # Load the HTML
        page.set_content(html_source, wait_until='domcontentloaded')
        # Give content script time to inject
        time.sleep(1.0)

        # Trigger scan
        result = page.evaluate("""
            async () => {
                if (typeof window.__quranScan !== 'function') {
                    // Wait up to 5s for the content script
                    const start = Date.now();
                    while (Date.now() - start < 5000) {
                        await new Promise(r => setTimeout(r, 300));
                        if (typeof window.__quranScan === 'function') break;
                    }
                }
                if (typeof window.__quranScan !== 'function') {
                    return { error: 'content script not available' };
                }
                try {
                    await window.__quranScan();
                    return { ok: true };
                } catch(e) {
                    return { error: e.message };
                }
            }
        """)

        if result.get('error'):
            print(f"  WARN scan error: {result['error']}")

        # Give a moment for DOM updates to settle
        time.sleep(0.5)

        # Collect results
        raw = page.evaluate(COLLECT_RESULTS_JS)
        stats = raw.get('stats') or {}
        matches = raw.get('matches') or []

        return {
            'source_label': source_label,
            'stats': {
                'yellowMatches':    int(stats.get('yellowMatches',    0)),
                'redMatches':       int(stats.get('redMatches',       0)),
                'yellowReferences': int(stats.get('yellowReferences', 0)),
                'partialReferences':int(stats.get('partialReferences',0)),
                'refsSeen':         int(stats.get('refsSeen',         0)),
                'refCandidates':    int(stats.get('refCandidates',    0)),
                'refVerified':      int(stats.get('refVerified',      0)),
                'refRejected':      int(stats.get('refRejected',      0)),
            },
            'matches': [
                {
                    'text': m.get('text', ''),
                    'ref':  m.get('ref', ''),
                    'type': m.get('type', ''),
                }
                for m in matches
            ],
        }
    finally:
        page.close()

# ── Comparison ────────────────────────────────────────────────────────────────

def compare_results(observed: dict, expected: dict) -> dict:
    """Compare observed vs expected. Returns {passed, diffs}."""
    diffs = []

    # Stats comparison
    obs_stats = observed.get('stats', {})
    exp_stats = expected.get('stats', {})
    for key in ['yellowMatches','redMatches','yellowReferences','partialReferences',
                'refsSeen','refCandidates','refVerified','refRejected']:
        ov = obs_stats.get(key, 0)
        ev = exp_stats.get(key, 0)
        if ov != ev:
            diffs.append(f"  stat {key}: expected {ev}, got {ov}")

    # Matches comparison (order-independent, by text+type key)
    obs_keys = {(m['text'], m['type']) for m in observed.get('matches', [])}
    exp_keys = {(m['text'], m['type']) for m in expected.get('matches', [])}
    for key in exp_keys - obs_keys:
        diffs.append(f"  MISSING match: {key[1]} | {key[0][:60]}")
    for key in obs_keys - exp_keys:
        diffs.append(f"  EXTRA match: {key[1]} | {key[0][:60]}")

    return {'passed': len(diffs) == 0, 'diffs': diffs}

# ── File helpers ──────────────────────────────────────────────────────────────

def observed_path(fixture_path: Path) -> Path:
    return fixture_path.with_suffix('.observed.json')

def expected_path(fixture_path: Path) -> Path:
    return fixture_path.with_suffix('.expected.json')

def write_observed(result: dict, fixture_path: Path):
    p = observed_path(fixture_path)
    p.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"  Wrote {p.name}")

def update_expected(fixture_path: Path):
    obs = observed_path(fixture_path)
    exp = expected_path(fixture_path)
    if not obs.exists():
        print(f"  No observed file: {obs}")
        return
    exp.write_text(obs.read_text(encoding='utf-8'), encoding='utf-8')
    print(f"  Updated {exp.name}")

# ── Main entry ────────────────────────────────────────────────────────────────

def run_all_fixtures(context, args) -> tuple[int, int]:
    """Run all fixtures/*.html. Returns (passed, total)."""
    fixtures = sorted(FIXTURES_DIR.glob('*.html'))
    if not fixtures:
        print("No fixtures found in tests/fixtures/")
        return 0, 0

    passed = 0
    total = len(fixtures)
    for fx in fixtures:
        print(f"\n[{fx.stem}]")
        html = fx.read_text(encoding='utf-8', errors='replace')
        observed = run_fixture(context, html, source_label=fx.stem)

        if args.write_observed:
            write_observed(observed, fx)

        exp_file = expected_path(fx)
        if not exp_file.exists():
            print(f"  REVIEW (no expected file yet)")
            if not args.write_observed:
                write_observed(observed, fx)
            continue

        expected = json.loads(exp_file.read_text(encoding='utf-8'))

        if args.update_expected:
            update_expected(fx)
            passed += 1
            print(f"  Updated expected → PASS")
            continue

        cmp = compare_results(observed, expected)
        if cmp['passed']:
            passed += 1
            print(f"  PASS")
        else:
            print(f"  FAIL")
            for d in cmp['diffs']:
                print(d)

    return passed, total


def run_text_snippet(context, text: str, as_json: bool):
    """Wrap the text snippet in minimal HTML and scan it."""
    html = f"""<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head><meta charset="UTF-8"></head>
<body><p>{text}</p></body>
</html>"""
    result = run_fixture(context, html, source_label='--text')
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"Stats: {result['stats']}")
        print(f"Matches ({len(result['matches'])}):")
        for m in result['matches']:
            print(f"  [{m['type']}] {m['ref']!r:30s}  {m['text'][:60]}")


def main():
    parser = argparse.ArgumentParser(description='Quran Extension Test Runner')
    parser.add_argument('fixture', nargs='?', help='Path to a fixture HTML file')
    parser.add_argument('--all', action='store_true', help='Run all fixtures')
    parser.add_argument('--text', help='Scan a text snippet directly')
    parser.add_argument('--json', action='store_true', help='Output results as JSON (with --text)')
    parser.add_argument('--write-observed', action='store_true', help='Write observed JSON files')
    parser.add_argument('--update-expected', action='store_true', help='Update expected from observed')
    args = parser.parse_args()

    if not args.fixture and not args.all and not args.text:
        parser.print_help()
        sys.exit(1)

    with sync_playwright() as pw:
        print("Loading extension in Chromium…")
        context = load_extension(pw)
        # Wait for service worker to initialize
        time.sleep(2.0)

        try:
            if args.text:
                run_text_snippet(context, args.text, args.json)

            elif args.all:
                passed, total = run_all_fixtures(context, args)
                print(f"\n{'─'*40}")
                print(f"Results: {passed}/{total} passed")
                if passed < total:
                    sys.exit(1)

            elif args.fixture:
                fx = Path(args.fixture)
                if not fx.exists():
                    print(f"File not found: {fx}")
                    sys.exit(1)
                html = fx.read_text(encoding='utf-8', errors='replace')
                observed = run_fixture(context, html, source_label=fx.stem)

                if args.write_observed:
                    write_observed(observed, fx)
                    print("Observed output written.")
                    return

                exp_file = expected_path(fx)
                if not exp_file.exists():
                    print("No expected file — writing observed for review.")
                    write_observed(observed, fx)
                    return

                expected = json.loads(exp_file.read_text(encoding='utf-8'))
                cmp = compare_results(observed, expected)
                if cmp['passed']:
                    print("PASS")
                else:
                    print("FAIL")
                    for d in cmp['diffs']:
                        print(d)
                    sys.exit(1)
        finally:
            context.close()


if __name__ == '__main__':
    main()
