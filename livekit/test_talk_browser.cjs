const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, 'web/talk.js'), 'utf8')
  .replace(/^import .*;\n/, '');

function browser({ provider = false, response = null, decodedChannels = null, decodeError = false, checkResponse = null, deferCheck = false, sparseChunks = false, activityResponse = null, deferActivity = false } = {}) {
  let now = 0;
  let microphoneLevel = 0;
  let requests = 0;
  let checks = 0;
  let releaseCheck = null;
  let releaseActivity = null;
  let activities = 0;
  let cancelCount = 0;
  const elements = new Map();
  const makeElement = (id) => ({
    id, value: id === '#audio-mode-control' ? 'speaker' : '1000',
    textContent: '', disabled: false, dataset: {}, scrollHeight: 0,
    classList: { add() {}, remove() {}, toggle() {} },
    children: [],
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    remove() { this.removed = true; },
    removeAttribute() {},
    querySelector() { return makeElement('descendant'); },
    addEventListener() {},
  });
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const document = {
    querySelector: element, createElement: () => makeElement('child'), addEventListener() {},
  };
  const synth = {
    speaking: false, paused: false, utterance: null, resumeCount: 0,
    getVoices: () => [],
    speak(utterance) { this.speaking = true; this.utterance = utterance; },
    pause() { this.paused = true; this.pauseAt = now; },
    resume() { this.paused = false; this.resumeCount++; },
    cancel() { cancelCount++; this.speaking = false; this.utterance = null; },
  };
  const audios = [];
  class FakeAudio {
    constructor() { this.paused = true; this.position = 17; this.pauseCount = 0; this.playCount = 0; audios.push(this); }
    play() { this.paused = false; this.playCount++; this.onplay?.(); return Promise.resolve(); }
    pause() { this.paused = true; this.pauseCount++; }
    removeAttribute() {}
  }
  const recorders = [];
  class FakeRecorder {
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; recorders.push(this); }
    start() { this.state = 'recording'; this.startedAt = now; this.nextChunkAt = now + 100; }
    emit() { this.ondataavailable?.({ data: new Blob([Buffer.alloc(800)]) }); }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob([Buffer.alloc(800)]) });
      this.onstop?.();
    }
  }
  let timerId = 0;
  const timers = new Map();
  const window = { speechSynthesis: synth, MediaRecorder: FakeRecorder,
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, due: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const context = vm.createContext({
    document, window, Audio: FakeAudio, MediaRecorder: FakeRecorder,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    Blob, Float32Array, URLSearchParams, Event: class {},
    crypto: { randomUUID: () => 'test' },
    Date: class extends Date { static now() { return now; } },
    requestAnimationFrame: () => 1, AbortController, setTimeout, clearTimeout,
    __decodedChannels: decodedChannels,
    fetch: async (url, options = {}) => {
      if (url === '/state') return { json: async () => ({ agentProvider: 'mock' }) };
      if (url === '/speech-activity') {
        activities++;
        const result = deferActivity ? await new Promise((resolve) => { releaseActivity = resolve; })
          : typeof activityResponse === 'function' ? activityResponse(options) : activityResponse;
        return { ok: true, json: async () => result || { speechEvidence: null } };
      }
      if (url === '/voice-agent') {
        if (options.headers['X-Playback-Check'] === 'true') {
          checks++;
          const result = deferCheck ? await new Promise((resolve) => { releaseCheck = resolve; })
            : (typeof checkResponse === 'function' ? checkResponse(checks) : checkResponse)
              || { ignored: true, ignoreReason: 'probable_playback_echo' };
          return { ok: true, json: async () => result };
        }
        requests++;
        return { ok: true, json: async () => response || { ignored: true, ignoreReason: 'probable_playback_echo' } };
      }
      throw Error(`Unexpected fetch: ${url}`);
    },
  });
  vm.runInContext(script, context, { filename: 'talk.js' });
  const run = (code) => vm.runInContext(code, context);
  run(`listenStream = { getAudioTracks: () => [{ getSettings: () => ({ echoCancellation: true }) }] };
    analyser = { fftSize: 64, getFloatTimeDomainData(samples) { samples.fill(__microphoneLevel); } };`);
  context.__microphoneLevel = 0;
  if (decodedChannels || decodeError) {
    run(decodeError ? 'audioContext = { state: "running", decodeAudioData: async () => { throw Error("unsupported format"); } }'
      : `audioContext = { state: "running", decodeAudioData: async () => ({ sampleRate: 16000,
          numberOfChannels: __decodedChannels.length,
          getChannelData: (channel) => __decodedChannels[channel] }) }`);
  }
  const frame = (ms, level) => {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.due <= now) { timers.delete(id); timer.callback(); }
    }
    microphoneLevel = level;
    context.__microphoneLevel = microphoneLevel;
    run('vadLoop()');
    for (const active of recorders) {
      while (active.state === 'recording' && now >= active.nextChunkAt) {
        active.nextChunkAt += 100;
        if (!sparseChunks || level > 0.01) active.emit();
      }
    }
  };
  const start = () => {
    run(provider ? `speak('Aurora answer', 'en-US', 'AAAA')` : `speak('Aurora answer')`);
    // The arming interval is 280 ms in speaker mode.
    frame(300, 0.005);
  };
  const events = () => run('window.__auroraTalk.clientEvents()');
  return { run, frame, start, synth, audios, recorders, events,
    get checks() { return checks; }, releaseCheck: (result) => releaseCheck(result),
    get activities() { return activities; }, releaseActivity: (result) => releaseActivity(result),
    get requests() { return requests; }, get cancelCount() { return cancelCount; } };
}

