# Contract — Window Globals (Writer-Side Autocomplete test hook)

Mirrors the feature-001 observability pattern (`window.__quranScan` etc.) so the Node/Playwright gate can assert writer-side behavior off the real JS without reimplementing it. The content script writes a single hook object; tests read it after driving synthetic typing.

## `window.__quranCompose`

```jsonc
{
  "active": {                      // current CitationInProgress, or null
    "text": "string",
    "surface": "contenteditable",  // "input" | "textarea" | "contenteditable"
    "wordCount": 3,
    "isComposing": false,
    "state": "suggesting"          // idle|detecting|suggesting|scopeMenu|inserted|classified
  },
  "candidates": [                  // current dropdown candidates (ordered by rank)
    { "ref": "البقرة:255", "tier": "exact", "rank": 0 }
  ],
  "lastInsertion": {               // populated after an accept+scope confirm, else null
    "ref": "البقرة:255",
    "scope": "whole",              // "whole" | "typedPortion" | "startToEndWord"
    "insertedText": "string",      // authentic wording actually written
    "reference": "(البقرة:255)",   // formatted per refFormat/refPlacement
    "surface": "contenteditable",
    "persistedMarkup": true        // true in contenteditable (FR-018b), false in plain inputs
  },
  "lastClassification": {          // verdict applied to a recognized citation (dropdown or fall-through)
    "ref": "البقرة:255",
    "verdict": "green",            // green|lightBlue|yellow|orange|red (lightGreen if provenance)
    "viaFallthrough": false        // true when not resolved via the dropdown (FR-011a)
  }
}
```

## Notes
- `verdict` values come from the existing `js/verifier/classify.js`; the hook MUST NOT introduce a new verdict name (Principle II).
- The hook is for tests/observability only; it carries no behavior. It is written on every state transition so the gate can `await` a stable value.
- Plain-input cases set `persistedMarkup:false` and omit styling assertions (FR-018b).
