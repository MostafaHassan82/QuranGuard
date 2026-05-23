#!/usr/bin/env python3
"""Convert verified browser tabs into test fixtures from their console [stats] lines.

Paste the extension's `[QuranExt][stats]` console output (one JSON object per
line, with or without the `log.js:NN [QuranExt][stats]` prefix) and this script:

  1. Parses each line -> { id, sourceUrl, stats }  (dedupes repeats).
  2. For a NEW id: fetches the page HTML (-> tests/fixtures/<id>.html) and writes
     a stats-only tests/fixtures/<id>.expected.json (with sourceUrl + fixture).
  3. For an EXISTING id: compares the live stats to the saved expected.json
     (MATCH / DIFF) and backfills sourceUrl/fixture metadata if missing.
  4. Runs the Node harness (run_tests_node.js --all) to validate that each
     fetched fixture reproduces its stats, then prints a summary table.

Usage:
    python tests/sync_fixtures.py < batch.txt
    python tests/sync_fixtures.py batch.txt
    pbpaste | python tests/sync_fixtures.py        # (or paste then Ctrl-D / Ctrl-Z)

Notes:
  - HTML is fetched with TLS verification OFF (--secure to re-enable): some
    article hosts fail local cert validation; the harness re-verifies the stats
    anyway, so a bad fetch surfaces as a FAIL row, not a silently-wrong fixture.
  - Stats-only fixtures (no `matches`) validate counts only; run_tests_node.js
    skips the match-level check when `matches` is absent.
"""
import argparse
import io
import json
import os
import re
import subprocess
import sys
import urllib.request
import urllib.error
import ssl
from collections import OrderedDict

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(TESTS_DIR)
FIXTURES_DIR = os.path.join(TESTS_DIR, 'fixtures')
STAT_KEYS = ['greenMatches', 'lightBlueMatches', 'yellowMatches', 'orangeMatches', 'redMatches', 'totalFindings']
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')


def parse_batch(text):
    """Extract the JSON object from each [stats] line; dedupe by id (last wins)."""
    out = OrderedDict()
    for line in text.splitlines():
        m = re.search(r'\{.*\}\s*$', line.strip())
        if not m:
            continue
        try:
            obj = json.loads(m.group(0))
        except json.JSONDecodeError:
            continue
        if not obj.get('id') or 'stats' not in obj:
            continue
        out[obj['id']] = obj  # dedupe; last occurrence wins
    return list(out.values())


def short_stats(s):
    """g50/lb15/65 — show only nonzero colors, then total."""
    parts = []
    for key, tag in [('greenMatches', 'g'), ('lightBlueMatches', 'lb'), ('yellowMatches', 'y'),
                     ('orangeMatches', 'o'), ('redMatches', 'r')]:
        if s.get(key):
            parts.append(f'{tag}{s[key]}')
    parts.append(str(s.get('totalFindings', 0)))
    return '/'.join(parts)


def stats_only(s):
    return {k: int(s.get(k, 0)) for k in STAT_KEYS}


def fetch_html(url, verify):
    ctx = None if verify else ssl._create_unverified_context()
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.9'})
    with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
        raw = r.read()
    # Decode: honor a charset header, else assume UTF-8 (these pages are UTF-8).
    enc = 'utf-8'
    ctype = r.headers.get('Content-Type', '') if hasattr(r, 'headers') else ''
    m = re.search(r'charset=([\w-]+)', ctype)
    if m:
        enc = m.group(1)
    return raw.decode(enc, errors='replace')


def run_harness():
    """Run the Node harness; return {id: 'PASS'|'FAIL'} parsed from its output."""
    try:
        p = subprocess.run(['node', os.path.join('tests', 'run_tests_node.js'), '--all'],
                           cwd=PROJECT_DIR, capture_output=True, text=True, timeout=400)
    except Exception as e:
        print(f'  (harness did not run: {e})')
        return {}
    res = {}
    for line in (p.stdout + p.stderr).splitlines():
        m = re.match(r'\[([^\]]+)\]\s+(PASS|FAIL)', line.strip())
        if m:
            res[m.group(1)] = m.group(2)
    return res


# ── table rendering ───────────────────────────────────────────────────────────
def _w(s):
    # Display width: count emoji/✅⚠️❌ as 2 columns so the box stays aligned.
    return sum(2 if ch in '✅⚠️❌🆕' else 1 for ch in s)


