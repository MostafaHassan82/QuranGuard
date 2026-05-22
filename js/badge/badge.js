'use strict';
// T026 — Toolbar action badge state machine per FR-028.
// Consumes SCAN_START / SCAN_PROGRESS / SCAN_COMPLETE / SCAN_CAP_HIT /
//          DATA_UNAVAILABLE / DATA_AVAILABLE events.
// Exported as QuranBadge global (loaded via importScripts in SW).
const QuranBadge = (() => {
  // Priority order for defect severity: red > yellow > orange (most severe
  // first, per constitution Principle II — red is words not in the Quran,
  // orange is correct words with only a wrong reference).
  function severityColor(perCategoryCount) {
    if (!perCategoryCount) return '#888888';
    if ((perCategoryCount.red || 0) > 0) return '#CC0000';
    if ((perCategoryCount.yellow || 0) > 0) return '#D4A000';
    if ((perCategoryCount.orange || 0) > 0) return '#E67300';
    return '#4CAF50'; // all green/lightBlue — clean
  }

  function set(tabId, { text, color, title }) {
    const target = tabId ? { tabId } : {};
    if (text !== undefined) chrome.action.setBadgeText({ text, ...target }).catch(() => {});
    if (color !== undefined) chrome.action.setBadgeBackgroundColor({ color, ...target }).catch(() => {});
    if (title !== undefined) chrome.action.setTitle({ title, ...target }).catch(() => {});
  }

  function onScanStart(tabId) {
    set(tabId, { text: '●', color: '#888888', title: 'Scanning…' });
  }

  function onScanProgress(tabId, perCategoryCount, runningCount) {
    // FR-028: the badge is a glyph indicator, never a count. Show the in-progress
    // dot; the running count lives in the tooltip only.
    const col = severityColor(perCategoryCount);
    set(tabId, { text: '●', color: col, title: `Scanning… ${runningCount} finding(s)` });
  }

  function onScanComplete(tabId, finalState, perCategoryCount, totalCount) {
    if (finalState === 'notArabic' || finalState === 'empty') {
      set(tabId, { text: '', color: '#888888', title: 'Quran Citation Verifier — no citations found' });
      return;
    }
    if (finalState === 'clean') {
      set(tabId, { text: '✓', color: '#4CAF50', title: `Quran Citation Verifier — ${totalCount} verified` });
      return;
    }
    // defects
    const col = severityColor(perCategoryCount);
    const glyph = '!';
    const lines = [];
    if (perCategoryCount.orange) lines.push(`${perCategoryCount.orange} reference-mismatch`);
    if (perCategoryCount.red) lines.push(`${perCategoryCount.red} not-in-Quran`);
    if (perCategoryCount.yellow) lines.push(`${perCategoryCount.yellow} word-level deviation`);
    if (perCategoryCount.green) lines.push(`${perCategoryCount.green} verified`);
    if (perCategoryCount.lightBlue) lines.push(`${perCategoryCount.lightBlue} verified (no ref)`);
    if (perCategoryCount.lightGreen) lines.push(`${perCategoryCount.lightGreen} corrected`);
    set(tabId, { text: glyph, color: col, title: `Quran Citation Verifier — ${lines.join(', ')}` });
  }

  function onCapHit(tabId, perCategoryCount) {
    const col = severityColor(perCategoryCount);
    set(tabId, { text: '!', color: col, title: 'Quran Citation Verifier — cap hit (500 findings)' });
  }

  function onDataUnavailable(tabId, reason) {
    set(tabId, { text: '✗', color: '#CC0000', title: `Quran Citation Verifier — data error: ${reason}` });
  }

  function onDataAvailable(tabId) {
    set(tabId, { text: '', color: '#888888', title: 'Quran Citation Verifier' });
  }

  return { onScanStart, onScanProgress, onScanComplete, onCapHit, onDataUnavailable, onDataAvailable };
})();
