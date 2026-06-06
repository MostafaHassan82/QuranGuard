# Feature Specification: Appearance / Theme System

**Feature Branch**: `004-appearance-themes`

**Created**: 2026-06-06

**Status**: Draft

**Input**: User description: "Ship the Mihrab visual theme as an optional UI for the popup, options, and sidebar" — broadened to: ship a general appearance system that supports multiple selectable themes (Mihrab included), so additional visual treatments can be added later under the same framework.

## Clarifications

### Session 2026-06-06

- Q: When the user changes the theme on the options page while the popup or sidebar is already open in another window/tab, what is the expected behavior? → A: Live — the sidebar (and popup if open) re-applies the new theme within one frame via storage change observation; no user action required.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Choose a theme from the options page (Priority: P1)

A user opens the options page, finds a new "Appearance" section, and picks a theme from the available list. The popup, the options page itself, and the sidebar all immediately adopt the chosen theme — colors, typography, decorative elements, and overall visual treatment — without any extension reload or browser restart. The list always includes the existing default and at least one alternative; in this release the alternative is Mihrab.

**Why this priority**: This is the smallest end-to-end slice that delivers value. Without it, nothing the user can see ships. Every other story depends on the picker existing and being able to apply a theme across all three surfaces.

**Independent Test**: With the extension installed on a fresh profile, open the options page, change the appearance to a non-default theme, then open the popup and the sidebar against a known fixture page. All three surfaces should render in the chosen theme. Change the choice back to the default and confirm all three revert.

**Acceptance Scenarios**:

1. **Given** a user on the default theme, **When** they pick a different theme in the Appearance section, **Then** the options page re-renders in the chosen theme within one second without a page reload.
2. **Given** a user has just switched themes, **When** they open the popup on any tab, **Then** the popup renders in the chosen theme on first paint.
3. **Given** a user has just switched themes, **When** they open the sidebar on a page that already has an audit in progress, **Then** the sidebar adopts the chosen theme without losing the audit state or scroll position.
4. **Given** a user on a non-default theme, **When** they switch back to the default, **Then** all three surfaces revert and no theme-specific assets remain visually applied.

---

### User Story 2 - Preference survives across sessions and devices (Priority: P2)

The user's chosen theme persists. After closing and reopening the browser, after Chrome restarts, and after the extension's service worker is suspended and revived, the previously chosen theme is still in effect on the next popup or sidebar open. If the user has Chrome profile sync turned on for extension preferences, the appearance choice rides along with the other synced preferences.

**Why this priority**: Without persistence, the feature feels broken on every browser restart. Separable from Story 1 — Story 1 can be demoed with session-only state — but ship-quality requires this.

**Independent Test**: Pick a theme, fully close Chrome, reopen it, open the popup, and confirm the chosen theme is still active without any further user action.

**Acceptance Scenarios**:

1. **Given** the user picked a theme in a prior session, **When** they reopen the browser and open the popup, **Then** the popup renders in that theme on first paint with no flash of the default.
2. **Given** the service worker has been suspended, **When** the user opens the popup, **Then** the chosen theme is restored before first paint.

---

### User Story 3 - Default-untouched guarantee for users who do not opt in (Priority: P1)

A user who never visits the Appearance section — including every user upgrading from a prior version — continues to see exactly the existing UI. No visual element of the default popup, options page, or sidebar changes as a side effect of this feature shipping.

**Why this priority**: Non-negotiable. The shipped extension already has users; an uninvited visual change is a regression even if the new treatment is objectively nicer. Co-P1 with Story 1.

**Independent Test**: Install the new build on a profile that has the prior version installed and never touch the Appearance section. The popup, options, and sidebar must be visually identical to the prior release.

**Acceptance Scenarios**:

1. **Given** a user upgrading from the prior version, **When** they open any of the three surfaces, **Then** they see the previous default styling unchanged.
2. **Given** a fresh install with no prior preference, **When** the user opens any of the three surfaces, **Then** they see the default theme.

