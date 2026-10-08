import { Room, Track } from "/node_modules/livekit-client/dist/livekit-client.esm.mjs";

const callerRoot = document.querySelector('[data-client="caller"]');
const agentRoot = document.querySelector('[data-client="agent"]');
const callerStatus = callerRoot.querySelector('[data-role="status"]');
const agentStatus = agentRoot.querySelector('[data-role="status"]');
const startButton = document.querySelector("#start-call");
const interruptButton = document.querySelector("#interrupt-call");
const muteButton = document.querySelector("#mute-call");
const endButton = document.querySelector("#end-call");
const providerEl = document.querySelector("#provider");
const languageEl = document.querySelector("#language");
const transcriptEl = document.querySelector("#transcript");
const sourcesEl = document.querySelector("#sources");
const voiceStatusEl = document.querySelector("#voice-status");
const listeningStateEl = document.querySelector("#listening-state");
const endpointControl = document.querySelector("#endpoint-control");
const endpointValue = document.querySelector("#endpoint-value");
const sensitivityControl = document.querySelector("#sensitivity-control");
const sensitivityValue = document.querySelector("#sensitivity-value");
const audioModeControl = document.querySelector("#audio-mode-control");
const audioModeValue = document.querySelector("#audio-mode-value");
const vadReadout = document.querySelector("#vad-readout");
const typedTurnForm = document.querySelector("#typed-turn");
const typedTurnInput = document.querySelector("#typed-turn-input");

const sessionId = `browser-${crypto.randomUUID()}`;
let turnCounter = 0;
let callerRoom = null;
let agentRoom = null;
let listenStream = null;
let audioContext = null;
let analyser = null;
let vadFrame = null;
let lastVadFrameAt = 0;
let lastVadAudioTime = null;
let lastVadAudioAdvanceAt = 0;
let recorder = null;
let recordedChunks = [];
let recordingStartedAt = 0;
let lastSpeechAt = 0;
let speechCandidateAt = 0;
let bargeCandidateAt = 0;
let lastBargeHitAt = 0;
let listenCooldownUntil = 0;
let agentBusy = false;
let agentSpeaking = false;
let muted = false;
let noiseFloor = 0.008;
let smoothedLevel = 0;
let discardRecording = false;
let lastEndpointAt = 0;
let playbackStartedAt = 0;
let playbackEndedAt = 0;
let playbackEchoFloor = 0.012;
let playbackEchoPeak = 0.02;
let turnMaxLevel = 0;
let audioMode = "speaker";
let pendingBargeInTurn = false;
let currentTurnWasBargeIn = false;
let currentTurnAfterPlayback = false;
let activeAgentAudio = null;
let playbackToken = 0;
let playbackWatchdog = 0;
let playbackWatchdogDeadline = 0;
let playbackWatchdogRemainingMs = 0;
let bargeRecordingCandidate = false;
let pendingBargeDetectedAt = 0;
let playbackBackend = null;
let playbackHasStarted = false;
let bargeProbe = null;
let suspendedPlayback = null;
let microphoneSettings = {};
let speechActivity = null;
let speechActivityRequest = null;
let lastActivityCheckAt = 0;
let bargeRetryAt = 0;
let bargeRetryCount = 0;
let currentBargeTimings = null;
const clientEvents = [];

const tuning = {
  endpointSilenceMs: Number(endpointControl?.value || 1000),
  sensitivity: Number(sensitivityControl?.value || 3.6),
  minTurnMs: 400,
  speechConfirmationMs: 130,
  speechHangoverMs: 220,
  bargeInConfirmationMs: 130,
  bargeInArmMs: 140,
  bargeEchoMultiple: 1.25,
  postPlaybackHoldMs: 500,
  afterPlaybackEchoMs: 1500,
  playbackVolume: 0.35,
  maxTurnMs: 25000,
};

/** Longer multi-clause answers need more pause room than short yes/no replies. */
function effectiveEndpointSilenceMs(turnDurationMs) {
  const base = tuning.endpointSilenceMs;
  if (turnDurationMs < 1500) return base;
  const extra = Math.min(550, Math.floor((turnDurationMs - 1500) * 0.28));
  return base + extra;
}

function resetListeningCalibration(reason = "mode_change") {
  // Speaker bleed can inflate the floor; switching to headset must not keep that gate.
  noiseFloor = 0.008;
  smoothedLevel = 0;
  playbackEchoFloor = 0.012;
  playbackEchoPeak = 0.02;
  speechCandidateAt = 0;
  bargeCandidateAt = 0;
  lastBargeHitAt = 0;
  bargeRecordingCandidate = false;
  listenCooldownUntil = 0;
  if (listenStream) appendRuntimeEvent(`vad.recalibrate | ${reason}`);
}

function applyAudioMode(mode) {
  rejectBargeProbe("mode_change");
  audioMode = mode;
  if (mode === "speaker") {
    // Tuned for laptop speaker: harder barge gate so playback echo does not self-interrupt.
    tuning.speechConfirmationMs = 140;
    tuning.bargeInConfirmationMs = 220;
    tuning.bargeInArmMs = 280;
    tuning.postPlaybackHoldMs = 700;
    tuning.afterPlaybackEchoMs = 1800;
    tuning.bargeEchoMultiple = 1.45;
    tuning.playbackVolume = 0.3;
    if (audioModeValue) audioModeValue.textContent = "Laptop Speaker";
  } else {
    // Tuned for headset: quiet mic + no acoustic echo — keep speech pickup easy.
    tuning.speechConfirmationMs = 80;
    tuning.bargeInConfirmationMs = 90;
    tuning.bargeInArmMs = 60;
    tuning.postPlaybackHoldMs = 120;
    tuning.afterPlaybackEchoMs = 400;
    tuning.bargeEchoMultiple = 1.1;
    tuning.playbackVolume = 1;
    if (audioModeValue) audioModeValue.textContent = "Headset";
  }
  resetListeningCalibration(mode);
  if (activeAgentAudio) activeAgentAudio.volume = tuning.playbackVolume;
  if (muted && listenStream) {
    setListeningState("Muted", "Unmute to speak — microphone input is paused.");
  } else if (listenStream && !agentSpeaking && !agentBusy) {
    setListeningState("Listening", "Speak naturally. Aurora can be interrupted while talking.");
  }
}

function setCallControls(connected) {
  startButton.disabled = connected;
  muteButton.disabled = !connected;
  endButton.disabled = !connected;
  if (interruptButton) {
    interruptButton.disabled = !connected || !agentSpeaking;
    interruptButton.classList.toggle("interrupt-ready", connected && agentSpeaking);
  }
  callerRoot.classList.toggle("connected", connected);
  agentRoot.classList.toggle("connected", connected);
}

function setInterruptEnabled(enabled) {
  if (!interruptButton) return;
  interruptButton.disabled = !listenStream || !enabled;
  interruptButton.classList.toggle("interrupt-ready", Boolean(listenStream && enabled));
}

function setListeningState(state, detail) {
  listeningStateEl.textContent = state;
  listeningStateEl.dataset.state = state.toLowerCase().replace(/\s+/g, "-");
  voiceStatusEl.textContent = detail;
}