const flush = () => new Promise(setImmediate);
const frames = (app, count, level) => { for (let i = 0; i < count; i++) app.frame(40, level); };
const acceptedCheck = { inputConfirmed: true, transcript: 'Wait, speak Tamil' };
const acceptedReply = { transcript: 'Wait, speak Tamil', reply: 'Certainly', provider: 'mock',
  model: 'mock', sttModel: 'mock', language: 'ta', locale: 'ta-IN', ttsBackend: 'browser' };

const activity = (durationMs, lastSpeechMs, voicedMs = 500) => ({
  speechEvidence: { detector: 'silero', durationMs, lastSpeechMs, voicedMs,
    maxSpeechProbability: .9, speechThreshold: .3 },
});

test('playback is armed before an audio element can emit its first samples', () => {
  const app = browser({ provider: true });
  app.run(`Audio.prototype.play = function () {
    this.armedAtPlay = agentSpeaking;
    this.paused = false;
    this.onplay?.();
    return Promise.resolve();
  }`);
  app.start();
  assert.equal(app.audios[0].armedAtPlay, true);
});

test('a stalled playback watchdog stops output before opening the microphone', () => {
  const app = browser({ provider: true });
  app.start();
  app.frame(21000, 0);
  assert.equal(app.run('agentSpeaking'), false);
  assert.equal(app.audios[0].paused, true);
  assert.equal(app.run('activeAgentAudio'), null);
  assert.ok(app.events().includes('tts.playback_watchdog'));
});

test('a confirmed interruption suspends the watchdog until playback resumes', async () => {
  const app = browser({ provider: true, checkResponse: acceptedCheck });
  app.start();
  frames(app, 28, .08);
  await flush();
  assert.equal(app.audios[0].paused, true);
  assert.equal(app.run('playbackWatchdog'), 0);
  app.run('agentBusy = true');
  app.frame(30000, 0);
  assert.equal(app.audios[0].paused, true);
  assert.equal(app.run('agentSpeaking'), false);
  assert.equal(app.events().includes('tts.playback_watchdog'), false);
  app.run("resumeSuspendedPlayback('test_rejected_final')");
  assert.equal(app.audios[0].paused, false);
  assert.ok(app.run('playbackWatchdog') > 0);
  app.frame(500, 0);
  assert.equal(app.run('agentSpeaking'), true);
});

