'use strict';
/*
 * Shared tooltip builder for verdict decorations.
 *
 * Lifted from js/content.js (buildTooltip) so the reader-side classifier and
 * the writer-side compose path both produce identical tooltip text from the
 * same per-color formula. Self-contained: depends only on QuranI18n; the
 * caller passes the same `result` shape buildTooltip historically accepted.
 *
 * Exposed as the QuranTooltip global.
 */
const QuranTooltip = (() => {
  function t(key, vars) {
    return (typeof QuranI18n !== 'undefined') ? QuranI18n.t(key, vars) : key;
  }
  function canonicalRef(refString) {
    if (!refString) return '';
    return refString
      .replace(/^[\s({«\[﴿]+|[\s)}»\]﴾]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function build(color, result) {
    const r = result || {};
    switch (color) {
      case 'green': {
        let tip = r.matchedRef || t('tip_match');
        const exact = r.allExactRefs || [];
        const partial = r.allPartialRefs || [];
        const otherExact = exact.filter(ref => ref !== r.matchedRef);
        if (otherExact.length > 0) tip += '\n' + t('tip_also_in', { refs: otherExact.join(' • ') });
        if (partial.length > 0) tip += '\n' + t('tip_partial_in', { refs: partial.join(' • ') });
        return tip;
      }
      case 'lightBlue': {
        const refs = r.matchedRefs && r.matchedRefs.length > 1
          ? r.matchedRefs.join(' • ')
          : (r.matchedRef || '');
        return refs + '\n' + t('tip_no_ref');
      }
      case 'yellow': {
        const matched = r.matchedRef || '';
        const claimed = r.claimedRef || '';
        const refsDiffer = claimed && canonicalRef(claimed) !== canonicalRef(matched);
        const note = refsDiffer
          ? '\n' + t('tip_word_level_and_ref', { cited: claimed })
          : '\n' + t('tip_word_level');
        return matched + note;
      }
      case 'lightGreen':
        return t('tip_corrected', { from: r.correctedFromRef || '?', to: r.matchedRef || '?' });
      case 'orange':
        return t('tip_orange', { cited: r.claimedRef || '?', matched: r.matchedRef || '?' });
      case 'red':
        return r.claimedRef
          ? t('tip_red_with_ref', { ref: r.claimedRef })
          : t('tip_red');
      default:
        return '';
    }
  }

  return { build, canonicalRef };
})();