function addTranscript(role, text, meta = "") {
  transcriptEl.querySelector(".empty")?.remove();
  const item = document.createElement("article");
  item.className = `turn ${role}`;
  const label = document.createElement("div");
  label.className = "turn-label";
  const speaker = document.createElement("span");
  speaker.className = "turn-speaker";
  speaker.textContent = role === "caller" ? "Caller" : "Aurora Agent";
  label.appendChild(speaker);
  if (meta) {
    const metaEl = document.createElement("span");
    metaEl.className = "turn-meta";
    metaEl.textContent = meta;
    label.appendChild(metaEl);
  }
  const body = document.createElement("div");
  body.className = "turn-body";
  body.textContent = text;
  item.append(label, body);
  transcriptEl.appendChild(item);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return item;
}

function addInterruption() {
  transcriptEl.querySelector(".empty")?.remove();
  const item = document.createElement("div");
  item.className = "turn interruption";
  item.textContent = "Caller interrupted agent playback";
  transcriptEl.appendChild(item);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function formatMs(value) {
  return `${Math.round(value || 0)} ms`;
}

function appendRuntimeEvent(name) {
  clientEvents.push(name);
  vadReadout.dataset.events = JSON.stringify(clientEvents.slice(-20));
}

function renderSources(sources) {
  sourcesEl.textContent = sources?.length
    ? sources.join(" | ")
    : "No retrieval used in the latest turn.";
}

function chooseVoice(locale) {
  if (!("speechSynthesis" in window)) return null;
  const language = locale.toLowerCase().split("-")[0];
  return window.speechSynthesis.getVoices().find(
    (voice) => voice.lang.toLowerCase().startsWith(language),
  ) || null;
}

function clearPlaybackWatchdog() {
  window.clearTimeout(playbackWatchdog);
  playbackWatchdog = 0;
  playbackWatchdogDeadline = 0;
}

function estimateSpeechMs(text) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean).length;
  return Math.min(90000, Math.max(4000, words * 430 + 1600));
}

function schedulePlaybackWatchdog(token, ms) {
  clearPlaybackWatchdog();
  playbackWatchdogDeadline = Date.now() + Math.max(1500, ms);
  playbackWatchdog = window.setTimeout(() => {
    if (token !== playbackToken || !agentSpeaking || suspendedPlayback) return;
    appendRuntimeEvent("tts.playback_watchdog");
    // Stop stalled output before reopening the mic; do not capture its tail.
    if (recorder) stopTurnRecording(true);
    stopAgentPlayback();
    finishAgentPlayback(playbackToken);
  }, Math.max(1500, ms));
}

function armAgentOutput(token, backend) {
  if (token !== playbackToken) return;
  agentSpeaking = true;
  playbackBackend = backend;
  playbackStartedAt = 0;
  speechCandidateAt = bargeCandidateAt = 0;
  bargeRecordingCandidate = false;
  if (recorder && !currentTurnWasBargeIn) stopTurnRecording(true);
  agentRoot.classList.add("speaking");
  setInterruptEnabled(true);
  setListeningState("Agent speaking", "Speak over Aurora to interrupt.");
  schedulePlaybackWatchdog(token, 20000);
}

function stopAgentPlayback() {
  clearPlaybackWatchdog();
  playbackWatchdogRemainingMs = 0;
  playbackToken += 1;
  bargeProbe = null;
  suspendedPlayback = null;
  playbackHasStarted = false;
  playbackBackend = null;
  if ("speechSynthesis" in window) {
    try { window.speechSynthesis.resume(); } catch { /* ignore */ }
    window.speechSynthesis.cancel();
  }
  if (activeAgentAudio) {
    activeAgentAudio.onplay = null;
    activeAgentAudio.onended = null;
    activeAgentAudio.onerror = null;
    activeAgentAudio.pause();
    activeAgentAudio.removeAttribute("src");
    activeAgentAudio = null;
  }
}

function beginAgentPlayback(token, backend) {
  // onplay fires again on resume; browser onstart may follow our speak() fallback.
  if (token !== playbackToken || playbackHasStarted) return;
  playbackHasStarted = true;
  playbackBackend = backend;
  agentSpeaking = true;
  agentRoot.classList.add("speaking");
  setInterruptEnabled(true);
  playbackStartedAt = Date.now();
  playbackEchoFloor = Math.max(noiseFloor, 0.012);
  playbackEchoPeak = Math.max(smoothedLevel, 0.02);
  listenCooldownUntil = playbackStartedAt + tuning.bargeInArmMs;
  bargeCandidateAt = 0;
  bargeRecordingCandidate = false;
  speechCandidateAt = 0;
  if (recorder) stopTurnRecording(true);
  if (activeAgentAudio) activeAgentAudio.volume = tuning.playbackVolume;
  appendRuntimeEvent(`tts.playback_started | ${backend}`);
  if (lastEndpointAt) {
    const firstAudioMs = Date.now() - lastEndpointAt;
    appendRuntimeEvent(`turn.first_audio | ${formatMs(firstAudioMs)}`);
    const timings = JSON.parse(vadReadout.dataset.lastTurnTimings || "null");
    if (timings?.endpointAt === lastEndpointAt) {
      vadReadout.dataset.lastTurnTimings = JSON.stringify({ ...timings,
        endpointToFirstAudioMs: firstAudioMs,
        deliveryAndPlaybackMs: firstAudioMs - timings.requestRoundTripMs });
    }
    lastEndpointAt = 0;
  }
  setListeningState(
    "Agent speaking",
    audioMode === "speaker"
      ? "Speak now to interrupt, or click Interrupt / press Space."
      : "Speak over Aurora to interrupt.",
  );
}

function finishAgentPlayback(token) {
  if (token !== playbackToken) return;
  clearPlaybackWatchdog();
  appendRuntimeEvent(`tts.playback_ended | ${playbackBackend}`);
  // A candidate may have captured only the final syllable of Aurora's reply.
  // Do not promote that pre-roll to a caller turn just because output ended.
  // Preserve its onset and require the same speech check after output ends.
  const unconfirmedCandidate = recorder && (bargeRecordingCandidate || bargeProbe);
  if (bargeProbe?.checking) bargeProbe.outputFinished = true;
  suspendedPlayback = null;
  if (unconfirmedCandidate) appendRuntimeEvent("barge_in.verify_after_playback");
  playbackHasStarted = false;
  playbackBackend = null;
  activeAgentAudio = null;
  agentSpeaking = false;
  agentRoot.classList.remove("speaking");
  setInterruptEnabled(false);
  playbackEndedAt = Date.now();
  // Hold off listening until speaker reverb decays; stops self-turns after TTS.
  listenCooldownUntil = playbackEndedAt + tuning.postPlaybackHoldMs;
  bargeCandidateAt = unconfirmedCandidate ? bargeCandidateAt : 0;
  bargeRecordingCandidate = Boolean(unconfirmedCandidate);
  speechCandidateAt = 0;
  if (listenStream) {
    setListeningState("Listening", "Speak naturally. Aurora can be interrupted while talking.");
  }
}

