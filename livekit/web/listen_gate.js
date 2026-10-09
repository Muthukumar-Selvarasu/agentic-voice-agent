/**
 * Decide whether microphone energy is the agent's own playback or the caller.
 *
 * The mic hears the speaker. A gate that decays between phrases treats the next
 * line of the same reply as an interruption; a gate that only rises never lets
 * the caller in. This envelope learns playback loudness (fast attack, slow
 * release) and confirms a barge-in only when energy stays up after playback
 * is ducked — echo falls with the duck, the caller does not.
 */

const RELEASE_MS = 2400;
// Slow on purpose. A fast attack chases a rising caller and the threshold
// stays above them, so a quiet room never accepts an interruption.
const ATTACK = 0.06;

export function createListenGate(seed = 0.02) {
  return {
    baseline: seed,
    phase: "idle",
    armAt: 0,
    duckedAt: 0,
    holdAt: 0,
    levelAtDuck: 0,
    baselineAtDuck: 0,
    refractoryUntil: 0,
    lastAt: 0,
  };
}

export function resetListenGate(state, seed = 0.02, now = 0) {
  state.baseline = seed;
  state.phase = "idle";
  state.armAt = 0;
  state.duckedAt = 0;
  state.holdAt = 0;
  state.levelAtDuck = 0;
  state.baselineAtDuck = 0;
  state.refractoryUntil = 0;
  state.lastAt = now;
}

export function listenThreshold(baseline, multiple, margin, cap) {
  return Math.min(cap, baseline * multiple + margin);
}

function trackBaseline(state, sample, dt) {
  if (sample >= state.baseline) {
    state.baseline += (sample - state.baseline) * ATTACK;
  } else {
    const decay = Math.exp(-dt / RELEASE_MS);
    state.baseline = Math.max(sample, state.baseline * decay);
  }
}

/**
 * @returns {{ action: "none" | "duck" | "restore" | "confirm", threshold: number, baseline: number }}
 */
export function stepListenGate(state, opts) {
  const now = opts.now;
  const sample = Math.min(0.22, Math.max(0, opts.level));
  const dt = state.lastAt ? Math.min(50, Math.max(0, now - state.lastAt)) : 16;
  state.lastAt = now;
  const threshold = listenThreshold(state.baseline, opts.multiple, opts.margin, opts.cap);
  const refractoryMs = opts.refractoryMs ?? 250;
  const confirmMultiple = opts.confirmMultiple ?? 1.40;
  const unduckedConfirmMultiple = opts.unduckedConfirmMultiple ?? 3.4;
  const result = (action) => ({ action, threshold, baseline: state.baseline });
  const learnEcho = (level) => {
    state.baseline = Math.max(state.baseline, level);
    state.phase = "idle";
    state.refractoryUntil = now + refractoryMs;
  };

  if (state.phase === "latched") {
    if (sample < threshold * 0.8) state.phase = "idle";
    else return result("none");
  }

  const learnOnly = !opts.audible
    || opts.playbackAgeMs < opts.armMs
    || now < state.refractoryUntil;
  if (learnOnly) {
    trackBaseline(state, sample, dt);
    state.phase = "idle";
    return result("none");
  }

  if ((state.phase === "settling" || state.phase === "holding") && opts.duckFailed) {
    // Playback did not actually get quieter, so this energy is still the agent.
    state.baseline = Math.max(state.baseline, state.levelAtDuck || sample);
    state.phase = "idle";
    state.refractoryUntil = now + refractoryMs;
    return result("restore");
  }

  if (state.phase === "settling") {
    if (now - state.duckedAt < opts.settleMs) return result("none");
    // Echo follows the volume cut. A rise that is only a bit above the learned
    // playback level and does not survive the duck is still the agent.
    const followedDuck = sample < state.levelAtDuck * 0.65;
    const clearlyCaller = (state.levelAtDuck >= state.baselineAtDuck * confirmMultiple
      || sample > state.baselineAtDuck * 1.25)
      && sample >= state.levelAtDuck * 0.55;
    if (followedDuck || !clearlyCaller) {
      learnEcho(state.levelAtDuck);
      return result("restore");
    }
    state.phase = "holding";
    state.holdAt = now;
    return result("none");
  }

  if (state.phase === "holding") {
    const stillCaller = sample >= state.levelAtDuck * 0.45
      || sample >= threshold * 0.85;
    if (!stillCaller) {
      learnEcho(Math.max(state.levelAtDuck, sample));
      return opts.duckAvailable ? result("restore") : result("none");
    }
    if (now - state.holdAt >= opts.confirmMs) {
      state.phase = "latched";
      return result("confirm");
    }
    return result("none");
  }

  if (sample > threshold) {
    if (state.phase !== "arming") {
      state.phase = "arming";
      state.armAt = now;
    }
    if (now - state.armAt >= opts.preDuckMs) {
      state.levelAtDuck = sample;
      state.baselineAtDuck = state.baseline;
      if (!opts.duckAvailable) {
        // No playback fader to test. Only a rise well above the learned echo
        // can be the caller; quieter energy is playback and must be learned.
        if (sample < state.baseline * unduckedConfirmMultiple) {
          learnEcho(sample);
          return result("none");
        }
        state.phase = "holding";
        state.holdAt = now;
        return result("none");
      }
      state.phase = "settling";
      state.duckedAt = now;
      return result("duck");
    }
    return result("none");
  }

  state.phase = "idle";
  trackBaseline(state, sample, dt);
  return result("none");
}
