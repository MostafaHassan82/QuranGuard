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
import io
import json
import sys
import time
from pathlib import Path

# Force UTF-8 stdout on Windows (avoids UnicodeEncodeError for Arabic text)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

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

# Fixture serving URL — a stable http:// URL that Playwright routes to our HTML.
# <all_urls> in the manifest matches this, so the extension injects content.js.
FIXTURE_URL = 'http://quran-ext-fixture.local/page.html'

# ── Extension loader ──────────────────────────────────────────────────────────

def load_extension(playwright: Playwright):
    """Launch Chromium with the extension loaded. Returns a persistent context."""
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


# ── Single fixture runner ─────────────────────────────────────────────────────

def run_fixture(context, html_source: str, source_label: str = '',
               fixture_path: Path = None) -> dict:
    """
    Run the extension against html_source.
    Uses Playwright route.fulfill() to serve the HTML at FIXTURE_URL — a stable
    http:// URL that matches <all_urls> so the content script is injected.
    Returns a ScanResult dict.
    """
    if fixture_path and fixture_path.exists():
        html_source = fixture_path.read_text(encoding='utf-8', errors='replace')

    page = context.new_page()
    try:
        body_bytes = html_source.encode('utf-8')
        # Abort all HTTP(S) requests by default — prevents external blocking scripts
        # from stalling DOMContentLoaded (islamweb pages have many external <script>s).
        # Playwright uses last-registered route first, so fixture URL is registered
        # AFTER the catch-all so it takes precedence.
        page.route('**/*', lambda route: route.abort())
        # Serve fixture HTML at the stable local URL (overrides the catch-all above)
        page.route(FIXTURE_URL, lambda route: route.fulfill(
            status=200,
            headers={'Content-Type': 'text/html; charset=utf-8'},
            body=body_bytes,
        ))

        # 'commit' returns as soon as the first response byte arrives.
        # External requests are aborted so DOMContentLoaded fires quickly.
        # content.js bridge guard (readyState check) + retry loop handles timing.
        page.goto(FIXTURE_URL, wait_until='commit', timeout=15000)

        # Trigger scan via DOM event bridge.
        # content.js (isolated world) listens for '__quranBridgeScan' and
        # dispatches '__quranBridgeDone' with stats+matches when done.
        # Retry until the content script is ready (small startup delay).
        raw = page.evaluate("""
            async () => {
                return new Promise((resolve) => {
                    const overallTimeout = setTimeout(
                        () => resolve({ error: 'content script not ready after 35s' }), 35000);
                    let done = false;

                    function attempt() {
                        if (done) return;
                        const handler = (e) => {
                            if (done) return;
                            done = true;
                            clearTimeout(overallTimeout);
                            resolve({ ok: true, ...e.detail });
                        };
                        document.addEventListener('__quranBridgeDone', handler, { once: true });
                        document.dispatchEvent(new Event('__quranBridgeScan'));
                        // If content script not ready, it won't respond; retry in 1s
                        setTimeout(() => {
                            if (!done) {
                                document.removeEventListener('__quranBridgeDone', handler);
                                attempt();
                            }
                        }, 1000);
                    }
                    attempt();
                });
            }
        """)

        if raw.get('error'):
            print(f"  WARN scan error: {raw['error']}")

        stats = raw.get('stats') or {}
        matches = raw.get('matches') or []

        return {
            'source_label': source_label,
            'stats': {
                'greenMatches':     int(stats.get('greenMatches',     0)),
                'lightBlueMatches': int(stats.get('lightBlueMatches', 0)),
                'yellowMatches':    int(stats.get('yellowMatches',    0)),
                'orangeMatches':    int(stats.get('orangeMatches',    0)),
                'redMatches':       int(stats.get('redMatches',       0)),
                'totalFindings':    int(stats.get('totalFindings',    0)),
                'refsSeen':         int(stats.get('refsSeen',         0)),
                'refCandidates':    int(stats.get('refCandidates',    0)),
            },
            'matches': [
                {
                    'text':       m.get('text', ''),
                    'color':      m.get('color', ''),
                    'matchedRef': m.get('matchedRef', ''),
                    'claimedRef': m.get('claimedRef', ''),
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

    # Stats comparison — V1 five-color vocabulary
    obs_stats = observed.get('stats', {})
    exp_stats = expected.get('stats', {})
    for key in ['greenMatches', 'lightBlueMatches', 'yellowMatches', 'orangeMatches',
                'redMatches', 'totalFindings', 'refsSeen', 'refCandidates']:
        ov = obs_stats.get(key, 0)
        ev = exp_stats.get(key, 0)
        if ov != ev:
            diffs.append(f"  stat {key}: expected {ev}, got {ov}")

    # Matches comparison (order-independent, by text+color key)
    obs_keys = {(m['text'], m['color']) for m in observed.get('matches', [])}
    exp_keys = {(m['text'], m['color']) for m in expected.get('matches', [])}
    for key in exp_keys - obs_keys:
        diffs.append(f"  MISSING match [{key[1]}]: {key[0][:60]}")
    for key in obs_keys - exp_keys:
        diffs.append(f"  EXTRA match [{key[1]}]: {key[0][:60]}")

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
    skipped = 0
    total = 0  # counts only fixtures with non-skip expected files
    for fx in fixtures:
        print(f"\n[{fx.stem}]")
        observed = run_fixture(context, '', source_label=fx.stem, fixture_path=fx)

        if args.write_observed:
            write_observed(observed, fx)

        exp_file = expected_path(fx)
        if not exp_file.exists():
            print(f"  REVIEW (no expected file yet)")
            if not args.write_observed:
                write_observed(observed, fx)
            skipped += 1
            continue

        expected = json.loads(exp_file.read_text(encoding='utf-8'))

        if expected.get('_skip'):
            print(f"  SKIP (expected marked _skip — run --write-observed to populate)")
            if not args.write_observed:
                write_observed(observed, fx)
            skipped += 1
            continue

        total += 1

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

    return passed, total, skipped


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
                passed, total, skipped = run_all_fixtures(context, args)
                print(f"\n{'-'*40}")
                skip_note = f"  ({skipped} skipped/review)" if skipped else ""
                print(f"Results: {passed}/{total} passed{skip_note}")
                if passed < total:
                    sys.exit(1)

            elif args.fixture:
                fx = Path(args.fixture)
                if not fx.exists():
                    print(f"File not found: {fx}")
                    sys.exit(1)
                observed = run_fixture(context, '', source_label=fx.stem, fixture_path=fx)

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