---

### User Story 4 - The system accommodates additional themes without re-architecture (Priority: P2)

A future contributor can add a new theme — a new named visual treatment that styles the popup, options, and sidebar — and have it appear in the Appearance picker without changing any cross-surface plumbing. The list of themes is data; adding one does not require editing the popup, options, or sidebar entry points.

**Why this priority**: This is the structural promise that justifies calling it an "Appearance system" rather than "an on/off Mihrab toggle." Five preview themes already exist in `design/` (atelier, diwan, marakeb, mihrab, tahrir); only Mihrab has been built across the three surfaces, and the system must let the others be added incrementally as they are completed. Lower than P1 because the feature can ship and deliver value with just default + Mihrab, but the architecture must be ready.

**Independent Test**: A developer adds a stub third theme (e.g., a single accent color change) following whatever the convention turns out to be, with no edits to the popup, options, or sidebar entry points beyond the theme's own asset, and the new theme appears in the picker and applies correctly.

**Acceptance Scenarios**:

1. **Given** the system as shipped, **When** a new theme is registered, **Then** it appears in the Appearance picker on the options page.
2. **Given** a newly registered theme is chosen, **When** any of the three surfaces is opened, **Then** that theme is applied without per-surface code changes.

---

### User Story 5 - Theme choice is discoverable and reversible (Priority: P3)

A user browsing the options page can find the Appearance section without being told where to look, can tell at a glance which theme is currently active, and can revert to the default without hunting through menus.

**Why this priority**: Quality-of-life. The feature works without polish here, but adoption suffers if users do not know the option exists or fear an irreversible change.

**Independent Test**: A first-time user, given only the instruction "change the look of the extension," locates and applies a non-default theme in under thirty seconds without external help.

**Acceptance Scenarios**:

1. **Given** a user on the options page, **When** they scan the page, **Then** the Appearance section is visible without scrolling past unrelated sections or expanding hidden panels.
2. **Given** the user is looking at the theme choices, **When** they look at the controls, **Then** they can tell which theme is currently active.

---

### Edge Cases

- A user has the popup open in one window and the sidebar open in another when the theme is changed from the options page — both reflect the change live, within one frame, without any user action on those surfaces.
- The stored preference is missing, corrupt, or refers to an unknown theme (for example, a theme name from a future build the user has rolled back from) — the system falls back to the default silently and does not surface an error.
- The user changes the theme during an active audit run with verdicts streaming into the sidebar — re-styling must not interrupt or visually corrupt in-flight rendering.
- Browser-level forced-colors or high-contrast mode is active — every selectable theme must remain readable; if a theme cannot honor the OS contrast mode, it falls back to a readable presentation rather than vanishing controls.
- The user has Chrome profile sync off — the preference still persists locally and survives browser restarts on the same device.
- A theme bundles custom font assets (Mihrab ships Amiri Arabic 400/700) — if a font fails to load (offline, blocked), text remains readable via system fallbacks.
- The user picks a theme that is later removed in a future release — on the next load, the system silently falls back to the default and updates the stored preference.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose an "Appearance" section on the options page containing a picker for the active theme.
- **FR-002**: The Appearance picker MUST list at least the existing default theme and one additional theme. In this release, the additional theme MUST be Mihrab.
- **FR-003**: The system MUST default the active theme to the existing default for every user who has not explicitly chosen otherwise, including all users upgrading from a prior version.
- **FR-004**: When the user changes the active theme, the system MUST apply the new theme to the options page, the popup, and the sidebar without requiring an extension reload or browser restart. Any of those surfaces that is already open at the moment of the change MUST re-apply the new theme live (within one frame), without waiting for further user interaction with that surface.
- **FR-005**: The system MUST persist the chosen theme across browser sessions and service-worker suspensions.
- **FR-006**: The system MUST apply the persisted theme on the first paint of the popup, options page, and sidebar, so there is no visible flash of an unintended theme.
- **FR-007**: The system MUST fall back to the default theme silently if the stored preference is missing, malformed, or refers to a theme name not present in the current build.
- **FR-008**: Every selectable theme MUST preserve the meaning, ordering, and behavior of every UI element — the verdict color taxonomy (green / light blue / yellow / orange / red plus light-green "corrected"), the severity ordering, all action buttons, all keyboard shortcuts. Themes change appearance, not function.
- **FR-009**: Every selectable theme MUST remain legible and usable under forced-colors or high-contrast OS modes, either by honoring those modes or by degrading gracefully to a readable presentation.
- **FR-010**: Every selectable theme MUST degrade gracefully when bundled font assets fail to load, falling back to system-available fonts without breaking layout.
- **FR-011**: The system MUST support adding new themes by registering them as data, without requiring edits to the popup, options, or sidebar entry points beyond the new theme's own assets.
- **FR-012**: Users MUST be able to revert to the default theme at any time from the same picker, and the revert MUST take effect on the three surfaces within the same response time as switching to a non-default theme.
- **FR-013**: The system MUST NOT transmit the theme preference, the rendered theme, or any related telemetry to any external service.
- **FR-014**: When Chrome profile sync is enabled for the user's extension preferences, the theme choice MUST ride along with the other synced preferences; when sync is disabled, the choice MUST still persist locally.

