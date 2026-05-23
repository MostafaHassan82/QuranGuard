#!/usr/bin/env python3
"""Strip the full Quran data file down to only the fields the index build reads.

QuranIndexes.build (js/verifier/indexes.js) consumes exactly:
  - meta.chaptersNames
  - suras[].index, suras[].name
  - suras[].ayas[].index, suras[].ayas[].text

The full *_desc-v2.json also carries a per-ayah `words` array that nothing in
js/ reads; it accounts for ~87% of the file and dominated service-worker
cold-start (fetch + JSON.parse of 11.3MB). The minimal output is ~1.5MB.

Usage:  python scripts/build-min-json.py
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "resources", "quran-uthmani_desc-v2.json")
DST = os.path.join(ROOT, "resources", "quran-uthmani_min-v2.json")


def main():
    with open(SRC, encoding="utf-8") as f:
        d = json.load(f)

    minimal = {
        "meta": {"chaptersNames": d["meta"]["chaptersNames"]},
        "suras": [
            {
                "index": su["index"],
                "name": su["name"],
                "ayas": [{"index": ay["index"], "text": ay["text"]} for ay in su["ayas"]],
            }
            for su in d["suras"]
        ],
    }

    with open(DST, "w", encoding="utf-8") as f:
        json.dump(minimal, f, ensure_ascii=False, separators=(",", ":"))

    suras = len(minimal["suras"])
    ayas = sum(len(s["ayas"]) for s in minimal["suras"])
    print(f"wrote {DST}")
    print(f"  {os.path.getsize(DST):,} bytes (orig {os.path.getsize(SRC):,})")
    print(f"  suras={suras} ayas={ayas}")


if __name__ == "__main__":
    main()
