import assert from "node:assert/strict";
import test from "node:test";
import { createListenGate, stepListenGate } from "./web/listen_gate.js";

const speaker = {
  audible: true,
  armMs: 250,
  multiple: 1.35,
  margin: 0.005,
  cap: 0.22,
  settleMs: 80,
  confirmMs: 80,
  preDuckMs: 50,
  duckAvailable: true,
  refractoryMs: 250,
};

function run(state, level, from, to, step = 16) {
  const actions = [];
  for (let now = from; now <= to; now += step) {
    const decision = stepListenGate(state, {
      ...speaker,
      now,
      level,
      playbackAgeMs: now,
    });
    if (decision.action !== "none") actions.push({ now, action: decision.action, baseline: decision.baseline });
  }
  return actions;
}

test("steady playback after the arm window is not an interruption", () => {
  const state = createListenGate(0.02);
  const duringArm = run(state, 0.06, 0, 400);
  assert.deepEqual(duringArm, []);
  const duringSpeech = run(state, 0.06, 416, 2000);
  assert.deepEqual(duringSpeech, []);
  assert.ok(state.baseline > 0.05);
});

test("a louder phrase of the same reply is learned, not confirmed", () => {
  const state = createListenGate(0.02);
  run(state, 0.05, 0, 400);
  const actions = [];
  let ducked = false;
  for (let now = 416; now <= 2600; now += 16) {
    // Speaker echo falls once playback is ducked, then returns after restore.
    const level = ducked ? 0.035 : 0.11;
    const decision = stepListenGate(state, {
      ...speaker,
      now,
      level,
      playbackAgeMs: now,
    });
    if (decision.action === "duck") ducked = true;
    if (decision.action === "restore") ducked = false;
    if (decision.action !== "none") actions.push(decision.action);
  }
  assert.ok(actions.includes("duck"));
  assert.ok(actions.includes("restore"));
  assert.equal(actions.includes("confirm"), false);
  assert.ok(state.baseline >= 0.1);
});

test("caller speech that stays loud through the duck is confirmed", () => {
  const state = createListenGate(0.02);
  run(state, 0.05, 0, 400);
  const caller = run(state, 0.16, 416, 1200);
  assert.ok(caller.some((event) => event.action === "duck"));
  assert.ok(caller.some((event) => event.action === "confirm"));
});

test("a short spike does not duck or confirm", () => {
  const state = createListenGate(0.05);
  state.lastAt = 400;
  const decision = stepListenGate(state, {
    ...speaker,
    now: 500,
    level: 0.2,
    playbackAgeMs: 500,
  });
  assert.equal(decision.action, "none");
  assert.equal(state.phase, "arming");
});

test("a failed duck learns the loudness instead of confirming", () => {
  const state = createListenGate(0.04);
  run(state, 0.04, 0, 400);
  let ducked = null;
  for (let now = 416; now <= 700 && !ducked; now += 16) {
    const decision = stepListenGate(state, {
      ...speaker,
      now,
      level: 0.14,
      playbackAgeMs: now,
    });
    if (decision.action === "duck") ducked = decision;
  }
  assert.equal(ducked?.action, "duck");
  const failed = stepListenGate(state, {
    ...speaker,
    now: 900,
    level: 0.14,
    playbackAgeMs: 900,
    duckFailed: true,
  });
  assert.equal(failed.action, "restore");
  assert.ok(state.baseline >= 0.14);
});

function smooth(previous, raw) {
  return previous * 0.72 + raw * 0.28;
}

function lowVolumeSpeech(now, peak) {
  if (now < 500) return peak * 0.25;
  const word = 520;
  const t = (now - 500) % word;
  if (t < 340) return peak * (0.55 + 0.45 * Math.sin(Math.PI * t / 340));
  return peak * 0.2;
}

test("low speaker volume with a silent caller never confirms", () => {
  for (const peak of [0.012, 0.02, 0.03, 0.045]) {
    const state = createListenGate(0.008);
    let smoothed = 0;
    let ducking = false;
    const confirms = [];
    for (let now = 0; now <= 8000; now += 16) {
      smoothed = smooth(smoothed, lowVolumeSpeech(now, peak));
      const level = ducking ? smoothed * 0.35 : smoothed;
      const decision = stepListenGate(state, {
        ...speaker,
        now,
        level,
        playbackAgeMs: now,
      });
      if (decision.action === "duck") ducking = true;
      if (decision.action === "restore") ducking = false;
      if (decision.action === "confirm") confirms.push(now);
    }
    assert.equal(confirms.length, 0, `peak ${peak} confirmed at ${confirms.join(",")}`);
  }
});