test('a canceled native utterance retries once but cannot replay after replacement', () => {
  const app = browser();
  app.start();
  const previous = app.synth.utterance;
  previous.onerror({ error: 'canceled' });
  app.frame(120, 0);
  assert.equal(app.synth.utterance, previous);
  previous.onerror({ error: 'canceled' });
  assert.equal(app.events().filter((event) => event.startsWith('tts.browser_retry')).length, 1);
  app.run("speak('Replacement')");
  const replacement = app.synth.utterance;
  previous.onerror({ error: 'canceled' });
  app.frame(120, 0);
  assert.equal(app.synth.utterance, replacement);
});

test('a recorder start failure leaves the listener available for another utterance', () => {
  const app = browser();
  app.run('MediaRecorder.prototype.start = function () { throw Error("device unavailable"); }');
  app.frame(40, .03);
  assert.equal(app.run('recorder'), null);
  assert.equal(app.requests, 0);
  assert.ok(app.events().includes('vad.record_failed'));
});

test('neural endpoint ends a short caller despite continuously loud room noise', async () => {
  const app = browser({ activityResponse: () => activity(app.run('Date.now() - recordingStartedAt'), 500) });
  app.frame(40, .03);
  const started = app.recorders[0].startedAt;
  for (let i = 0; i < 22; i++) { app.frame(100, .02); await flush(); }
  assert.equal(app.requests, 1);
  assert.equal(app.recorders[0].state, 'inactive');
  assert.ok(app.run('lastEndpointAt') - started < 1900);
  assert.ok(!app.events().includes('vad.max_turn_reached'));
  assert.equal(JSON.parse(app.run('vadReadout.dataset.lastTurnTimings')).endpointMethod, 'silero');
});

test('ongoing neural speech keeps a long turn open and later speech extends its endpoint', async () => {
  let speaking = true;
  let lastEnd = 0;
  const app = browser({ activityResponse: () => {
    const duration = app.run('Date.now() - recordingStartedAt');
    if (speaking) lastEnd = duration;
    return activity(duration, lastEnd, lastEnd);
  } });
  app.frame(40, .03);
  for (let i = 0; i < 60; i++) { app.frame(100, .03); await flush(); }
  assert.equal(app.recorders[0].state, 'recording');
  assert.equal(app.requests, 0);
  speaking = false;
  for (let i = 0; i < 22; i++) { app.frame(100, .02); await flush(); }
  assert.equal(app.requests, 1);
  assert.equal(app.recorders[0].state, 'inactive');
});

test('late STT confirmation does not restart an already elapsed neural silence timer', async () => {
  const app = browser({ deferCheck: true, response: acceptedReply,
    activityResponse: () => activity(app.run('Date.now() - recordingStartedAt'), 480, 400) });
  app.start();
  for (let i = 0; i < 22; i++) { app.frame(100, i < 5 ? .03 : .003); await flush(); }
  assert.equal(app.checks, 1);
  assert.equal(app.requests, 0);
  app.releaseCheck(acceptedCheck);
  await flush();
  app.frame(40, .003);
  await flush();
  assert.equal(app.requests, 1);
  assert.ok(app.run('lastEndpointAt - lastSpeechAt') < 1900);
});

test('an early noise preview retains the same recorder until the whole brief word can be checked', async () => {
  const app = browser({ checkResponse: (check) => check === 1
    ? { ignored: true, ignoreReason: 'no_speech', speechEvidence: { durationMs: 300 } }
    : { inputConfirmed: true, transcript: 'No.' } });
  app.run('noiseFloor = .002');
  app.start();
  app.frame(40, .02);
  const first = app.recorders[0];
  for (let i = 0; i < 6; i++) { app.frame(100, .003); await flush(); }
  assert.equal(app.checks, 1);
  assert.equal(first.state, 'recording');
  assert.equal(app.synth.paused, false);
  for (let i = 0; i < 5; i++) { app.frame(100, .02); await flush(); }
  assert.equal(app.checks, 2);
  assert.equal(app.recorders[0], first);
  assert.equal(app.synth.paused, true);
});

