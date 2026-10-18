/* FSRS-5 scheduler (Free Spaced Repetition Scheduler), default parameters.
   Formulas follow the open FSRS-5 specification (open-spaced-repetition). */
(function (root) {
  'use strict';
  var W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046,
    1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898,
    0.51655, 0.6621];
  var DECAY = -0.5;
  var FACTOR = 19 / 81; // makes R = 0.9 when t = S
  var DAY = 86400000;

  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }

  // Probability of recall after t days with stability s
  function retrievability(t, s) { return Math.pow(1 + FACTOR * t / s, DECAY); }

  function initDifficulty(g) { return clamp(W[4] - Math.exp(W[5] * (g - 1)) + 1, 1, 10); }

  function nextDifficulty(d, g) {
    var delta = -W[6] * (g - 3);
    var dp = d + delta * (10 - d) / 9;                 // linear damping
    return clamp(W[7] * initDifficulty(4) + (1 - W[7]) * dp, 1, 10); // mean reversion
  }

  function recallStability(d, s, r, g) {
    var hard = g === 2 ? W[15] : 1;
    var easy = g === 4 ? W[16] : 1;
    return s * (Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) *
      (Math.exp(W[10] * (1 - r)) - 1) * hard * easy + 1);
  }

  function forgetStability(d, s, r) {
    var sf = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
    return Math.min(sf, s);
  }

  // Same-day (short-term) review
  function shortTermStability(s, g) { return s * Math.exp(W[17] * (g - 3 + W[18])); }

  function intervalDays(s, retention, maxInterval) {
    var i = s / FACTOR * (Math.pow(retention, 1 / DECAY) - 1);
    return clamp(Math.round(i), 1, maxInterval);
  }

  // Deterministic +/-5% spread so cards learned together don't all come due together
  function fuzz(ivl, seed) {
    if (ivl < 3) return ivl;
    var spread = Math.max(1, Math.round(ivl * 0.05));
    var u = (Math.abs(seed) % 10007) / 10006; // 0..1
    return ivl + Math.round((u * 2 - 1) * spread);
  }

  /**
   * Apply one review.
   * st:  previous state {s, d, last, due, reps, lapses, state} or null for a new card
   * g:   1 Again, 2 Hard, 3 Good, 4 Easy
   * now: ms timestamp
   * opt: {retention, maxInterval, relearnMinutes, seed}
   */
  function review(st, g, now, opt) {
    opt = opt || {};
    var retention = opt.retention || 0.9;
    var maxInterval = opt.maxInterval || 36500;
    var relearnMinutes = opt.relearnMinutes || 10;
    var s, d;
    var isNew = !st;
    if (isNew) {
      s = W[g - 1];
      d = initDifficulty(g);
    } else {
      var t = Math.max(0, (now - st.last) / DAY);
      if (t < 1) {
        s = shortTermStability(st.s, g);
      } else {
        var r = retrievability(t, st.s);
        s = g === 1 ? forgetStability(st.d, st.s, r) : recallStability(st.d, st.s, r, g);
      }
      d = nextDifficulty(st.d, g);
    }
    s = Math.max(0.01, s);
    var out = {
      s: s, d: d, last: now,
      reps: (isNew ? 0 : st.reps) + 1,
      lapses: (isNew ? 0 : st.lapses) + (!isNew && g === 1 && st.state === 'review' ? 1 : 0)
    };
    if (g === 1) {
      out.due = now + relearnMinutes * 60000;
      out.state = isNew || st.state === 'learning' ? 'learning' : 'relearning';
    } else {
      var ivl = clamp(fuzz(intervalDays(s, retention, maxInterval), opt.seed || 0), 1, maxInterval);
      out.due = now + ivl * DAY;
      out.state = 'review';
    }
    return out;
  }

  var api = { review: review, retrievability: retrievability, intervalDays: intervalDays, W: W, DAY: DAY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FSRS = api;
})(this);
