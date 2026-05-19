// Injected into the page's MAIN world via a src-based <script> so it complies
// with strict CSPs (which block inline script text). Exposes window.__quranDebug
// in the page console; the call dispatches a DOM event that the content script
// (isolated world) listens for to flip its trace flag.
window.__quranDebug = function (on) {
  document.dispatchEvent(new CustomEvent('__quranDebugSet', { detail: { on: !!on } }));
};