def render_table(rows, headers):
    cols = list(zip(*([headers] + rows))) if rows else [[h] for h in headers]
    widths = [max(_w(str(c)) for c in col) for col in cols]

    def cell(s, w):
        return ' ' + str(s) + ' ' * (w - _w(str(s)) + 1)

    def bar(l, m, r):
        return l + m.join('─' * (w + 2) for w in widths) + r
    lines = [bar('┌', '┬', '┐'),
             '│' + '│'.join(cell(h, w) for h, w in zip(headers, widths)) + '│',
             bar('├', '┼', '┤')]
    for i, row in enumerate(rows):
        lines.append('│' + '│'.join(cell(c, w) for c, w in zip(row, widths)) + '│')
        if i < len(rows) - 1:
            lines.append(bar('├', '┼', '┤'))
    lines.append(bar('└', '┴', '┘'))
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser(description='Sync verified tabs into fixtures from their [stats] lines')
    ap.add_argument('input', nargs='?', help='File with [stats] lines (default: stdin)')
    ap.add_argument('--secure', action='store_true', help='Enable TLS verification on fetch (off by default)')
    ap.add_argument('--no-validate', action='store_true', help='Skip running the Node harness')
    args = ap.parse_args()

    text = open(args.input, encoding='utf-8').read() if args.input else sys.stdin.read()
    items = parse_batch(text)
    if not items:
        print('No [stats] lines found in input.')
        return 1

    os.makedirs(FIXTURES_DIR, exist_ok=True)
    created, matched, diffs, errors = [], [], [], []

    for it in items:
        fid, url, stats = it['id'], it.get('sourceUrl', ''), stats_only(it['stats'])
        exp_path = os.path.join(FIXTURES_DIR, f'{fid}.expected.json')
        html_path = os.path.join(FIXTURES_DIR, f'{fid}.html')

        if os.path.exists(exp_path):
            cur = json.load(open(exp_path, encoding='utf-8'))
            cur_stats = {k: int(cur.get('stats', {}).get(k, 0)) for k in STAT_KEYS}
            if cur_stats == stats:
                # backfill metadata if missing, preserving stats + matches
                if 'sourceUrl' not in cur or 'fixture' not in cur:
                    out = OrderedDict([('sourceUrl', url or cur.get('sourceUrl', '')),
                                       ('fixture', f'{fid}.html')])
                    for k in cur:
                        if k not in out:
                            out[k] = cur[k]
                    open(exp_path, 'w', encoding='utf-8').write(json.dumps(out, ensure_ascii=False, indent=2) + '\n')
                matched.append((fid, stats))
            else:
                bad = [f'{k}: saved {cur_stats[k]} vs live {stats[k]}' for k in STAT_KEYS if cur_stats[k] != stats[k]]
                diffs.append((fid, stats, '; '.join(bad)))
            continue

        # NEW fixture: fetch HTML + write stats-only expected.json
        if not os.path.exists(html_path):
            if not url:
                errors.append((fid, stats, 'no sourceUrl to fetch'))
                continue
            try:
                html = fetch_html(url, args.secure)
            except (urllib.error.URLError, ssl.SSLError, Exception) as e:
                errors.append((fid, stats, f'fetch failed: {e}'))
                continue
            open(html_path, 'w', encoding='utf-8').write(html)
        obj = OrderedDict([('sourceUrl', url), ('fixture', f'{fid}.html'), ('stats', stats)])
        open(exp_path, 'w', encoding='utf-8').write(json.dumps(obj, ensure_ascii=False, indent=2) + '\n')
        created.append((fid, stats))

    # Validate via the harness (fetched HTML must reproduce the stats).
    harness = {} if args.no_validate else run_harness()

    def verdict(fid):
        if args.no_validate:
            return ''
        r = harness.get(fid)
        return ' & validated ✅' if r == 'PASS' else (' but stats MISMATCH ❌' if r == 'FAIL' else ' (not validated)')

    rows = []
    for fid, stats in created:
        rows.append((f'{fid} ({short_stats(stats)})', f'new → created{verdict(fid)}'))
    for fid, stats, why in diffs:
        rows.append((f'{fid} ({short_stats(stats)})', f'EXISTS but DIFF ⚠️  {why}'))
    for fid, stats, why in errors:
        rows.append((f'{fid} ({short_stats(stats)})', f'ERROR ❌ {why}'))
    if matched:
        ids = ', '.join(fid for fid, _ in matched)
        rows.append((ids, 'existed → stats MATCH, metadata ok ✅'))

    print('\nFixture sync results\n')
    print(render_table(rows, ['your line', 'result']))
    print(f'\n  created={len(created)}  matched={len(matched)}  diffs={len(diffs)}  errors={len(errors)}')
    if not args.no_validate:
        total = sum(1 for v in harness.values() if v == 'PASS')
        print(f'  harness: {total}/{len(harness)} fixtures passed')
    if created or matched:
        print('\n  Review the new/updated files, then commit tests/fixtures/.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