function speakWithBrowserVoice(text, locale, token) {
  if (!("speechSynthesis" in window) || token !== playbackToken) {
    finishAgentPlayback(token);
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = locale;
  utterance.rate = 0.98;
  utterance.pitch = 1.0;
  utterance.volume = tuning.playbackVolume;
  const voice = chooseVoice(locale);
  if (voice) utterance.voice = voice;

  utterance.onstart = () => {
    beginAgentPlayback(token, "browser");
    schedulePlaybackWatchdog(token, estimateSpeechMs(text));
  };
  utterance.onend = () => finishAgentPlayback(token);
  utterance.onerror = (event) => {
    if (token !== playbackToken) return;
    const reason = event?.error || "unknown";
    // A preceding cancel can settle asynchronously. Retry once, preserving
    // the token guard so a replaced reply can never be replayed.
    if ((reason === "interrupted" || reason === "canceled") && agentSpeaking
        && !suspendedPlayback && !utterance.__retried) {
      utterance.__retried = true;
      appendRuntimeEvent(`tts.browser_retry | ${reason}`);
      window.setTimeout(() => {
        if (token !== playbackToken || !agentSpeaking || suspendedPlayback) return;
        window.speechSynthesis.resume();
        window.speechSynthesis.speak(utterance);
      }, 120);
      return;
    }
    appendRuntimeEvent(`tts.playback_error | browser | ${reason}`);
    finishAgentPlayback(token);
  };
  schedulePlaybackWatchdog(token, estimateSpeechMs(text));
  window.speechSynthesis.speak(utterance);
  // Some Chromium embeds never fire onstart; arm barge-in from the speak() call.
  if (!playbackHasStarted) beginAgentPlayback(token, "browser");
}

function speak(text, locale = "en-US", audioBase64 = "", audioContentType = "audio/wav") {
  // Do not play a completed older reply over a confirmed ongoing caller.
  if (recorder?.state === "recording" && currentTurnWasBargeIn && !bargeRecordingCandidate && !bargeProbe) {
    appendRuntimeEvent("tts.skipped_during_barge");
    return;
  }
  stopAgentPlayback();
  const token = playbackToken;
  armAgentOutput(token, audioBase64 ? "audio" : "browser");
  if (!audioBase64) {
    speakWithBrowserVoice(text, locale, token);
    return;
  }

  const audio = new Audio(`data:${audioContentType};base64,${audioBase64}`);
  audio.volume = tuning.playbackVolume;
  activeAgentAudio = audio;
  let fellBack = false;
  const fallback = () => {
    if (fellBack || token !== playbackToken) return;
    fellBack = true;
    const hadCandidate = Boolean(bargeProbe || bargeRecordingCandidate);
    bargeProbe = null;
    suspendedPlayback = null;
    if (hadCandidate) stopTurnRecording(true);
    audio.onplay = audio.onended = audio.onerror = null;
    audio.pause();
    activeAgentAudio = null;
    playbackHasStarted = false;
    appendRuntimeEvent("tts.provider_playback_failed | browser fallback");
    speakWithBrowserVoice(text, locale, token);
  };
  const noteDuration = () => {
    if (token !== playbackToken || suspendedPlayback || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    schedulePlaybackWatchdog(token, Math.max(0, audio.duration - (audio.currentTime || 0)) * 1000 + 1200);
  };
  audio.onloadedmetadata = noteDuration;
  audio.onplay = () => {
    beginAgentPlayback(token, "audio");
    noteDuration();
  };
  audio.onended = () => finishAgentPlayback(token);
  audio.onerror = fallback;
  audio.play().catch(fallback);
}

function forceInterrupt() {
  if (!listenStream) return;
  const isSpeaking = agentSpeaking
    || ("speechSynthesis" in window && window.speechSynthesis.speaking)
    || Boolean(activeAgentAudio);

  if (!isSpeaking && !agentBusy) return;
  const detectedAt = Date.now();
  appendRuntimeEvent("barge_in.manual");
  interruptAgent(detectedAt, Boolean(recorder));
  if (!recorder) {
    startTurnRecording(true);
  }
  lastSpeechAt = detectedAt;
}

function interruptAgent(detectedAt, turnAlreadyRecording = false) {
  stopAgentPlayback();
  agentSpeaking = false;
  agentRoot.classList.remove("speaking");
  setInterruptEnabled(false);
  playbackEndedAt = Date.now();
  listenCooldownUntil = 0;
  pendingBargeInTurn = !turnAlreadyRecording;
  pendingBargeDetectedAt = detectedAt;
  setListeningState("Interrupted", "Aurora stopped. Listening to your answer.");
}

function commitBargeIn(detectedAt) {
  addInterruption();
  appendRuntimeEvent(`barge_in.detected | ${formatMs(Date.now() - detectedAt)}`);
  pendingBargeDetectedAt = 0;
}

function audioLevel() {
  if (!analyser) return 0;
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function thresholds() {
  if (audioMode === "headset") {
    // Headset mics are quieter than laptop mics. Higher UI sensitivity = easier pickup.
    const ease = Math.max(1.3, 5.6 - tuning.sensitivity);
    const start = Math.min(0.032, Math.max(0.007, noiseFloor * ease));
    const barge = Math.max(0.011, start * 1.08);
    return {
      start,
      end: Math.max(0.003, start * 0.4),
      barge,
    };
  }

  // Capture quiet callers even when speaker echo is louder. Energy only opens
  // a recorded speech check; it must never pause or interrupt the output.
  // Preserve the slider's higher-value/easier-pickup behavior for speakers.
  const ease = Math.max(1.6, 5.2 - tuning.sensitivity);
  const start = Math.min(0.04, Math.max(0.01, noiseFloor * ease));
  const barge = Math.min(start, Math.max(0.007, noiseFloor * ease));
  return {
    start,
    // Keep end lower than start so quieter mid-phrase syllables still count as speech.
    end: Math.max(0.004, start * 0.4),
    quietFloor: Math.max(0.01, noiseFloor * ease * 0.9),
    barge,
  };
}

// Transcribe captured input while Aurora keeps playing. Only confirmed caller
// text may pause output; rejected echo must have no audible effect at all.
async function startBargeProbe(detectedAt) {
  if (bargeProbe || suspendedPlayback || !recorder || recorder.state !== "recording" || agentBusy || muted) return;
  const candidateRecorder = recorder;
  const probe = {
    token: playbackToken, detectedAt, startedAt: Date.now(), speechAt: 0,
    echoLevel: smoothedLevel, backend: playbackBackend, audio: activeAgentAudio,
    checking: true, outputFinished: !agentSpeaking,
    capturedMs: Date.now() - recordingStartedAt,
  };
  bargeProbe = probe;
  const audioBlob = new Blob(recordedChunks, { type: candidateRecorder.mimeType || "audio/webm" });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    if (await isSilentRecording(audioBlob)) {
      if (bargeProbe === probe) rejectBargeProbe("silent_recording");
      return;
    }
    if (bargeProbe !== probe || probe.token !== playbackToken) return;
    appendRuntimeEvent(`barge_in.check_started | ${probe.backend}`);
    const response = await fetch("/voice-agent", {
      method: "POST", signal: controller.signal,
      headers: {
        "Content-Type": audioBlob.type, "X-Session-ID": sessionId,
        "X-Turn-ID": `check-${++turnCounter}`, "X-Barge-In": "true",
        "X-Playback-Check": "true",
        "X-Capture-Ms": String(probe.capturedMs),
        "X-Onset-To-Check-Ms": String(probe.startedAt - detectedAt),
      },
      body: audioBlob,
    });
    const payload = await response.json();
    if (bargeProbe !== probe || probe.token !== playbackToken || recorder !== candidateRecorder) return;
    vadReadout.dataset.lastSpeechCheck = JSON.stringify({
      transcript: payload.transcript, ignored: Boolean(payload.ignored),
      reason: payload.ignoreReason, durationMs: Date.now() - probe.startedAt,
    });
    if (!response.ok) throw new Error("speech check failed");
    currentBargeTimings = {
      onsetToCheckMs: probe.startedAt - detectedAt,
      checkRoundTripMs: Date.now() - probe.startedAt,
      serverStages: payload.trace?.timings,
    };
    vadReadout.dataset.lastBargeTimings = JSON.stringify(currentBargeTimings);
    if (!payload.inputConfirmed || payload.ignored) {
      // A preview is only a prefix. Keep speech arriving while STT was running,
      // and give a weak initial consonant a full capture window before rejection.
      const laterSpeech = speechActivity?.available
        && speechActivity.evidence.lastSpeechMs > (payload.speechEvidence?.durationMs ?? probe.capturedMs);
      if (bargeRetryCount < 2 && Date.now() - recordingStartedAt < tuning.maxTurnMs
          && (laterSpeech || (payload.ignoreReason === "no_speech" && Date.now() - recordingStartedAt < 900))) {
        bargeProbe = null;
        bargeRetryCount++;
        bargeRetryAt = Math.max(Date.now() + 150, recordingStartedAt + 900);
        appendRuntimeEvent(`barge_in.check_retrying | ${payload.ignoreReason || "unconfirmed_speech"}`);
        return;
      }
      rejectBargeProbe(payload.ignoreReason || "unconfirmed_speech");
      return;
    }
    bargeProbe = null;
    bargeRecordingCandidate = false;
    if (!probe.outputFinished) {
      suspendedPlayback = probe;
      playbackWatchdogRemainingMs = Math.max(1500, playbackWatchdogDeadline - Date.now());
      clearPlaybackWatchdog();
      if (probe.audio) probe.audio.pause();
      else window.speechSynthesis.pause();
      const pauseAcknowledged = probe.audio ? probe.audio.paused : window.speechSynthesis.paused;
      appendRuntimeEvent(`barge_in.pause_acknowledged | ${pauseAcknowledged}`);
      // Some embedded browsers keep native synthesis playing after pause().
      // Its continuing output must not be submitted as a confirmed caller turn.
      if (!pauseAcknowledged) throw new Error("playback did not pause");
    }
    agentSpeaking = false;
    agentRoot.classList.remove("speaking");
    setInterruptEnabled(false);
    playbackEndedAt = Date.now();
    listenCooldownUntil = 0;
    pendingBargeDetectedAt = detectedAt;
    // The caller may already have finished while STT was in flight. Do not
    // restart the silence timer at the response time when acoustic evidence exists.
    if (!speechActivity?.available) lastSpeechAt = Date.now();
    appendRuntimeEvent(`barge_in.speech_confirmed | ${Date.now() - detectedAt} ms`);
    vadReadout.dataset.interruptionLatencyMs = String(Date.now() - detectedAt);
    currentBargeTimings.onsetToPauseMs = Date.now() - detectedAt;
    vadReadout.dataset.lastBargeTimings = JSON.stringify(currentBargeTimings);
    setListeningState("Caller speaking", "Listening for the end of the turn.");
  } catch {
    if (bargeProbe === probe) rejectBargeProbe("check_failed");
    else if (suspendedPlayback === probe) {
      resumeSuspendedPlayback("pause_failed");
      stopTurnRecording(true);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function resumeSuspendedPlayback(reason) {
  const paused = suspendedPlayback;
  suspendedPlayback = null;
  bargeProbe = null;
  pendingBargeDetectedAt = 0;
  pendingBargeInTurn = false;
  bargeCandidateAt = lastBargeHitAt = 0;
  bargeRecordingCandidate = false;
  if (!paused || paused.token !== playbackToken || !listenStream) return false;
  // Learn the rejected level so the same echo does not repeatedly pause output.
  if (audioMode === "speaker") playbackEchoPeak = Math.max(playbackEchoPeak, paused.echoLevel);
  agentSpeaking = true;
  agentRoot.classList.add("speaking");
  setInterruptEnabled(true);
  playbackStartedAt = Date.now();
  smoothedLevel = 0;
  appendRuntimeEvent(`barge_in.resumed | ${reason}`);
  setListeningState("Agent speaking", "Speak over Aurora to interrupt.");
  schedulePlaybackWatchdog(paused.token, playbackWatchdogRemainingMs || 20000);
  try {
    if (paused.audio) {
      paused.audio.play().catch(() => {
        if (paused.token !== playbackToken) return;
        appendRuntimeEvent("tts.playback_error | provider resume");
        finishAgentPlayback(paused.token);
      });
    } else {
      window.speechSynthesis.resume();
    }
  } catch {
    appendRuntimeEvent(`tts.playback_error | ${paused.backend} resume`);
    finishAgentPlayback(paused.token);
    return false;
  }
  return true;
}

function rejectBargeProbe(reason) {
  if (!bargeProbe) return;
  if (bargeProbe.checking) appendRuntimeEvent(`barge_in.check_rejected | ${reason}`);
  if (bargeProbe.outputFinished) appendRuntimeEvent(`barge_in.candidate_dropped | ${reason}`);
  resumeSuspendedPlayback(reason);
  stopTurnRecording(true);
}

function maybeStartBargeProbe() {
  if (!bargeRecordingCandidate || bargeProbe || recorder?.state !== "recording") return;
  const now = Date.now();
  if (now < bargeRetryAt) return;
  const duration = now - recordingStartedAt;
  if (recordedChunks.reduce((sum, chunk) => sum + chunk.size, 0) < 300) return;
  if (duration >= 900 || (duration >= 400 && now - lastBargeHitAt >= 180)) {
    startBargeProbe(bargeCandidateAt);
  }
}

async function maybeCheckSpeechActivity(force = false) {
  if (!recorder || recorder.state !== "recording" || muted || speechActivityRequest
      || speechActivity?.available === false) return;
  const now = Date.now();
  if (now - recordingStartedAt < 400 || (!force && now - lastActivityCheckAt < 500)) return;
  const blob = new Blob(recordedChunks, { type: recorder.mimeType || "audio/webm" });
  if (blob.size < 300) return;
  const request = { recorder, capturedAt: now, controller: new AbortController() };
  speechActivityRequest = request;
  lastActivityCheckAt = now;
  const timeout = setTimeout(() => request.controller.abort(), 2000);
  try {
    const response = await fetch("/speech-activity", {
      method: "POST", signal: request.controller.signal,
      headers: { "Content-Type": blob.type, "X-Session-ID": sessionId,
        "X-Turn-ID": `activity-${++turnCounter}` }, body: blob,
    });
    const payload = await response.json();
    if (recorder !== request.recorder || recorder.state !== "recording") return;
    const evidence = response.ok ? payload.speechEvidence : null;
    const available = evidence && Number.isFinite(evidence.durationMs)
      && (evidence.lastSpeechMs === null || Number.isFinite(evidence.lastSpeechMs));
    speechActivity = { available: Boolean(available), evidence, capturedAt: request.capturedAt };
    if (available) {
      lastSpeechAt = recordingStartedAt + (evidence.lastSpeechMs ?? 0);
      vadReadout.dataset.speechActivity = JSON.stringify({ ...evidence,
        roundTripMs: Date.now() - request.capturedAt });
    }
  } catch {
    if (recorder === request.recorder) speechActivity = { available: false };
  } finally {
    clearTimeout(timeout);
    if (speechActivityRequest === request) speechActivityRequest = null;
  }
}

function startTurnRecording(isBargeIn = false) {
  if (!listenStream || recorder || agentBusy || muted) return false;
  recordedChunks = [];
  discardRecording = false;
  turnMaxLevel = smoothedLevel;
  recorder = new MediaRecorder(listenStream);
  const turnRecorder = recorder;
  speechActivity = null;
  lastActivityCheckAt = 0;
  bargeRetryAt = 0;
  bargeRetryCount = 0;
  currentBargeTimings = null;
  currentTurnWasBargeIn = isBargeIn || pendingBargeInTurn;
  currentTurnAfterPlayback = Boolean(
    playbackEndedAt && Date.now() - playbackEndedAt < tuning.afterPlaybackEchoMs,
  );
  pendingBargeInTurn = false;
  recordingStartedAt = Date.now();
  appendRuntimeEvent(`vad.turn_started | ${currentTurnWasBargeIn ? "barge_candidate" : currentTurnAfterPlayback ? "after_playback" : "caller"}`);
  lastSpeechAt = recordingStartedAt;
  callerRoot.classList.add("speaking");
  recorder.ondataavailable = (event) => {
    if (recorder !== turnRecorder) return;
    if (event.data.size > 0) recordedChunks.push(event.data);
    maybeStartBargeProbe();
  };
  recorder.onstop = () => {
    if (recorder !== turnRecorder) return;
    const shouldDiscard = discardRecording;
    const mimeType = recorder.mimeType || "audio/webm";
    const audioBlob = new Blob(recordedChunks, { type: mimeType });
    const wasBargeIn = currentTurnWasBargeIn;
    const maxLevel = turnMaxLevel;
    recorder = null;
    recordedChunks = [];
    callerRoot.classList.remove("speaking");
    const limit = thresholds();
    const isTooQuiet = !wasBargeIn && !speechActivity?.evidence?.voicedMs && maxLevel < (limit.quietFloor ?? limit.start) * 1.05;
    const minBlobSize = wasBargeIn ? 300 : 500;
    if (shouldDiscard || audioBlob.size < minBlobSize || isTooQuiet) {
      appendRuntimeEvent(`vad.turn_discarded | ${shouldDiscard ? "unconfirmed" : isTooQuiet ? "quiet" : "small"}`);
      currentTurnWasBargeIn = false;
      currentTurnAfterPlayback = false;
      if (wasBargeIn && resumeSuspendedPlayback("turn_discarded")) return;
      if (agentSpeaking) {
        setListeningState("Agent speaking", "Interrupt naturally by speaking over Aurora.");
      } else if (listenStream) {
        setListeningState("Listening", "Speak naturally. Aurora can be interrupted while talking.");
      }
      return;
    }
    appendRuntimeEvent(`vad.turn_sent | ${wasBargeIn ? "barge" : currentTurnAfterPlayback ? "after_playback" : "caller"}`);
    sendAudioToAgent(audioBlob);
  };
  try {
    recorder.start(100);
  } catch {
    recorder = null;
    recordedChunks = [];
    currentTurnWasBargeIn = false;
    callerRoot.classList.remove("speaking");
    appendRuntimeEvent("vad.record_failed");
    setListeningState("Listening", "Microphone didn't start. Speak again.");
    return false;
  }
  setListeningState("Caller speaking", "Listening for the end of the turn.");
  return true;
}

function stopTurnRecording(discard = false) {
  if (!recorder || recorder.state === "inactive") return;
  discardRecording = discard;
  speechActivityRequest?.controller.abort();
  recorder.stop();
}

function ttsLabel(payload) {
  if (payload.ttsBackend === "system") return `System TTS: ${payload.ttsVoice}`;
  if (payload.ttsBackend === "provider") return `TTS: ${payload.ttsVoice || payload.ttsModel}`;
  return "Browser TTS";
}

function applyAgentPayload(payload, { callerLabel = "", callerMeta = "" } = {}) {
  if (callerLabel) addTranscript("caller", callerLabel, callerMeta);
  const ttsMeta = ttsLabel(payload);
  const meta = [payload.language?.toUpperCase(), ttsMeta, payload.action ? `action: ${payload.action}` : ""]
    .filter(Boolean)
    .join(" | ");
  addTranscript("agent", payload.reply, meta);
  providerEl.textContent = `Provider: ${payload.provider} | ${payload.model} | ${ttsMeta}`;
  const languageLabels = { en: "English", es: "Spanish", ta: "Tamil" };
  languageEl.textContent = languageLabels[payload.language] || "English";
  renderSources(payload.sources);
  speak(
    payload.reply,
    payload.locale || "en-US",
    payload.audioBase64 || "",
    payload.audioContentType || "audio/wav",
  );
  if (payload.action === "transfer") agentStatus.textContent = "Transferring";
  if (payload.action === "hangup") agentStatus.textContent = "Call complete";
}

async function isSilentRecording(audioBlob) {
  if (!audioContext?.decodeAudioData) {
    vadReadout.dataset.lastClipCheck = JSON.stringify({ decoded: false, reason: "decoder_unavailable", bytes: audioBlob.size });
    return false;
  }
  try {
    const decoded = await audioContext.decodeAudioData(await audioBlob.arrayBuffer());
    // Inspect the recorded clip, not the analyser's last buffer. A speech
    // detector can otherwise start a recorder that captures only silence, and
    // Whisper can confidently invent text for that clip. Keep even one audible
    // 20 ms window so brief caller replies remain eligible for transcription.
    const windowSize = Math.max(1, Math.round(decoded.sampleRate * 0.02));
    let peakWindowRms = 0;
    let audibleWindows = 0;
    let windows = 0;
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const samples = decoded.getChannelData(channel);
      for (let start = 0; start < samples.length; start += windowSize) {
        const end = Math.min(samples.length, start + windowSize);
        let sum = 0;
        for (let index = start; index < end; index++) sum += samples[index] ** 2;
        const rms = Math.sqrt(sum / (end - start));
        peakWindowRms = Math.max(peakWindowRms, rms);
        audibleWindows += Number(rms >= 0.001);
        windows++;
      }
    }
    vadReadout.dataset.lastClipCheck = JSON.stringify({ decoded: true, peakWindowRms, audibleWindows, windows,
      sampleRate: decoded.sampleRate, bytes: audioBlob.size });
    return audibleWindows === 0;
  } catch (error) {
    vadReadout.dataset.lastClipCheck = JSON.stringify({ decoded: false, reason: error.name, bytes: audioBlob.size });
    // Some browsers cannot decode their recording format. Keep the existing
    // transcription path in that case rather than reject unverified audio.
    return false;
  }
}

async function sendAudioToAgent(audioBlob) {
  const requestStartedAt = Date.now();
  const captureMs = requestStartedAt - recordingStartedAt;
  vadReadout.dataset.lastTurnTimings = JSON.stringify({
    source: "voice", endpointAt: lastEndpointAt,
    endpointAfterLastSpeechMs: lastEndpointAt - lastSpeechAt,
    endpointMethod: speechActivity?.available ? "silero" : "energy",
  });
  const requestPlaybackToken = playbackToken;
  agentBusy = true;
  setListeningState("Processing", "Transcribing and running the hotel agent.");
  const voicePlaceholder = addTranscript("caller", "Voice turn", "transcribing");
  const pending = addTranscript("agent", "Processing turn", "STT -> Router -> RAG -> LLM -> Tools");
  const turnId = `turn-${++turnCounter}`;
  const wasBargeIn = currentTurnWasBargeIn;
  const afterPlayback = currentTurnAfterPlayback;
  currentTurnWasBargeIn = false;
  currentTurnAfterPlayback = false;

  try {
    const silent = await isSilentRecording(audioBlob);
    if (requestPlaybackToken !== playbackToken) {
      pending.remove();
      voicePlaceholder.remove();
      return;
    }
    if (silent) {
      pending.remove();
      voicePlaceholder.remove();
      pendingBargeDetectedAt = 0;
      agentBusy = false;
      appendRuntimeEvent("audio.suppressed | silent_recording");
      if (wasBargeIn && resumeSuspendedPlayback("silent_recording")) return;
      setListeningState("Listening", "No speech was detected. Continue speaking naturally.");
      return;
    }
    const response = await fetch("/voice-agent", {
      method: "POST",
      headers: {
        "Content-Type": audioBlob.type || "audio/webm",
        "X-Session-ID": sessionId,
        "X-Turn-ID": turnId,
        "X-Barge-In": String(wasBargeIn),
        "X-After-Playback": String(afterPlayback),
        "X-Capture-Ms": String(captureMs),
        "X-Endpoint-After-Speech-Ms": String(lastEndpointAt - lastSpeechAt),
        "X-Endpoint-Method": speechActivity?.available ? "silero" : "energy",
        ...(wasBargeIn && currentBargeTimings
          ? { "X-Onset-To-Pause-Ms": String(currentBargeTimings.onsetToPauseMs) } : {}),
      },
      body: audioBlob,
    });
    const payload = await response.json();
    vadReadout.dataset.lastTurnTimings = JSON.stringify({
      ...JSON.parse(vadReadout.dataset.lastTurnTimings),
      requestRoundTripMs: Date.now() - requestStartedAt,
      serverStages: payload.trace?.timings,
    });
    pending.remove();
    if (requestPlaybackToken !== playbackToken) {
      voicePlaceholder.remove();
      return;
    }
    if (!response.ok) throw new Error(payload.error || `Voice request failed: ${response.status}`);

    if (payload.ignored) {
      voicePlaceholder.remove();
      pendingBargeDetectedAt = 0;
      const candidate = clientEvents.lastIndexOf("barge_in.candidate");
      if (wasBargeIn && candidate >= 0) clientEvents.splice(candidate, 1);
      appendRuntimeEvent(`audio.suppressed | ${payload.ignoreReason}`);
      renderSources([]);
      agentBusy = false;
      if (wasBargeIn && resumeSuspendedPlayback(payload.ignoreReason)) return;
      setListeningState("Listening", payload.ignoreReason === "no_speech"
        ? "No speech was detected. Continue speaking naturally."
        : "Playback echo was suppressed. Continue speaking naturally.");
      return;
    }

    voicePlaceholder.remove();
    if (wasBargeIn && pendingBargeDetectedAt) commitBargeIn(pendingBargeDetectedAt);
    applyAgentPayload(payload, {
      callerLabel: payload.transcript,
      callerMeta: `STT: ${payload.sttModel}`,
    });
    agentBusy = false;
  } catch (error) {
    pending.remove();
    voicePlaceholder.remove();
    if (requestPlaybackToken !== playbackToken) return;
    agentBusy = false;
    if (wasBargeIn && suspendedPlayback) {
      appendRuntimeEvent(`barge_in.request_failed | ${error.message}`);
      if (resumeSuspendedPlayback("request_failed")) return;
    }
    addTranscript("agent", error.message, "error");
    setListeningState("Error", "The turn failed. Speak again to retry.");
  }
}

async function sendTextToAgent(text) {
  const cleaned = text.trim();
  if (!cleaned || agentBusy) return;
  agentBusy = true;
  setListeningState("Processing", "Running the hotel agent on a typed turn.");
  const pending = addTranscript("agent", "Processing turn", "Router -> RAG -> LLM -> Tools");
  const turnId = `turn-${++turnCounter}`;
  lastEndpointAt = Date.now();
  const textRequestStartedAt = lastEndpointAt;
  vadReadout.dataset.lastTurnTimings = JSON.stringify({ source: "typed", endpointAt: lastEndpointAt });
  try {
    const response = await fetch("/agent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-ID": sessionId,
        "X-Turn-ID": turnId,
      },
      body: JSON.stringify({ text: cleaned }),
    });
    const payload = await response.json();
    vadReadout.dataset.lastTurnTimings = JSON.stringify({ source: "typed", endpointAt: textRequestStartedAt,
      requestRoundTripMs: Date.now() - textRequestStartedAt, serverStages: payload.trace?.timings });
    pending.remove();
    if (!response.ok) throw new Error(payload.error || `Agent request failed: ${response.status}`);
    applyAgentPayload(payload, { callerLabel: cleaned, callerMeta: "typed" });
    agentBusy = false;
    setListeningState(
      listenStream ? "Listening" : "Idle",
      listenStream ? "Speak naturally, or type the next line." : "Start the call to speak, or keep typing.",
    );
  } catch (error) {
    pending.remove();
    addTranscript("agent", error.message, "error");
    agentBusy = false;
    setListeningState("Error", "The typed turn failed. Try again.");
  }
}

typedTurnForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = typedTurnInput.value;
  typedTurnInput.value = "";
  sendTextToAgent(value);
});

