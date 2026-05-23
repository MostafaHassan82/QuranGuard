'use strict';
// Leveled logger shared by the service worker (importScripts) and the content
// script (manifest content_scripts). One knob controls how chatty the console
// is, so diagnostics stay in the code but are silent unless you raise the level.
//
// Levels (higher = more output; each includes the ones below it):
//   0 silent   — nothing
//   1 error    — console.error only
//   2 warn     — + console.warn
//   3 info     — + lifecycle & per-scan summaries (worker boot, "Index ready",
//                  the [QuranExt][timing] line, the autoscan summary)   ← DEFAULT
//   4 debug    — + heavier diagnostics: the per-batch [bgprofile] breakdown,
//                  the per-finding dump, autoscan per-attempt timings,
//                  convergence ("stable at") logs
//   5 trace    — + the noisiest: SW eval marker, per-candidate [QD:] traces
//
// Change at runtime in either console:  QuranLog.setLevel('debug')   (or a number)
// Categories map to levels so "findings printing is its own level" etc. holds:
// findings/profile are `debug`, the SW-eval/QD traces are `trace`.
//
// Category tags: QuranLog.scope('autoscan').debug(...) prints
//   [QuranExt][autoscan] …   so you can filter the console by category.
// Bare QuranLog.info(...) prints just [QuranExt] … (no category).
const QuranLog = (() => {
  const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
  // Default: show lifecycle + per-scan summaries, hide the heavy diagnostics.
  let level = LEVELS.info;
  const BASE = '[QuranExt]';

  function setLevel(l) {
    const n = typeof l === 'string' ? LEVELS[l] : l;
    if (typeof n === 'number') { level = n; console.log(`${BASE} log level → ${n}`); }
    return level;
  }
  // True when a log at the given level (name or number) would be emitted — use
  // to guard expensive message-building (e.g. the [bgprofile] aggregation).
  function enabled(l) {
    const n = typeof l === 'string' ? LEVELS[l] : l;
    return level >= (typeof n === 'number' ? n : 99);
  }

  // Build a logger whose lines are prefixed [QuranExt][tag] (or just [QuranExt]
  // when tag is empty). The base QuranLog is `make('')`, plus setLevel/scope.
  function make(tag) {
    const prefix = tag ? `${BASE}[${tag}]` : BASE;
    return {
      error: (...a) => { if (level >= 1) console.error(prefix, ...a); },
      warn:  (...a) => { if (level >= 2) console.warn(prefix, ...a); },
      info:  (...a) => { if (level >= 3) console.log(prefix, ...a); },
      debug: (...a) => { if (level >= 4) console.log(prefix, ...a); },
      trace: (...a) => { if (level >= 5) console.log(prefix, ...a); },
    };
  }

  return Object.assign(make(''), {
    LEVELS,
    setLevel,
    enabled,
    get level() { return level; },
    scope: make,
  });
})();

// Expose on whichever global exists (service worker = self, page = window).
if (typeof self !== 'undefined') self.QuranLog = QuranLog;
if (typeof window !== 'undefined') window.QuranLog = QuranLog;
