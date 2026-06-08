# Theme fonts — bundling checklist

Each appearance theme in feature 004 bundles its hero font in this folder. Themes degrade gracefully to system fallbacks per FR-010 if a binary is missing (`font-display: swap` + a system fallback chain in the `font-family` declaration), so a theme is selectable and readable even before its woff2 lands here — it just won't look exactly like the design preview.

**Status as of 2026-06-07**: all 16 face files bundled. Source for the new 11 (atelier/diwan/marakeb/shared-mono + Noto Naskh Arabic 400/500 for atelier body): Fontsource CDN (jsdelivr mirror), Latin subset (or Arabic subset for the Naskh/Amiri faces). Each file 13–108 KB.

| Theme | File | Source | Status |
|---|---|---|---|
| Mihrab | `amiri-arabic-400.woff2` | Google Fonts → Amiri | **bundled** |
| Mihrab | `amiri-arabic-700.woff2` | Google Fonts → Amiri | **bundled** |
| Mihrab | `el-messiri-arabic-400.woff2` | Google Fonts → El Messiri | **bundled** |
| Mihrab | `el-messiri-arabic-600.woff2` | Google Fonts → El Messiri | **bundled** |
| Mihrab | `reem-kufi-arabic-600.woff2` | Google Fonts → Reem Kufi | **bundled** |
| Atelier | `fraunces-400.woff2` | Google Fonts → Fraunces | **bundled** |
| Atelier | `fraunces-italic-300.woff2` | Google Fonts → Fraunces | **bundled** |
| Atelier | `fraunces-italic-400.woff2` | Google Fonts → Fraunces | **bundled** |
| Diwan | `hanken-grotesk-400.woff2` | Google Fonts → Hanken Grotesk | **bundled** |
| Diwan | `hanken-grotesk-500.woff2` | Google Fonts → Hanken Grotesk | **bundled** |
| Diwan | `hanken-grotesk-600.woff2` | Google Fonts → Hanken Grotesk | **bundled** |
| Marakeb | `jetbrains-mono-400.woff2` | Google Fonts → JetBrains Mono | **bundled** |
| Marakeb | `jetbrains-mono-700.woff2` | Google Fonts → JetBrains Mono | **bundled** |
| Shared (atelier/diwan/tahrir labels) | `dm-mono-400.woff2` | Google Fonts → DM Mono | **bundled** |
| Tahrir | (reuses `amiri-arabic-{400,700}.woff2`) | — | already bundled |

Subset Latin faces to Basic Latin + numerals + common punctuation. Target ≤ 80 KB per woff2. Add files with `git add resources/fonts/<name>.woff2` and flip the row to **bundled**; no CSS edit needed (the `@font-face` declarations already reference the expected paths).