function vadLoop() {
  if (!listenStream) return;
  const now = Date.now();
  const audioTime = audioContext?.currentTime;
  const repeatedAudio = typeof audioTime === "number" && audioTime === lastVadAudioTime;
  if (!repeatedAudio) lastVadAudioAdvanceAt = now;
  lastVadAudioTime = audioTime ?? null;
  if (repeatedAudio && now - lastVadAudioAdvanceAt <= 250 && audioContext.state === "running") {
    // rAF can run more often than the audio clock; don't count duplicate samples.
    vadFrame = requestAnimationFrame(vadLoop);
    return;
  }
  // An interrupted/suspended context can keep returning its last analyser
  // buffer. It is not evidence of speech, even when render frames continue.
  if (audioContext && (audioContext.state !== "running" || repeatedAudio)) {
    speechCandidateAt = bargeCandidateAt = lastBargeHitAt = 0;
    lastVadFrameAt = smoothedLevel = 0;
    bargeRecordingCandidate = false;
    if (bargeProbe) rejectBargeProbe("listener_unavailable");
    else if (recorder) {
      resumeSuspendedPlayback("listener_unavailable");
      stopTurnRecording(true);
      appendRuntimeEvent("vad.turn_discarded | listener_unavailable");
    }
    vadFrame = requestAnimationFrame(vadLoop);
    return;
  }
  const rawLevel = audioLevel();
  const frameGap = lastVadFrameAt ? now - lastVadFrameAt : 0;
  lastVadFrameAt = now;
  // Backgrounding or a stalled render must not count two isolated echo peaks
  // as continuous speech, nor carry a stale playback average into listening.
  if (frameGap > 250) {
    speechCandidateAt = 0;
    // MediaRecorder uses the audio clock. Its captured speech remains valid
    // across render gaps; only unsampled energy-based confirmation resets.
  }
  smoothedLevel = frameGap > 250 ? rawLevel : (smoothedLevel * 0.72) + (rawLevel * 0.28);
  vadReadout.dataset.level = rawLevel.toFixed(4);
  vadReadout.dataset.playback = JSON.stringify({
    agentSpeaking, nativeSpeaking: window.speechSynthesis?.speaking,
    nativePaused: window.speechSynthesis?.paused, nativePending: window.speechSynthesis?.pending,
    endedAgo: playbackEndedAt ? now - playbackEndedAt : null,
    recording: Boolean(recorder), probing: Boolean(bargeProbe), frameGap,
    audioContext: audioContext?.state, audioTime,
    outputTime: activeAgentAudio?.currentTime ?? null,
    outputDuration: activeAgentAudio?.duration ?? null,
    outputPaused: activeAgentAudio?.paused ?? null,
    agentBusy, candidate: bargeRecordingCandidate, suspended: Boolean(suspendedPlayback),
    recorderState: recorder?.state ?? null, chunks: recordedChunks.length,
    recordedBytes: recordedChunks.reduce((sum, chunk) => sum + chunk.size, 0),
    recordingMs: recorder ? now - recordingStartedAt : null,
  });
  const limit = thresholds();
  maybeCheckSpeechActivity();

  if (!recorder && !agentSpeaking && smoothedLevel < limit.start) {
    // Cap samples so speaker bleed never becomes the "ambient" floor.
    const sample = Math.min(rawLevel, audioMode === "headset" ? 0.02 : 0.016);
    noiseFloor = (noiseFloor * 0.985) + (sample * 0.015);
  }
  vadReadout.textContent = agentSpeaking
    ? `noise ${noiseFloor.toFixed(3)} | input ${limit.barge.toFixed(3)}`
    : `noise ${noiseFloor.toFixed(3)} | trigger ${limit.start.toFixed(3)}`;

  if (bargeProbe || (bargeRecordingCandidate && !agentSpeaking)) {
    // The microphone and recorder stay live while the speech check runs.
    // No energy-based decision is allowed to pause output here.
  } else if (agentSpeaking && !muted) {
    const bargeHit = rawLevel > limit.barge;
    if (bargeHit) {
      lastBargeHitAt = now;
      if (!recorder && startTurnRecording(true)) {
        bargeCandidateAt = now;
        bargeRecordingCandidate = true;
        appendRuntimeEvent("barge_in.candidate");
      }
    }
  } else if (!agentBusy && !muted) {
    if (!recorder && now <= listenCooldownUntil) {
      if (audioMode === "headset" && rawLevel > limit.start * 1.05 && smoothedLevel > limit.start * 1.05) {
        // Headphones: allow speaking through a short post-playback hold.
        listenCooldownUntil = 0;
        speechCandidateAt = speechCandidateAt || now;
      } else if (smoothedLevel < limit.start * 1.5) {
        const sample = Math.min(rawLevel, audioMode === "headset" ? 0.02 : 0.016);
        noiseFloor = (noiseFloor * 0.95) + (sample * 0.05);
      }
    } else if (!recorder) {
      // Capture the onset immediately; local classification decides whether
      // this is speech. Waiting for sustained energy clips brief initial words.
      if (rawLevel > limit.start) startTurnRecording();
    } else {
      turnMaxLevel = Math.max(turnMaxLevel, smoothedLevel);
      // Only fresh speech renews the endpoint clock. The old lower-energy
      // hangover renewed itself forever on modest room noise, so an answer
      // could wait for the 25-second maximum instead of reaching its endpoint.
      const speechEnergy = rawLevel > limit.end && smoothedLevel > limit.end;
      if (!speechActivity?.available && speechEnergy) lastSpeechAt = now;
      const duration = now - recordingStartedAt;
      const silenceNeeded = effectiveEndpointSilenceMs(speechActivity?.available
        ? speechActivity.evidence.voicedMs : duration);
      const endpointReached = duration >= tuning.minTurnMs
        && now - lastSpeechAt >= silenceNeeded;
      if (endpointReached || duration >= tuning.maxTurnMs) {
        // Refresh stale evidence before ending on neural silence. Never hold
        // indefinitely: the local check times out and restores the energy path.
        if (endpointReached && speechActivity?.available && duration < tuning.maxTurnMs
            && now - speechActivity.capturedAt > 250) {
          maybeCheckSpeechActivity(true);
          vadFrame = requestAnimationFrame(vadLoop);
          return;
        }
        lastEndpointAt = Date.now();
        appendRuntimeEvent(
          endpointReached
            ? `vad.endpoint_detected | silence ${silenceNeeded}ms`
            : "vad.max_turn_reached",
        );
        stopTurnRecording(Boolean(speechActivity?.available && !speechActivity.evidence.voicedMs));
      }
    }
  }

  // Encoders may stop delivering timeslice chunks during digital silence.
  // A brief caller can finish before the final chunk meets the preview clock;
  // evaluate the captured clip from the live VAD clock as well as chunk events.
  maybeStartBargeProbe();
  vadFrame = requestAnimationFrame(vadLoop);
}