test("low speaker volume still accepts a clearly louder caller", () => {
  const state = createListenGate(0.008);
  let smoothed = 0;
  let ducking = false;
  const actions = [];
  for (let now = 0; now <= 6000; now += 16) {
    let raw = lowVolumeSpeech(now, 0.018);
    if (now > 2500 && now < 4600) raw = 0.07;
    smoothed = smooth(smoothed, raw);
    let level = ducking ? smoothed * 0.35 : smoothed;
    if (ducking && now > 2500 && now < 4600) level = Math.max(level, 0.06);
    const decision = stepListenGate(state, {
      ...speaker,
      now,
      level,
      playbackAgeMs: now,
    });
    if (decision.action === "duck") ducking = true;
    if (decision.action === "restore") ducking = false;
    if (decision.action !== "none") actions.push(decision.action);
  }
  assert.ok(actions.includes("confirm"), actions.join(" ") || "no actions");
  assert.equal(actions.filter((action) => action === "confirm").length, 1);
});

test("speech that starts immediately does not self-interrupt at low or high volume", () => {
  function speech(now, peak) {
    const word = 480;
    const t = now % word;
    if (t < 320) return peak * (0.5 + 0.5 * Math.sin(Math.PI * t / 320));
    return peak * 0.22;
  }
  for (const peak of [0.012, 0.02, 0.03, 0.05, 0.08, 0.12]) {
    for (const duckAvailable of [true, false]) {
      const state = createListenGate(0.008);
      let smoothed = 0;
      let ducking = false;
      let confirms = 0;
      for (let now = 0; now <= 9000; now += 16) {
        smoothed = smooth(smoothed, speech(now, peak));
        const level = ducking && duckAvailable ? smoothed * 0.35 : smoothed;
        const decision = stepListenGate(state, {
          ...speaker,
          duckAvailable,
          now,
          level,
          playbackAgeMs: now,
        });
        if (decision.action === "duck") ducking = true;
        if (decision.action === "restore") ducking = false;
        if (decision.action === "confirm") confirms += 1;
      }
      assert.equal(confirms, 0, `peak ${peak} duck ${duckAvailable}`);
    }
  }
});

test("without a duck test, playback loudness is learned instead of confirmed", () => {
  const state = createListenGate(0.02);
  run(state, 0.05, 0, 400);
  const actions = [];
  for (let now = 416; now <= 1600; now += 16) {
    const decision = stepListenGate(state, {
      ...speaker,
      duckAvailable: false,
      now,
      level: 0.14,
      playbackAgeMs: now,
    });
    if (decision.action !== "none") actions.push(decision.action);
  }
  assert.deepEqual(actions, []);
  assert.ok(state.baseline >= 0.14);
});

test("natural conversational interruption confirms within 260ms", () => {
  const state = createListenGate(0.015);
  // Initial 250ms arm window hears speaker echo 0.03
  run(state, 0.03, 0, 250);
  let duckAt = 0;
  let confirmAt = 0;
  let ducking = false;
  // Caller interrupts with normal voice (0.075 RMS) starting at 300ms
  for (let now = 260; now <= 900; now += 16) {
    // When playback ducks, speaker echo falls but caller voice remains at 0.075
    const level = ducking ? 0.075 : 0.075 + 0.02;
    const decision = stepListenGate(state, {
      ...speaker,
      now,
      level,
      playbackAgeMs: now,
    });
    if (decision.action === "duck") {
      ducking = true;
      duckAt = now;
    }
    if (decision.action === "confirm") {
      confirmAt = now;
      break;
    }
  }
  assert.ok(duckAt > 0, "must initiate duck");
  assert.ok(confirmAt > 0, "must confirm interruption");
  assert.ok(confirmAt - 300 <= 260, `confirmed in ${confirmAt - 300}ms, must be <= 260ms`);
});

test("short caller phrase like 'wait' or 'yes' confirms", () => {
  const state = createListenGate(0.012);
  run(state, 0.025, 0, 250);
  let confirms = 0;
  let ducking = false;
  // Short 240ms utterance starting at 300ms
  for (let now = 260; now <= 1000; now += 16) {
    let raw = 0.012;
    if (now >= 300 && now <= 540) raw = 0.065;
    const level = ducking ? raw : raw + 0.02;
    const decision = stepListenGate(state, {
      ...speaker,
      now,
      level,
      playbackAgeMs: now,
    });
    if (decision.action === "duck") ducking = true;
    if (decision.action === "restore") ducking = false;
    if (decision.action === "confirm") confirms += 1;
  }
  assert.equal(confirms, 1, "short word must confirm exactly once");
});

test("headset mode allows fast low-latency barge-in", () => {
  const headset = {
    audible: true,
    armMs: 60,
    multiple: 1.15,
    margin: 0.003,
    cap: 0.14,
    settleMs: 50,
    confirmMs: 60,
    preDuckMs: 30,
    duckAvailable: true,
    refractoryMs: 150,
  };
  const state = createListenGate(0.008);
  let confirmedAt = 0;
  for (let now = 0; now <= 500; now += 16) {
    const raw = now >= 100 ? 0.035 : 0.008;
    const decision = stepListenGate(state, {
      ...headset,
      now,
      level: raw,
      playbackAgeMs: now,
    });
    if (decision.action === "confirm") {
      confirmedAt = now;
      break;
    }
  }
  assert.ok(confirmedAt > 0, "headset barge-in must confirm");
  assert.ok(confirmedAt - 100 <= 180, `confirmed in ${confirmedAt - 100}ms`);
});