test('muting invalidates an outstanding neural activity response', async () => {
  const app = browser({ deferActivity: true });
  app.frame(40, .03);
  for (let i = 0; i < 5; i++) app.frame(100, .03);
  assert.equal(app.activities, 1);
  await app.run('toggleMute()');
  app.releaseActivity(activity(500, 500));
  await flush();
  assert.equal(app.run('speechActivity'), null);
  assert.equal(app.requests, 0);
});

test('echo checks have no audible effect and never create an agent turn', async () => {
  const app = browser();
  app.start();
  frames(app, 28, 0.20);
  await flush();
  assert.equal(app.checks, 1);
  assert.equal(app.synth.paused, false);
  assert.equal(app.synth.speaking, true);
  assert.equal(app.synth.resumeCount, 1); // Initial speak clears a previous pause.
  assert.equal(app.cancelCount, 1);
  assert.equal(app.requests, 0);
  assert.ok(app.events().includes('barge_in.check_rejected | probable_playback_echo'));
});

test('caller quieter than a learned echo peak is captured and only confirmed text pauses output', async () => {
  const app = browser({ deferCheck: true, response: acceptedReply });
  app.run('noiseFloor = 0.002');
  app.start();
  app.run('playbackEchoPeak = 0.25');
  frames(app, 28, 0.02);
  await flush();
  const firstRecorder = app.recorders[0];
  assert.equal(app.checks, 1);
  assert.equal(app.synth.paused, false);
  assert.equal(firstRecorder.state, 'recording');
  app.frame(200, 0.02); // Simulated STT round trip while capture continues.
  const expectedLatency = app.run('Date.now() - bargeCandidateAt');
  app.releaseCheck(acceptedCheck);
  await flush();
  assert.equal(app.synth.paused, true);
  assert.equal(app.synth.pauseAt - firstRecorder.startedAt, expectedLatency);
  assert.equal(app.run('Number(vadReadout.dataset.interruptionLatencyMs)'), expectedLatency);
  assert.equal(app.recorders[0], firstRecorder);
  frames(app, 45, 0.003);
  await flush();
  assert.equal(app.requests, 1);
  assert.equal(app.synth.utterance.text, 'Certainly');
});

test('a brief wait retains its onset and does not need continued speech after the check', async () => {
  const app = browser({ checkResponse: { inputConfirmed: true, transcript: 'wait' } });
  app.start();
  app.frame(40, 0.04);
  assert.equal(app.recorders.length, 1); // Capture starts on the first raw hit.
  const first = app.recorders[0];
  frames(app, 3, 0.04);
  frames(app, 12, 0.003);
  await flush();
  assert.equal(app.checks, 1);
  assert.equal(app.synth.paused, true);
  assert.equal(app.recorders[0], first);
  assert.ok(app.events().some((e) => e.startsWith('barge_in.speech_confirmed')));
});

test('brief No is checked even when the encoder stops delivering chunks during silence', async () => {
  const app = browser({ sparseChunks: true,
    checkResponse: { inputConfirmed: true, transcript: 'No.' },
    response: { ...acceptedReply, transcript: 'No.', reply: 'Okay' } });
  app.start();
  frames(app, 5, 0.04);
  const first = app.recorders[0];
  frames(app, 12, 0);
  await flush();
  assert.equal(app.checks, 1);
  assert.equal(app.synth.paused, true);
  assert.equal(app.recorders[0], first);
  frames(app, 45, 0);
  await flush();
  assert.equal(app.requests, 1);
  assert.equal(app.synth.utterance.text, 'Okay');
});