async function connectParticipant(identity, name) {
  const params = new URLSearchParams({ identity, name });
  const response = await fetch(`/token?${params}`);
  if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
  const session = await response.json();
  // The embedded browser rejects the offer-with-join configuration update.
  // The SDK's legacy join creates each connection with its final ICE settings.
  const room = new Room({ adaptiveStream: true, dynacast: true, singlePeerConnection: false });
  await room.connect(session.url, session.token);
  return room;
}

async function prepareListener() {
  listenStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      voiceIsolation: { ideal: true },
      channelCount: 1,
    },
  });
  // Constraints are requests, not proof that the device enabled processing.
  const captureTrack = listenStream.getAudioTracks()[0];
  const capabilities = captureTrack.getCapabilities?.() || {};
  // Boolean true leaves the cancellation scope up to the browser. Native TTS
  // may be system audio, so prefer cancellation of all playout when supported.
  if (capabilities.echoCancellation?.includes("all")) {
    try { await captureTrack.applyConstraints({ echoCancellation: { exact: "all" } }); }
    catch { appendRuntimeEvent("audio.echo_scope | default fallback"); }
  }
  const settings = captureTrack.getSettings();
  microphoneSettings = Object.fromEntries(
    ["echoCancellation", "noiseSuppression", "autoGainControl", "sampleRate", "channelCount"]
      .map((key) => [key, settings[key] ?? "unknown"]),
  );
  microphoneSettings.inputDevice = captureTrack.label || "unknown";
  vadReadout.dataset.microphoneSettings = JSON.stringify(microphoneSettings);
  vadReadout.dataset.browser = navigator.userAgent;
  vadReadout.dataset.echoCapabilities = JSON.stringify(capabilities.echoCancellation || []);
  vadReadout.dataset.echoConstraints = JSON.stringify(captureTrack.getConstraints?.().echoCancellation || null);
  appendRuntimeEvent(`audio.capture_settings | ${JSON.stringify(microphoneSettings)}`);
  audioContext = new AudioContext();
  lastVadFrameAt = 0;
  lastVadAudioTime = null;
  lastVadAudioAdvanceAt = 0;
  const source = audioContext.createMediaStreamSource(listenStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  setListeningState("Calibrating", "Measuring the room noise floor.");
  vadFrame = requestAnimationFrame(vadLoop);
  await new Promise((resolve) => setTimeout(resolve, 650));
  setListeningState("Listening", "Speak naturally. Aurora can be interrupted while talking.");
}

