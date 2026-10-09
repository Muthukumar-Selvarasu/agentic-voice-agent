const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, 'web/talk.js'), 'utf8')
  .replace(/^import .*;\n/gm, '');

function browser({ provider = false, response = null, decodedChannels = null, decodeError = false, checkResponse = null, deferCheck = false, sparseChunks = false, activityResponse = null, deferActivity = false, deferReply = false, audioMode = 'speaker' } = {}) {
  let now = 0;
  let microphoneLevel = 0;
  let requests = 0;
  let checks = 0;
  let releaseCheck = null;
  let releaseActivity = null;
  let activities = 0;
  let cancelCount = 0;
  const replies = [];
  const messages = [];
  const feedback = [];
  const voiceHeaders = [];
  const deviceListeners = new Map();
  const elements = new Map();
  const makeElement = (id) => ({
    id, value: id === '#audio-mode-control' ? audioMode : id === '#sensitivity-control' ? '3.6' : '1000',
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
    constructor() { this.currentTime = 0; this.paused = true; this.position = 17; this.pauseCount = 0; this.playCount = 0; this.volume = 1; audios.push(this); }
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
    console,
    document, window, navigator: { mediaDevices: { addEventListener(name, callback) { deviceListeners.set(name, callback); } } }, Audio: FakeAudio, MediaRecorder: FakeRecorder,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    Blob, Float32Array, URLSearchParams, Event: class {},
    crypto: { randomUUID: () => 'test' },
    Date: class extends Date { static now() { return now; } },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {}, AbortController, setTimeout, clearTimeout,
    __decodedChannels: decodedChannels,
    fetch: async (url, options = {}) => {
      if (url === '/playback-state') { feedback.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ acknowledged: true }) }; }
      if (url === '/agent') {
        messages.push(JSON.parse(options.body).text);
        const result = deferReply ? await new Promise(resolve => replies.push(resolve)) : (response || acceptedReply);
        return { ok: true, json: async () => result };
      }
      if (url === '/state') return { json: async () => ({ agentProvider: 'mock' }) };
      if (url === '/speech-activity') {
        activities++;
        const result = deferActivity ? await new Promise((resolve) => { releaseActivity = resolve; })
          : typeof activityResponse === 'function' ? activityResponse(options) : activityResponse;
        return { ok: true, json: async () => result || { speechEvidence: null } };
      }
      if (url === '/voice-agent') {
        voiceHeaders.push({ ...options.headers });
        if (options.headers['X-Playback-Check'] === 'true') {
          checks++;
          const result = deferCheck ? await new Promise((resolve) => { releaseCheck = resolve; })
            : (typeof checkResponse === 'function' ? checkResponse(checks) : checkResponse)
              || { ignored: true, ignoreReason: 'probable_playback_echo' };
          return { ok: true, json: async () => result };
        }
        requests++;
        const result = deferReply ? await new Promise(resolve => replies.push(resolve))
          : response || { ignored: true, ignoreReason: 'probable_playback_echo' };
        return { ok: true, json: async () => result };
      }
      throw Error(`Unexpected fetch: ${url}`);
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'web/pcm_capture.js'), 'utf8').replace('export class', 'class'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'web/listen_gate.js'), 'utf8').replace(/export function/g, 'function'), context);
  vm.runInContext(script, context, { filename: 'talk.js' });
  const run = (code) => vm.runInContext(code, context);
  run(`listenStream = { getTracks: () => [], getAudioTracks: () => [{ getSettings: () => ({ echoCancellation: true }) }] };
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
    replies, messages, feedback, voiceHeaders, changeDevice: () => deviceListeners.get('devicechange')(),
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

test('the caller UI has only Start/End controls and explains supported typed messages', () => {
  const html = fs.readFileSync(path.join(__dirname, 'web/index.html'), 'utf8');
  assert.match(html, /id="start-call"[^>]*>Start call/);
  assert.match(html, /id="end-call"[^>]*>End call/);
  assert.doesNotMatch(html, /id="(?:interrupt-call|mute-call)"/);
  assert.match(html, /Message the agent/);
  assert.match(html, /Send a message to the agent in English, Spanish, or Tamil\./);
  assert.doesNotMatch(html, /Typed turn|press Space|click Interrupt|\bUnmute\b/);
  assert.doesNotMatch(script, /interrupt-call|mute-call|forceInterrupt|toggleMute|setInterruptEnabled/);
});

test('automatic tuning defaults remain stable after switching from speaker or headset presets', () => {
  const app = browser({ audioMode: 'auto' });
  const expected = { silence: 1000, sensitivity: 3.6, speechConfirm: 100,
    bargeConfirm: 80, arm: 140, postPlayback: 0, echo: 1200, volume: .3 };
  const configuration = () => JSON.parse(app.run(`JSON.stringify({ silence: tuning.endpointSilenceMs, sensitivity: tuning.sensitivity,
    speechConfirm: tuning.speechConfirmationMs, bargeConfirm: tuning.bargeInConfirmationMs,
    arm: tuning.bargeInArmMs, postPlayback: tuning.postPlaybackHoldMs,
    echo: tuning.afterPlaybackEchoMs, volume: tuning.playbackVolume })`));
  assert.deepEqual(configuration(), expected);
  for (const mode of ['speaker', 'headset']) {
    app.run(`applyAudioMode(${JSON.stringify(mode)})`);
    app.run("applyAudioMode('auto')");
    assert.deepEqual(configuration(), expected);
  }
});

test('interrupted playback feedback carries the active audio position', async () => {
  const app = browser({ provider: true });
  app.run(`activeOutput = { turnId: 'reply-1', sessionId: 'session-1' };
    activeAgentAudio = { currentTime: 2.5, duration: 10 }`);
  await app.run(`playbackFeedback(activeOutput, 'interrupted')`);
  assert.deepEqual(app.feedback.at(-1), {
    turnId: 'reply-1', state: 'interrupted', generation: 0,
    heardThroughMs: 2500, playbackDurationMs: 10000,
  });
});

test('completed playback feedback records the full audio reference end', async () => {
  const app = browser({ provider: true });
  app.run(`activeOutput = { turnId: 'reply-1', sessionId: 'session-1' };
    activeAgentAudio = { currentTime: 10, duration: 10 }`);
  await app.run(`playbackFeedback(activeOutput, 'completed')`);
  assert.deepEqual(app.feedback.at(-1), {
    turnId: 'reply-1', state: 'completed', generation: 0,
    heardThroughMs: 10000, playbackDurationMs: 10000,
  });
});

test('typed input retains the stopped playback reference while its reply is pending', async () => {
  const app = browser({ deferReply: true });
  app.run(`activeOutput = { turnId: 'greeting', sessionId: 'browser-test' };
    activeAgentAudio = new Audio(); activeAgentAudio.currentTime = 1.25;
    activeAgentAudio.duration = 4; activeAgentAudio.paused = false; agentSpeaking = true`);
  app.frame(100, 0);
  app.run("sendTextToAgent('A room question')");
  await flush();
  assert.equal(app.run('lastOutputReference.id'), 'greeting');
  assert.ok(app.run('playbackEndedAt') > 0);
  assert.equal(app.run('activeOutput'), null);

  app.run('startTurnRecording(true)');
  assert.equal(app.run('currentRecordingReference.id'), 'greeting');
});

test('typed input immediately drops an outstanding caller candidate and stops old playback', async () => {
  const app = browser({ deferReply: true });
  app.run(`activeOutput = { turnId: 'greeting', sessionId: 'browser-test' };
    activeAgentAudio = new Audio(); activeAgentAudio.paused = false;
    agentSpeaking = true; bargeProbe = { checking: true }`);
  app.run("sendTextToAgent('Typed request')");
  assert.equal(app.run('activeOutput'), null);
  assert.equal(app.run('agentSpeaking'), false);
  assert.equal(app.run('bargeProbe'), null);
  assert.ok(app.run('playbackReferenceHoldUntil') > 0);
  assert.ok(app.events().includes('barge_in.check_rejected | typed_message'));
});

test('caller input during processing cancels the older response without losing the new utterance', async () => {
  const app = browser({ deferReply: true, checkResponse: acceptedCheck, audioMode: 'auto' });
  app.run("sendTextToAgent('First question')");
  await flush();
  assert.equal(app.run('agentBusy'), true);
  app.frame(40, .015);
  frames(app, 25, .015);
  await flush();
  assert.equal(app.checks, 1);
  assert.equal(app.run('agentBusy'), false);
  assert.ok(app.feedback.some(event => event.state === 'discarded'));
  app.replies.shift()({ ...acceptedReply, reply: 'Old unwanted response' });
  await flush();
  assert.equal(app.synth.speaking, false);
  frames(app, 70, 0);
  await flush();
  assert.equal(app.requests, 1);
  app.replies.shift()(acceptedReply);
  await flush();
  assert.equal(app.synth.utterance.text, 'Certainly');
});

test('noise while processing holds a ready response and releases it after rejection', async () => {
  const app = browser({ deferReply: true, audioMode: 'auto' });
  app.run("sendTextToAgent('First question')");
  await flush();
  app.frame(40, .02);
  app.replies.shift()(acceptedReply);
  await flush();
  assert.equal(app.synth.speaking, false);
  frames(app, 25, .02);
  await flush();
  assert.equal(app.synth.utterance.text, 'Certainly');
  assert.equal(app.feedback.some(event => event.state === 'discarded'), false);
});

test('End call fences a pending typed reply and releases microphone and audio state', async () => {
  const app = browser({ deferReply: true });
  app.run("sendTextToAgent('A pending question')");
  await flush();
  await app.run('endCall()');
  app.replies.shift()(acceptedReply);
  await flush();
  assert.equal(app.synth.speaking, false);
  assert.equal(app.run('agentBusy'), false);
  assert.equal(app.run('listenStream'), null);
  assert.equal(app.run('activeTurnRequest'), null);
});

test('messages in all supported languages retain their exact Unicode text', async () => {
  for (const text of ['I need a room', 'Necesito una habitación', 'எனக்கு ஒரு அறை வேண்டும்']) {
    const app = browser();
    await app.run(`sendTextToAgent(${JSON.stringify(text)})`);
    assert.deepEqual(app.messages, [text]);
    assert.equal(app.synth.utterance.text, 'Certainly');
  }
});

test('automatic mode accepts quiet speech without a device selector change', async () => {
  const app = browser({ audioMode: 'auto', checkResponse: acceptedCheck });
  app.start();
  frames(app, 28, .014);
  await flush();
  assert.equal(app.run('audioMode'), 'auto');
  assert.equal(app.synth.paused, true);
});

test('automatic mode captures a quiet interruption with the initial calibrated floor', async () => {
  const app = browser({ audioMode: 'auto', checkResponse: acceptedCheck });
  app.start();
  frames(app, 28, .004);
  await flush();
  assert.equal(app.checks, 1);
  assert.equal(app.synth.paused, true);
  assert.ok(app.recorders[0]);
});

test('PCM pre-roll retains speech before the trigger and produces a complete WAV', async () => {
  const app = browser();
  app.run(`pcmCapture = new PcmCapture(16000);
    pcmCapture.accept(new Float32Array(1600).fill(.2));
    pcmCapture.accept(new Float32Array(1600).fill(.3));
    startTurnRecording();
    pcmCapture.accept(new Float32Array(1600).fill(.4));`);
  const blob = app.run('recordingBlob()');
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt32LE(40), 9600);
  assert.equal(bytes.readInt16LE(44), Math.round(.2 * 32767));
  assert.equal(bytes.readInt16LE(44 + 6400), Math.round(.4 * 32767));
  assert.equal(app.run('recorder.preRollMs'), 200);
});

test('PCM ring memory is bounded across a long call', () => {
  const app = browser();
  app.run(`pcmCapture = new PcmCapture(16000);
    for (let i = 0; i < 3000; i++) pcmCapture.accept(new Float32Array(800));`);
  assert.equal(app.run('pcmCapture.frames'), 4800);
  assert.equal(app.run('pcmCapture.ring.length'), 6);
});

test('automatic mode checks persistent room noise locally without inventing a caller turn', async () => {
  const app = browser({ audioMode: 'auto', activityResponse: () => activity(app.run('Date.now() - recordingStartedAt'), null, 0) });
  app.run('noiseFloor = .04');
  assert.ok(app.run('thresholds().start') <= .012);
  for (let i = 0; i < 35; i++) { app.frame(100, .02); await flush(); }
  assert.equal(app.requests, 0);
  assert.ok(app.recorders.some(recorder => recorder.state === 'inactive'));
  assert.ok(!app.events().includes('vad.max_turn_reached'));
});

test('a device change resets calibration without discarding an ongoing utterance', () => {
  const app = browser({ audioMode: 'auto' });
  app.run('noiseFloor = .03');
  app.changeDevice();
  assert.equal(app.run('noiseFloor'), .008);
  app.frame(40, .025);
  const active = app.recorders[0];
  app.changeDevice();
  assert.equal(active.state, 'recording');
  assert.equal(app.run('recalibrateAfterTurn'), true);
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

test('automatic long answers retain a natural pause without adding a second endpoint wait', async () => {
  let speaking = true;
  let lastEnd = 0;
  const app = browser({ audioMode: 'auto', activityResponse: () => {
    const duration = app.run('Date.now() - recordingStartedAt');
    if (speaking) lastEnd = duration;
    return activity(duration, lastEnd, lastEnd);
  } });
  app.frame(40, .03);
  for (let i = 0; i < 60; i++) { app.frame(100, .03); await flush(); }
  speaking = false;
  for (let i = 0; i < 8; i++) { app.frame(100, .002); await flush(); }
  assert.equal(app.requests, 0, 'a pause shorter than the configured window must remain open');
  speaking = true;
  for (let i = 0; i < 6; i++) { app.frame(100, .03); await flush(); }
  assert.equal(app.requests, 0, 'the resumed clause belongs to the same caller turn');
  speaking = false;
  for (let i = 0; i < 14; i++) { app.frame(100, .002); await flush(); }
  assert.equal(app.requests, 1);
  const silence = app.run('lastEndpointAt - lastSpeechAt');
  assert.ok(silence >= 1000 && silence < 1400, `automatic silence was ${silence}ms`);
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

test('End call invalidates an outstanding neural activity response', async () => {
  const app = browser({ deferActivity: true });
  app.frame(40, .03);
  for (let i = 0; i < 5; i++) app.frame(100, .03);
  assert.equal(app.activities, 1);
  await app.run('endCall()');
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

test('End call rejects an outstanding speech check and stops output', async () => {
  const app = browser({ deferCheck: true });
  app.start();
  frames(app, 28, 0.04);
  await flush();
  await app.run('endCall()');
  app.releaseCheck(acceptedCheck);
  await flush();
  assert.equal(app.synth.paused, false);
  assert.equal(app.run('Boolean(recorder)'), false);
});

test('End call discards an ongoing caller recording and its retained PCM', async () => {
  const app = browser();
  app.run('pcmCapture = new PcmCapture(16000); pcmCapture.accept(new Float32Array(1600).fill(.2));');
  app.frame(40, .03);
  assert.equal(app.run('recorder.state'), 'recording');
  await app.run('endCall()');
  assert.equal(app.run('recorder'), null);
  assert.equal(app.run('pcmCapture'), null);
  assert.equal(app.requests, 0);
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


test('recording keeps the actual playback reference after replacement and throughout submission', async () => {
  const app = browser({ provider: true, checkResponse: acceptedCheck, audioMode: 'auto' });
  app.run("speak('Current output', 'en-US', 'AAAA', 'audio/wav', { turnId: 'playing', sessionId })");
  app.audios.at(-1).currentTime = 1.2;
  app.frame(300, .005);
  app.frame(40, .02);
  frames(app, 25, .02);
  await flush();
  assert.equal(app.voiceHeaders[0]['X-Playback-Reference-ID'], 'playing');
  assert.equal(app.voiceHeaders[0]['X-Playback-Offset-Ms'], '1200');
  assert.equal(app.voiceHeaders[0]['X-Playback-Through-Ms'], '1200');
  app.run("lastOutputReference = { id: 'other', offsetMs: 9000, at: Date.now() }");
  frames(app, 70, 0);
  await flush();
  const final = app.voiceHeaders.find(headers => !headers['X-Playback-Check']);
  assert.equal(final['X-Playback-Reference-ID'], 'playing');
  assert.equal(final['X-Playback-Offset-Ms'], '1200');
  assert.equal(final['X-Playback-Through-Ms'], '1200');
  await app.run('endCall()');
  assert.equal(app.run('currentRecordingReference'), null);
  assert.equal(app.run('lastOutputReference'), null);
});

test('a suppressed voice turn updates the listening state with clear user feedback', async () => {
  const app = browser({
    response: { ignored: true, ignoreReason: 'probable_playback_echo', transcript: 'Wait' },
  });
  app.frame(40, .02);
  frames(app, 30, .02);
  frames(app, 70, 0);
  await flush();
  await flush();
  await flush();
  assert.ok(app.run("listeningStateEl?.textContent").includes("Listening"));
  assert.ok(app.run("voiceStatusEl?.textContent").includes("speaker echo"));
});

test('caller microphone onset ducks active playback volume immediately', async () => {
  const app = browser({ provider: true, audioMode: 'auto' });
  app.start();
  const audio = app.audios[0];
  assert.equal(audio.paused, false);
  const initialVolume = audio.volume;
  frames(app, 3, 0.035);
  await flush();
  assert.ok(app.events().includes('barge_in.ducked'));
  assert.ok(audio.volume < initialVolume);
  assert.ok(audio.volume <= 0.1);
});

test('persistent caller energy confirms interruption locally within 200ms and pauses output', async () => {
  const app = browser({ provider: true, audioMode: 'auto' });
  app.start();
  const audio = app.audios[0];
  assert.equal(audio.paused, false);
  frames(app, 8, 0.035);
  await flush();
  assert.ok(app.events().some((e) => e.startsWith('barge_in.speech_confirmed')));
  assert.equal(audio.paused, true);
  assert.equal(app.run('agentSpeaking'), false);
});

test('receding microphone energy restores ducked playback volume', async () => {
  const app = browser({ provider: true, audioMode: 'auto' });
  app.start();
  const audio = app.audios[0];
  const initialVolume = audio.volume;
  frames(app, 3, 0.035);
  await flush();
  assert.ok(app.events().includes('barge_in.ducked'));
  // Energy drops back to room baseline (speaker echo fell with duck)
  frames(app, 4, 0.005);
  await flush();
  assert.ok(app.events().includes('barge_in.duck_restored'));
  assert.equal(audio.volume, initialVolume);
  assert.equal(audio.paused, false);
});