test('unpausable native synthesis cannot confirm a caller or submit continuing output', async () => {
  const app = browser({ checkResponse: acceptedCheck });
  app.synth.pause = function () { this.paused = false; };
  app.start();
  frames(app, 28, 0.04);
  await flush();
  assert.equal(app.synth.speaking, true);
  assert.equal(app.run('agentSpeaking'), true);
  assert.equal(app.run('Boolean(suspendedPlayback)'), false);
  assert.equal(app.recorders[0].state, 'inactive');
  assert.equal(app.requests, 0);
  assert.ok(app.events().includes('barge_in.pause_acknowledged | false'));
  assert.ok(app.events().includes('barge_in.resumed | pause_failed'));
  assert.ok(!app.events().some((event) => event.startsWith('barge_in.speech_confirmed')));
});

test('final echo rejection resumes provider playback at the same position', async () => {
  const app = browser({ provider: true, checkResponse: acceptedCheck });
  app.start();
  const audio = app.audios[0];
  frames(app, 28, 0.04);
  await flush();
  assert.equal(audio.paused, true);
  frames(app, 45, 0.003);
  await flush();
  assert.equal(app.requests, 1);
  assert.equal(audio.position, 17);
  assert.equal(audio.playCount, 2);
  assert.equal(audio.paused, false);
});

test('manual Interrupt bypasses an outstanding check and keeps the same recording', async () => {
  const app = browser({ deferCheck: true });
  app.start();
  frames(app, 28, 0.04);
  await flush();
  const first = app.recorders[0];
  app.run('forceInterrupt()');
  assert.equal(app.synth.speaking, false);
  assert.equal(first.state, 'recording');
  app.releaseCheck(acceptedCheck);
  await flush();
  assert.equal(app.run('Boolean(suspendedPlayback)'), false);
  assert.equal(app.synth.paused, false);
  assert.equal(app.recorders.length, 1);
});

test('playback ending during a check never resumes or pauses finished output', async () => {
  const app = browser({ deferCheck: true, response: acceptedReply });
  app.start();
  frames(app, 28, 0.04);
  await flush();
  app.synth.utterance.onend();
  app.releaseCheck(acceptedCheck);
  await flush();
  assert.equal(app.synth.paused, false);
  assert.equal(app.run('Boolean(suspendedPlayback)'), false);
  frames(app, 45, 0.003);
  await flush();
  assert.equal(app.requests, 1);
});

test('a short recorded answer crossing playback end is checked instead of discarded', async () => {
  const app = browser({ checkResponse: acceptedCheck, response: acceptedReply });
  app.start();
  app.frame(40, 0.04);
  const first = app.recorders[0];
  app.synth.utterance.onend();
  frames(app, 14, 0.003);
  await flush();
  assert.equal(app.recorders[0], first);
  assert.equal(app.checks, 1);
  assert.equal(app.run('Boolean(suspendedPlayback)'), false);
  frames(app, 45, 0.003);
  await flush();
  assert.equal(app.requests, 1);
});

test('stale speech-check results after replacement cannot pause the new reply', async () => {
  const app = browser({ deferCheck: true });
  app.start();
  frames(app, 28, 0.04);
  await flush();
  app.run("speak('A replacement reply')");
  app.releaseCheck(acceptedCheck);
  await flush();
  assert.equal(app.synth.paused, false);
  assert.equal(app.synth.utterance.text, 'A replacement reply');
});

test('mute rejects an outstanding speech check without touching output', async () => {
  const app = browser({ deferCheck: true });
  app.start();
  frames(app, 28, 0.04);
  await flush();
  await app.run('toggleMute()');
  app.releaseCheck(acceptedCheck);
  await flush();
  assert.equal(app.synth.paused, false);
  assert.equal(app.run('Boolean(recorder)'), false);
});