async function startCall() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error("This browser does not support the required audio APIs.");
  }
  setCallControls(true);
  agentBusy = true;
  callerStatus.textContent = "Connecting";
  agentStatus.textContent = "Connecting";
  await fetch("/reset", { method: "POST", headers: { "X-Session-ID": sessionId } });
  agentRoom = await connectParticipant("aurora-agent", "Aurora Agent");
  agentStatus.textContent = "Connected";
  await prepareListener();
  callerRoom = await connectParticipant("caller-demo", "Caller");
  await callerRoom.localParticipant.publishTrack(listenStream.getAudioTracks()[0], {
    source: Track.Source.Microphone,
    name: "caller-microphone",
  });
  callerStatus.textContent = "Connected";
  try {
    const greetingResponse = await fetch("/greeting", {
      method: "POST",
      headers: { "X-Session-ID": sessionId },
    });
    const greeting = await greetingResponse.json();
    if (!greetingResponse.ok) throw new Error(greeting.error || "Greeting failed");
    const ttsMeta = ttsLabel(greeting);
    providerEl.textContent = `Provider: ${greeting.provider} | ${greeting.model} | ${ttsMeta}`;
    agentBusy = false;
    speak(
      greeting.reply,
      greeting.locale || "en-US",
      greeting.audioBase64 || "",
      greeting.audioContentType || "audio/wav",
    );
  } catch (error) {
    agentBusy = false;
    appendRuntimeEvent("tts.greeting_fallback | browser");
    speak("Thanks for calling Aurora Hotel reservations. How can I help?", "en-US");
  }
}

