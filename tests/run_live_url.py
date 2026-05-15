"""
Run the extension against a live URL and compare against saved fixture expected JSON.

Useful when fixture HTML differs from the real rendered DOM (JS-loaded content,
lazy-loaded text, etc.).

Usage:
    python tests/run_live_url.py "https://www.islamweb.net/ar/article/238996/..." --name 238996
    python tests/run_live_url.py "https://..." --name 238996 --write-observed
"""

import argparse
import json
import sys
import time
from pathlib import Path

TESTS_DIR = Path(__file__).parent
PROJECT_DIR = TESTS_DIR.parent
FIXTURES_DIR = TESTS_DIR / 'fixtures'

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("ERROR: Playwright not installed. Run: pip install playwright && playwright install chromium")
    sys.exit(1)

sys.path.insert(0, str(TESTS_DIR))
from run_tests import load_extension, compare_results, write_observed, expected_path


def run_live(context, url: str, name: str) -> dict:
    """Navigate to the live URL and scan with the real extension."""
    page = context.new_page()
    try:
        print(f"  Navigating to: {url}")
        page.goto(url, wait_until='networkidle', timeout=30000)
        time.sleep(2.0)  # settle JS rendering

        # Trigger scan
        result = page.evaluate("""
            async () => {
                if (typeof window.__quranScan !== 'function') {
                    const start = Date.now();
                    while (Date.now() - start < 8000) {
                        await new Promise(r => setTimeout(r, 400));
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
            print(f"  WARN: {result['error']}")

        time.sleep(1.0)

        raw = page.evaluate("""
            () => {
                const stats = window.__quranStats ? window.__quranStats() : null;
                const matches = window.__quranMatches ? window.__quranMatches() : [];
                return { stats, matches };
            }
        """)
        stats = raw.get('stats') or {}
        matches = raw.get('matches') or []

        return {
            'source_url': url,
            'fixture_name': name,
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
                {'text': m.get('text',''), 'ref': m.get('ref',''), 'type': m.get('type','')}
                for m in matches
            ],
        }
    finally:
        page.close()


def main():
    parser = argparse.ArgumentParser(description='Run extension against live URL')
    parser.add_argument('url', help='Live page URL')
    parser.add_argument('--name', required=True, help='Fixture name for comparison (e.g. 238996)')
    parser.add_argument('--write-observed', action='store_true', help='Save observed output')
    args = parser.parse_args()

    with sync_playwright() as pw:
        print("Loading extension in Chromium…")
        context = load_extension(pw)
        time.sleep(2.0)

        try:
            observed = run_live(context, args.url, args.name)

            fx_path = FIXTURES_DIR / f'{args.name}.html'

            if args.write_observed:
                write_observed(observed, fx_path)
                print("Observed output written.")
                return

            exp_file = expected_path(fx_path)
            if not exp_file.exists():
                print("No expected file — writing observed for review.")
                write_observed(observed, fx_path)
                return

            expected = json.loads(exp_file.read_text(encoding='utf-8'))
            cmp = compare_results(observed, expected)

            print(f"\nStats (live): {observed['stats']}")
            if cmp['passed']:
                print("PASS — live URL matches expected fixture output")
            else:
                print("FAIL — differences from expected:")
                for d in cmp['diffs']:
                    print(d)
                sys.exit(1)
        finally:
            context.close()


if __name__ == '__main__':
    main()