test('mute discards a normal caller recording instead of retaining it across unmute', async () => {
  const app = browser();
  app.run('noiseFloor = 0.002');
  frames(app, 10, 0.02);
  assert.equal(app.recorders[0].state, 'recording');
  await app.run('toggleMute()');
  assert.equal(app.recorders[0].state, 'inactive');
  assert.equal(app.run('Boolean(recorder)'), false);
  assert.equal(app.requests, 0);
  await app.run('toggleMute()');
  frames(app, 10, 0.02);
  assert.equal(app.recorders.length, 2);
  assert.equal(app.recorders[1].state, 'recording');
});

test('render gaps and isolated energy frames never directly pause output', async () => {
  const app = browser();
  for (let i = 0; i < 8; i++) app.frame(1000, 0.20);
  assert.equal(app.recorders.length, 1); // Capture is speculative, not confirmation.
  assert.equal(app.requests, 0);
  app.run('stopTurnRecording(true)');
  app.start();
  for (let i = 0; i < 3; i++) app.frame(1000, 0.20);
  await flush();
  assert.equal(app.synth.paused, false);
  assert.equal(app.requests, 0);
});

test('a frozen audio clock cannot confirm a caller from stale analyser energy', () => {
  const app = browser();
  app.run('audioContext = { state: "running", currentTime: 1 }');
  frames(app, 20, 0.20);
  assert.equal(app.recorders.length, 1); // Preserve the first genuinely advancing frame.
  assert.equal(app.recorders[0].state, 'inactive');
  assert.equal(app.requests, 0);
  for (let i = 0; i < 10; i++) {
    app.run('audioContext.currentTime += 0.04');
    app.frame(40, 0.20);
  }
  assert.equal(app.recorders.length, 2);
  app.run('audioContext.state = "interrupted"');
  app.frame(40, 0.20);
  assert.equal(app.run('Boolean(recorder)'), false);
  assert.equal(app.requests, 0);
});

test('decoded silent previews do not reach STT or pause output', async () => {
  const app = browser({ decodedChannels: [new Float32Array(32000)] });
  app.start();
  frames(app, 28, 0.20);
  await flush();
  assert.equal(app.checks, 0);
  assert.equal(app.requests, 0);
  assert.equal(app.synth.paused, false);
  assert.ok(app.events().includes('barge_in.check_rejected | silent_recording'));
});

test('one brief audible window in any channel keeps a quiet clip eligible', async () => {
  const samples = new Float32Array(32000);
  samples.fill(0.02, 16000, 16320);
  const app = browser({ decodedChannels: [new Float32Array(32000), samples] });
  assert.equal(await app.run('isSilentRecording(new Blob(["encoded"]))'), false);
});

test('decode failures preserve the existing transcription path', async () => {
  const app = browser({ decodeError: true });
  assert.equal(await app.run('isSilentRecording(new Blob(["encoded"]))'), false);
});

test('provider playback errors fall back to the configured browser voice', () => {
  const app = browser({ provider: true });
  app.start();
  app.audios[0].onerror();
  assert.equal(app.synth.utterance.text, 'Aurora answer');
  assert.equal(app.run('playbackBackend'), 'browser');
});

test('quiet calibration still measures the microphone while session setup is busy', () => {
  const app = browser();
  app.run('agentBusy = true');
  for (let i = 0; i < 80; i++) app.frame(8, 0.001);
  assert.ok(app.run('noiseFloor') < 0.004);
  assert.equal(app.recorders.length, 0);
});

test('room noise below the speech endpoint cannot renew hangover indefinitely', async () => {
  const app = browser();
  app.run('noiseFloor = 0.002');
  frames(app, 10, 0.02);
  frames(app, 35, 0.003);
  await flush();
  assert.equal(app.requests, 1);
  assert.equal(app.run('Boolean(recorder)'), false);
  assert.ok(app.events().some((e) => e.startsWith('vad.endpoint_detected')));
  assert.equal(app.events().includes('vad.max_turn_reached'), false);
});