async function endCall() {
  if (vadFrame) cancelAnimationFrame(vadFrame);
  vadFrame = null;
  lastVadFrameAt = 0;
  lastVadAudioTime = null;
  lastVadAudioAdvanceAt = 0;
  stopTurnRecording(true);
  stopAgentPlayback();
  agentSpeaking = false;
  agentBusy = false;
  bargeRecordingCandidate = false;
  bargeCandidateAt = 0;
  pendingBargeDetectedAt = 0;
  clientEvents.length = 0;
  listenStream?.getTracks().forEach((track) => track.stop());
  listenStream = null;
  if (audioContext) await audioContext.close();
  audioContext = null;
  analyser = null;
  callerRoom?.disconnect();
  agentRoom?.disconnect();
  callerRoom = null;
  agentRoom = null;
  callerRoot.classList.remove("speaking");
  agentRoot.classList.remove("speaking");
  callerStatus.textContent = "Ready";
  agentStatus.textContent = "Waiting";
  setListeningState("Idle", "Start the call, then speak naturally");
  setCallControls(false);
}

async function toggleMute() {
  muted = !muted;
  if (muted) {
    rejectBargeProbe("muted");
    // Normal caller recordings need the same discard as preview candidates.
    // Otherwise VAD stops evaluating their endpoint while muted, leaving an
    // open recorder that can merge speech from before and after the mute.
    stopTurnRecording(true);
    if (suspendedPlayback && !agentBusy) {
      resumeSuspendedPlayback("muted");
    }
  }
  listenStream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  muteButton.textContent = muted ? "Unmute" : "Mute";
  callerStatus.textContent = muted ? "Muted" : "Connected";
  setListeningState(muted ? "Muted" : "Listening", muted
    ? "Microphone input is paused."
    : "Speak naturally. Aurora can be interrupted while talking.");
}