### Key Entities

- **Theme**: A named visual treatment (identifier + display name + asset references) that styles the popup, options, and sidebar. Carries no behavior — it changes only appearance. Themes are enumerable; the set is defined by the build, not by user input.
- **Appearance preference**: The user's chosen theme identifier. Lives alongside existing extension preferences. Has a defined fallback (default theme) for missing, invalid, or unknown values.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can change the active theme and see it applied to all three surfaces in under one second of confirming the choice, with no extension reload or browser restart.
- **SC-002**: The chosen theme is correctly restored on the next open of the popup, options page, and sidebar after a full browser restart on 100% of attempts.
- **SC-003**: 100% of users who do not interact with the Appearance section see the previous default UI unchanged after upgrading.
- **SC-004**: First-time users locate and apply a non-default theme in under thirty seconds when prompted to "change the look of the extension," measured during informal usability checks.
- **SC-005**: Zero user-facing functionality regressions are introduced under any selectable theme — every verdict color, severity, action, and keyboard shortcut behaves identically under all themes, validated by re-running the existing reader-side and writer-side test fixtures under each shipped theme.
- **SC-006**: No flash of the unintended theme is observable on first paint of any of the three surfaces under normal load conditions.
- **SC-007**: Adding a new theme requires changes only within that theme's own asset surface — no edits to the popup, options, or sidebar entry points — validated by adding a trivial stub theme during development.

## Assumptions

- The Mihrab visual treatment already implemented on this branch (arched titles, two-tone headings, verdict tile grid, sticky TOC, polished finding cards, Amiri Arabic font) is the canonical second theme that ships in this release. The atelier, diwan, marakeb, and tahrir previews in `design/` are real candidates for future addition under the same system, but are not in scope for this feature — only themes that have been built across all three surfaces (popup, options, sidebar) are selectable in the picker.
- The existing "default" theme is whatever the popup, options, and sidebar look like immediately prior to merging this feature — i.e., the styling shipped in the most recent published release.
- Persistence rides on the existing extension preferences storage (`prefs.v1` schema) so it inherits the existing local-only and sync-enabled behavior of other preferences. No new storage surface is introduced.
- The Appearance picker belongs on the options page, alongside other extension-wide preferences, not in the popup. The popup remains focused on the current page's audit.
- Font assets bundled with any theme (Amiri Arabic 400/700 for Mihrab; whatever future themes need) ship inside the extension package; no remote font loading is introduced.
- No telemetry of theme choice is collected, consistent with the project's existing privacy posture (see `PRIVACY.md`).
