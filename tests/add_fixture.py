"""
Create a new test fixture from a URL.

Usage:
    python tests/add_fixture.py "https://www.islamweb.net/ar/article/174389/..." --name 174389
    python tests/add_fixture.py "https://..." --name 238996 --rendered --scan
"""

import argparse
import sys
import time
from pathlib import Path

TESTS_DIR = Path(__file__).parent
FIXTURES_DIR = TESTS_DIR / 'fixtures'

try:
    import requests
except ImportError:
    print("ERROR: requests not installed. Run: pip install requests")
    sys.exit(1)


def fetch_raw(url: str) -> str:
    """Fetch page HTML with a plain HTTP GET."""
    headers = {
        'User-Agent': (
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
            'AppleWebKit/537.36 (KHTML, like Gecko) '
            'Chrome/120.0.0.0 Safari/537.36'
        ),
        'Accept-Language': 'ar,en;q=0.9',
    }
    resp = requests.get(url, headers=headers, timeout=20)
    resp.raise_for_status()
    resp.encoding = resp.apparent_encoding or 'utf-8'
    return resp.text


def fetch_rendered(url: str) -> str:
    """Fetch fully-rendered page HTML using Playwright (handles JS-rendered content)."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("ERROR: Playwright not installed. Run: pip install playwright && playwright install chromium")
        sys.exit(1)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(url, wait_until='networkidle', timeout=30000)
        time.sleep(1.0)  # extra settle time
        html = page.content()
        browser.close()
        return html


def save_fixture(html: str, name: str) -> Path:
    FIXTURES_DIR.mkdir(exist_ok=True)
    path = FIXTURES_DIR / f'{name}.html'
    path.write_text(html, encoding='utf-8')
    print(f"Saved fixture: {path}")
    return path


def main():
    parser = argparse.ArgumentParser(description='Create a new test fixture from a URL')
    parser.add_argument('url', help='Page URL to fetch')
    parser.add_argument('--name', required=True, help='Fixture name (e.g. 174389)')
    parser.add_argument('--rendered', action='store_true',
                        help='Use Playwright to fetch the rendered DOM instead of raw HTML')
    parser.add_argument('--scan', action='store_true',
                        help='After saving, run the extension against the fixture and write initial expected JSON')
    args = parser.parse_args()

    print(f"Fetching: {args.url}")
    if args.rendered:
        print("Mode: rendered (Playwright)")
        html = fetch_rendered(args.url)
    else:
        print("Mode: raw HTML")
        html = fetch_raw(args.url)

    fx_path = save_fixture(html, args.name)

    if args.scan:
        print("Running extension against saved fixture…")
        # Import run_fixture from run_tests
        sys.path.insert(0, str(TESTS_DIR))
        from run_tests import load_extension, run_fixture, write_observed
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            print("ERROR: Playwright not installed.")
            sys.exit(1)

        with sync_playwright() as pw:
            context = load_extension(pw)
            time.sleep(2.0)
            try:
                observed = run_fixture(context, html, source_label=args.name)
                observed['source_url'] = args.url
                observed['fixture_name'] = args.name
                write_observed(observed, fx_path)
                print("Initial expected JSON written (review before accepting).")
            finally:
                context.close()


if __name__ == '__main__':
    main()