async function loadState() {
  try {
    const response = await fetch("/state");
    const state = await response.json();
    providerEl.textContent = `Provider: ${state.agentProvider}`;
  } catch {
    providerEl.textContent = "Provider: unavailable";
  }
}

endpointControl.addEventListener("input", () => {
  tuning.endpointSilenceMs = Number(endpointControl.value);
  endpointValue.textContent = `${tuning.endpointSilenceMs} ms`;
});

sensitivityControl.addEventListener("input", () => {
  tuning.sensitivity = Number(sensitivityControl.value);
  sensitivityValue.textContent = `${tuning.sensitivity.toFixed(1)}x`;
  resetListeningCalibration("sensitivity");
});

audioModeControl?.addEventListener("change", () => {
  applyAudioMode(audioModeControl.value);
});

function unlockAudioOutput() {
  // Must run inside the click. Later playback is outside the gesture, and
  // Chromium will not start it unless this page already played audio.
  if ("speechSynthesis" in window) {
    try { window.speechSynthesis.resume(); } catch { /* ignore */ }
    const primer = new SpeechSynthesisUtterance(" ");
    primer.volume = 0.01;
    primer.rate = 2;
    window.speechSynthesis.speak(primer);
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (Ctx) {
    const ctx = new Ctx();
    ctx.resume().finally(() => ctx.close()).catch(() => {});
  }
}

startButton.addEventListener("click", () => {
  unlockAudioOutput();
  startCall().catch(async (error) => {
    await endCall();
    appendRuntimeEvent(`call.connection_failed | ${error.message}`);
    setListeningState("Connection failed", error.message);
  });
});
interruptButton?.addEventListener("click", () => forceInterrupt());
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat) return;
  const tag = (event.target && event.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || event.target?.isContentEditable) return;
  if (!agentSpeaking) return;
  event.preventDefault();
  forceInterrupt();
});
muteButton.addEventListener("click", () => toggleMute().catch((error) => {
  setListeningState("Mute failed", error.message);
}));
endButton.addEventListener("click", () => endCall());

setCallControls(false);
applyAudioMode(audioModeControl?.value || "speaker");
loadState();

/** Workshop/demo hooks for endpoint silence checks (FDE-228). */
window.__auroraTalk = {
  sessionId: () => sessionId,
  endpointMs: () => tuning.endpointSilenceMs,
  setEndpoint(ms) {
    if (!endpointControl) return tuning.endpointSilenceMs;
    endpointControl.value = String(ms);
    endpointControl.dispatchEvent(new Event("input", { bubbles: true }));
    return tuning.endpointSilenceMs;
  },
  clientEvents: () => [...clientEvents],
  state: () => ({
    listening: listeningStateEl?.textContent || "",
    muted,
    agentSpeaking,
    agentBusy,
    endpointMs: tuning.endpointSilenceMs,
    noiseFloor,
    trigger: thresholds().start,
    playbackBackend,
    bargeProbe: Boolean(bargeProbe),
    playbackSuspended: Boolean(suspendedPlayback),
    microphoneSettings: { ...microphoneSettings },
  }),
  async injectSpeechBursts({ burstMs = 420, gapMs = 500, level = 0.22 } = {}) {
    if (!audioContext || !analyser) throw new Error("Call is not listening yet.");
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = "sawtooth";
    osc.frequency.value = 210;
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(analyser);
    osc.start();
    const t0 = audioContext.currentTime;
    const b = burstMs / 1000;
    const g = gapMs / 1000;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(level, t0 + 0.02);
    gain.gain.setValueAtTime(level, t0 + b);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + b + 0.03);
    gain.gain.setValueAtTime(0.0001, t0 + b + g);
    gain.gain.exponentialRampToValueAtTime(level, t0 + b + g + 0.02);
    gain.gain.setValueAtTime(level, t0 + 2 * b + g);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 2 * b + g + 0.03);
    await new Promise((resolve) => setTimeout(resolve, burstMs * 2 + gapMs + 80));
    try { osc.stop(); } catch { /* ignore */ }
    osc.disconnect();
    gain.disconnect();
  },
  speakDemo(text, locale = "en-US") {
    speak(text, locale);
  },
  forceInterrupt() {
    forceInterrupt();
  },
};
