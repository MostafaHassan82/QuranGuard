# Accessibility Audit — V1 (T079)

Scope: keyboard-only operation of every panel action (FR-030), screen-reader
exposure of highlights and tooltips (FR-005, FR-007, FR-032), and Esc semantics.
This pass is a **code-level audit** of the shipped DOM/ARIA contracts; a manual
screen-reader walkthrough (NVDA/VoiceOver) is still required before release and
is listed as an open item at the end.

Date: 2026-05-20 · Reviewer: implementation pass.

## 1. Highlights on the page (content.js → wrapTextNodes)

Each highlight wrapper is created with:

- `role="mark"` — conveys "highlighted" to assistive tech.
- `tabindex="0"` — reachable by keyboard Tab.
- `aria-label = "<category name in Arabic>. <tooltip>"` — e.g.
  «مرجع غير مطابق. مذكور كـ: البقرة:105 — الصواب: البقرة:106».

Findings:

- ✅ FR-005 / FR-007: the category is announced **in words** (not by color
  alone) via `aria-label`, and the tooltip text (cited→true reference) is folded
  into the same label, so a screen-reader user hears the full verdict on focus.
- ⚠️ FR-032 wording asks for an `aria-describedby` round-trip. The implementation
  uses `aria-label` instead of `aria-describedby` + a referenced description node.
  This is an intentional, defensible deviation: `aria-label` avoids injecting a
  second DOM node (which the convergence loop / MutationObserver would have to
  filter) and avoids the swap engine accidentally concatenating description text
  into the visible span. The user-facing outcome (category + reason announced) is
  equivalent or better. **Recommendation:** update FR-032's wording to accept
  `aria-label`, or add `aria-describedby` only if a specific AT fails to announce
  the label. No functional gap observed.

## 2. Findings panel rows (popup-surface.js / sidebar-surface.js)

Each row:

- `role="button"` + `tabindex="0"` + `aria-label` (category + snippet + refs).
- Per-row action buttons are real `<button>` elements (focusable, named).

Findings:

- ✅ Rows are reachable and self-describing.
- ✅ Action buttons (تصحيح / نسخ / مشاركة / تقرير / JSON / تجاهل / استرجاع) are
  native buttons with visible text labels.

## 3. Keyboard model (keyboard.js, FR-030)

Scoped handler fires only while focus is inside the panel root:

| Key            | Action                                                        |
|----------------|---------------------------------------------------------------|
| ↑ / ↓          | Move row focus through every section in render order          |
| Enter          | Primary action: jump-to-highlight (focus stays on the row)    |
| C / S / R / J  | Copy / Share / Report / copy-as-JSON                          |
| F              | Correct-in-place (orange rows)                                |
| D              | Dismiss                                                       |
| Space          | Toggle the focused filter chip; otherwise consumed (no scroll)|
| Esc            | 1st press → focus the panel root; 2nd press → leave the panel |

Findings:

- ✅ Modifier chords (Ctrl/⌘/Alt) are explicitly ignored, so OS copy (Ctrl+C)
  and shortcuts are never hijacked.
- ✅ Space always `preventDefault()`s inside the panel, so the host page never
  page-scrolls out from under the user.
- ✅ Enter does **not** steal focus to the page highlight, so ↑/↓ navigation
  continues after a jump.
- ✅ Two-stage Esc matches the spec; the sidebar's second Esc blurs back to the
  host page, the popup's returns focus to the popup root.
- ✅ Alt+Shift+Q (page-global) pulls focus back into the sidebar's first row from
  anywhere on the host page (`aria-keyshortcuts="Alt+Shift+Q"` advertises it).

## 4. Sidebar surface (collapsible / resizable)

- ✅ Collapse button is a named `<button>` (`aria-label="طيّ اللوحة"`).
- ✅ The collapsed tab is a `role="button"` + `tabindex="0"` element that opens on
  Enter/Space as well as click.
- ✅ The resize handle is `role="separator"` + `aria-orientation="vertical"` +
  `aria-label`. **Gap:** it is mouse-drag only — no keyboard resize (arrow keys).
  Low severity (width is a convenience; collapse/expand is keyboard-reachable).
- ✅ Page → panel: clicking a highlight focuses the matching row (auto-expands if
  collapsed), complementing the row → page jump.
- Note: the close (X) button was removed; the sidebar can only be collapsed, so
  there is no "accidentally dismissed, can't get back" trap.

## 5. Popup (scan-only)

- ✅ Scan-mode and initial-panel-state are native radio groups with `<label>`s.
- ✅ Status uses a visible `#status` line; progress count updates live.
- ⚠️ `#status` / progress are not wrapped in an `aria-live` region, so a
  screen-reader user is not automatically notified when a scan completes. The
  sidebar's `.quran-ext-persist-status` IS `aria-live="polite"`. **Recommendation
  (low):** add `aria-live="polite"` to the popup `#status` element.

## Open items (require manual verification)

1. NVDA + Chrome screen-reader walkthrough of: highlight focus announcements,
   panel row announcements, and section headings.
2. Confirm RTL focus order in the panel matches visual order.
3. Decide FR-032 wording: accept `aria-label` (current) or require
   `aria-describedby`.
4. (Low) add `aria-live="polite"` to the popup `#status`.
5. (Low) optional keyboard resize for the sidebar separator.

No blocking accessibility defects found in the code-level pass; the open items
are low-severity polish plus a required manual SR confirmation.
