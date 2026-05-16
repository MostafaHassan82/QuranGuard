"""Quick diagnostic — checks if extension loads and content script injects."""
import sys, time
from pathlib import Path

TESTS_DIR = Path(__file__).parent
PROJECT_DIR = TESTS_DIR.parent

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("ERROR: pip install playwright && playwright install chromium")
    sys.exit(1)


def main():
    with sync_playwright() as pw:
        ext_path = str(PROJECT_DIR.resolve())
        print(f"Loading extension from: {ext_path}")

        context = pw.chromium.launch_persistent_context(
            user_data_dir=str(TESTS_DIR / 'browser_profile_diag'),
            headless=False,
            args=[
                f'--disable-extensions-except={ext_path}',
                f'--load-extension={ext_path}',
                '--no-first-run',
                '--no-default-browser-check',
            ],
        )
        time.sleep(2)

        # Check service workers
        sws = context.service_workers
        print(f"Service workers: {[sw.url for sw in sws]}")

        # Navigate to a simple test page via local server
        import http.server, threading, socket

        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            port = s.getsockname()[1]

        class H(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *a): pass
            def __init__(self, *a, **kw):
                super().__init__(*a, directory=str(TESTS_DIR), **kw)

        srv = http.server.HTTPServer(('127.0.0.1', port), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        print(f"HTTP server at port {port}")

        page = context.new_page()

        # Capture console messages
        logs = []
        page.on('console', lambda msg: logs.append(f"[{msg.type}] {msg.text}"))
        page.on('pageerror', lambda err: logs.append(f"[ERROR] {err}"))

        # Write a minimal test page to TESTS_DIR
        simple_html = (TESTS_DIR / 'simple_test.html')
        simple_html.write_text(
            '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>'
            '<body><p>قال تعالى: {بسم الله الرحمن الرحيم} (الفاتحة:1)</p></body></html>',
            encoding='utf-8'
        )

        url = f'http://127.0.0.1:{port}/simple_test.html'
        print(f"Navigating to simple page: {url}")
        try:
            page.goto(url, wait_until='domcontentloaded', timeout=15000)
        except Exception as e:
            print(f"Navigation error: {e}")

        time.sleep(4)

        result = page.evaluate("() => ({ quranScan: typeof window.__quranScan, quranStats: typeof window.__quranStats, body: !!document.body })")
        print(f"Window globals on simple page: {result}")

        print(f"Console logs ({len(logs)}):")
        for log in logs:
            print(f"  {log}")

        simple_html.unlink(missing_ok=True)

        context.close()


if __name__ == '__main__':
    main()
