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
let bargeRecordingCandidate = false;
let pendingBargeDetectedAt = 0;
const clientEvents = [];

const tuning = {
  endpointSilenceMs: Number(endpointControl?.value || 1000),
  sensitivity: 3.2,
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

function stopAgentPlayback() {
  playbackToken += 1;
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
  if (token !== playbackToken) return;
  agentSpeaking = true;
  agentRoot.classList.add("speaking");
  setInterruptEnabled(true);
  playbackStartedAt = Date.now();
  playbackEchoFloor = Math.max(noiseFloor, 0.012);
  playbackEchoPeak = Math.max(smoothedLevel, 0.02);
  listenCooldownUntil = playbackStartedAt + tuning.bargeInArmMs;
  bargeCandidateAt = 0;
  bargeRecordingCandidate = false;
  if (recorder) stopTurnRecording(true);
  if (activeAgentAudio) activeAgentAudio.volume = tuning.playbackVolume;
  appendRuntimeEvent(`tts.playback_started | ${backend}`);
  if (lastEndpointAt) {
    const firstAudioMs = Date.now() - lastEndpointAt;
    appendRuntimeEvent(`turn.first_audio | ${formatMs(firstAudioMs)}`);
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
  activeAgentAudio = null;
  agentSpeaking = false;
  agentRoot.classList.remove("speaking");
  setInterruptEnabled(false);
  playbackEndedAt = Date.now();
  // Hold off listening until speaker reverb decays; stops self-turns after TTS.
  listenCooldownUntil = playbackEndedAt + tuning.postPlaybackHoldMs;
  bargeCandidateAt = 0;
  bargeRecordingCandidate = false;
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

  utterance.onstart = () => beginAgentPlayback(token, "browser");
  utterance.onend = () => finishAgentPlayback(token);
  utterance.onerror = () => finishAgentPlayback(token);
  window.speechSynthesis.speak(utterance);
  // Some Chromium embeds never fire onstart; arm barge-in from the speak() call.
  if (!agentSpeaking) beginAgentPlayback(token, "browser");
}

function speak(text, locale = "en-US", audioBase64 = "", audioContentType = "audio/wav") {
  stopAgentPlayback();
  const token = playbackToken;
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
    activeAgentAudio = null;
    appendRuntimeEvent("tts.provider_playback_failed | browser fallback");
    speakWithBrowserVoice(text, locale, token);
  };
  audio.onplay = () => beginAgentPlayback(token, "provider");
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
  interruptAgent(detectedAt, false);
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

  // Speaker mode:
  // Echo floor tracks Aurora's speaker bleed. Require a clearer voice spike to barge.
  const start = Math.min(0.09, Math.max(0.012, noiseFloor * tuning.sensitivity));
  const barge = Math.min(
    0.085,
    Math.max(0.03, start * 1.35, playbackEchoFloor * tuning.bargeEchoMultiple + 0.008),
  );
  return {
    start,
    // Keep end lower than start so quieter mid-phrase syllables still count as speech.
    end: Math.max(0.005, start * 0.42),
    barge,
  };
}

function duckAgentPlayback() {
  if (activeAgentAudio) {
    activeAgentAudio.volume = Math.min(tuning.playbackVolume * 0.3, 0.12);
  }
}

function restoreAgentPlaybackVolume() {
  if (activeAgentAudio) {
    activeAgentAudio.volume = tuning.playbackVolume;
  }
}

function startTurnRecording(isBargeIn = false) {
  if (!listenStream || recorder || agentBusy || muted) return;
  recordedChunks = [];
  discardRecording = false;
  turnMaxLevel = smoothedLevel;
  recorder = new MediaRecorder(listenStream);
  currentTurnWasBargeIn = isBargeIn || pendingBargeInTurn;
  currentTurnAfterPlayback = Boolean(
    playbackEndedAt && Date.now() - playbackEndedAt < tuning.afterPlaybackEchoMs,
  );
  pendingBargeInTurn = false;
  recordingStartedAt = Date.now();
  lastSpeechAt = recordingStartedAt;
  callerRoot.classList.add("speaking");
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) recordedChunks.push(event.data);
  };
  recorder.onstop = () => {
    const shouldDiscard = discardRecording;
    const mimeType = recorder.mimeType || "audio/webm";
    const audioBlob = new Blob(recordedChunks, { type: mimeType });
    const wasBargeIn = currentTurnWasBargeIn;
    const maxLevel = turnMaxLevel;
    recorder = null;
    recordedChunks = [];
    callerRoot.classList.remove("speaking");
    const limit = thresholds();
    const isTooQuiet = !wasBargeIn && maxLevel < limit.start * 1.1;
    const minBlobSize = wasBargeIn ? 300 : 500;
    if (shouldDiscard || audioBlob.size < minBlobSize || isTooQuiet) {
      currentTurnWasBargeIn = false;
      if (agentSpeaking) {
        setListeningState("Agent speaking", "Interrupt naturally by speaking over Aurora.");
      } else if (listenStream) {
        setListeningState("Listening", "Speak naturally. Aurora can be interrupted while talking.");
      }
      return;
    }
    sendAudioToAgent(audioBlob);
  };
  recorder.start(100);
  setListeningState("Caller speaking", "Listening for the end of the turn.");
}

function stopTurnRecording(discard = false) {
  if (!recorder || recorder.state === "inactive") return;
  discardRecording = discard;
  recorder.stop();
}

function applyAgentPayload(payload, { callerLabel = "", callerMeta = "" } = {}) {
  if (callerLabel) addTranscript("caller", callerLabel, callerMeta);
  const ttsMeta = payload.ttsBackend === "provider"
    ? `TTS: ${payload.ttsVoice || payload.ttsModel}`
    : "Browser TTS";
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

async function sendAudioToAgent(audioBlob) {
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
    const response = await fetch("/voice-agent", {
      method: "POST",
      headers: {
        "Content-Type": audioBlob.type || "audio/webm",
        "X-Session-ID": sessionId,
        "X-Turn-ID": turnId,
        "X-Barge-In": String(wasBargeIn),
        "X-After-Playback": String(afterPlayback),
      },
      body: audioBlob,
    });
    const payload = await response.json();
    pending.remove();
    if (!response.ok) throw new Error(payload.error || `Voice request failed: ${response.status}`);

    if (payload.ignored) {
      voicePlaceholder.remove();
      pendingBargeDetectedAt = 0;
      const candidate = clientEvents.lastIndexOf("barge_in.candidate");
      if (wasBargeIn && candidate >= 0) clientEvents.splice(candidate, 1);
      appendRuntimeEvent(`audio.suppressed | ${payload.ignoreReason}`);
      renderSources([]);
      agentBusy = false;
      setListeningState("Listening", "Playback echo was suppressed. Continue speaking naturally.");
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
    addTranscript("agent", error.message, "error");
    agentBusy = false;
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
  const rawLevel = audioLevel();
  smoothedLevel = (smoothedLevel * 0.72) + (rawLevel * 0.28);
  const limit = thresholds();

  if (!recorder && !agentSpeaking && !agentBusy && smoothedLevel < limit.start) {
    // Cap samples so speaker bleed never becomes the "ambient" floor.
    const sample = Math.min(rawLevel, audioMode === "headset" ? 0.02 : 0.016);
    noiseFloor = (noiseFloor * 0.985) + (sample * 0.015);
  }
  vadReadout.textContent = agentSpeaking
    ? `echo ${playbackEchoFloor.toFixed(3)} | barge ${limit.barge.toFixed(3)}`
    : `noise ${noiseFloor.toFixed(3)} | trigger ${limit.start.toFixed(3)}`;

  if (agentSpeaking && !muted) {
    const playbackAge = now - playbackStartedAt;
    if (audioMode === "speaker") {
      // Learn steady speaker echo; do not let peaks raise the barge gate.
      if (!bargeCandidateAt && smoothedLevel < limit.barge * 0.9) {
        playbackEchoFloor = (playbackEchoFloor * 0.88) + (smoothedLevel * 0.12);
        playbackEchoPeak = Math.max(playbackEchoPeak * 0.94, smoothedLevel);
      } else {
        playbackEchoPeak *= 0.98;
      }
    } else if (!bargeCandidateAt && smoothedLevel < limit.barge * 0.9) {
      playbackEchoFloor = (playbackEchoFloor * 0.9) + (smoothedLevel * 0.1);
      playbackEchoPeak = Math.max(playbackEchoPeak * 0.96, smoothedLevel);
    } else {
      playbackEchoPeak *= 0.98;
    }
    const liveLimit = thresholds();
    // In speaker mode, require a clear voice spike above the learned echo floor.
    const relativeSpike = smoothedLevel > (playbackEchoFloor * 1.38 + 0.008);
    const bargeHit = smoothedLevel > liveLimit.barge || (audioMode === "speaker" && relativeSpike);

    if (playbackAge < tuning.bargeInArmMs) {
      bargeCandidateAt = 0;
      lastBargeHitAt = 0;
      bargeRecordingCandidate = false;
    } else if (bargeHit) {
      lastBargeHitAt = now;
      if (!bargeCandidateAt) {
        bargeCandidateAt = now;
        bargeRecordingCandidate = true;
        appendRuntimeEvent("barge_in.candidate");
        duckAgentPlayback();
      }
      if (now - bargeCandidateAt >= tuning.bargeInConfirmationMs) {
        bargeRecordingCandidate = false;
        const candidateStart = bargeCandidateAt;
        bargeCandidateAt = 0;
        lastBargeHitAt = 0;
        interruptAgent(candidateStart, false);
        startTurnRecording(true);
        lastSpeechAt = now;
      }
    } else {
      // Hangover window: keep candidate alive across brief phoneme dips (~140ms)
      const hangoverActive = bargeCandidateAt && (now - lastBargeHitAt < 140);
      if (!hangoverActive) {
        if (bargeRecordingCandidate) {
          bargeRecordingCandidate = false;
          appendRuntimeEvent("barge_in.candidate_dropped");
          restoreAgentPlaybackVolume();
        }
        bargeCandidateAt = 0;
        lastBargeHitAt = 0;
      }
    }
  } else if (!agentBusy && !muted) {
    if (!recorder && now <= listenCooldownUntil) {
      if (audioMode === "headset" && smoothedLevel > limit.start * 1.05) {
        // Headphones: allow speaking through a short post-playback hold.
        listenCooldownUntil = 0;
        speechCandidateAt = speechCandidateAt || now;
      } else if (smoothedLevel < limit.start * 1.5) {
        const sample = Math.min(rawLevel, audioMode === "headset" ? 0.02 : 0.016);
        noiseFloor = (noiseFloor * 0.95) + (sample * 0.05);
      }
    } else if (!recorder) {
      if (smoothedLevel > limit.start) {
        speechCandidateAt = speechCandidateAt || now;
        if (now - speechCandidateAt >= tuning.speechConfirmationMs) {
          startTurnRecording();
          speechCandidateAt = 0;
        }
      } else {
        speechCandidateAt = 0;
      }
    } else {
      turnMaxLevel = Math.max(turnMaxLevel, smoothedLevel);
      // Hangover keeps brief dips between words/clauses from starting the silence clock.
      const speechEnergy = smoothedLevel > limit.end
        || (smoothedLevel > limit.end * 0.55 && now - lastSpeechAt < tuning.speechHangoverMs);
      if (speechEnergy) lastSpeechAt = now;
      const duration = now - recordingStartedAt;
      const silenceNeeded = effectiveEndpointSilenceMs(duration);
      const endpointReached = duration >= tuning.minTurnMs
        && now - lastSpeechAt >= silenceNeeded;
      if (endpointReached || duration >= tuning.maxTurnMs) {
        lastEndpointAt = Date.now();
        appendRuntimeEvent(
          endpointReached
            ? `vad.endpoint_detected | silence ${silenceNeeded}ms`
            : "vad.max_turn_reached",
        );
        stopTurnRecording();
      }
    }
  }

  vadFrame = requestAnimationFrame(vadLoop);
}

async function connectParticipant(identity, name) {
  const params = new URLSearchParams({ identity, name });
  const response = await fetch(`/token?${params}`);
  if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
  const session = await response.json();
  const room = new Room({ adaptiveStream: true, dynacast: true });
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
  audioContext = new AudioContext();
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
    const ttsMeta = greeting.ttsBackend === "provider"
      ? `TTS: ${greeting.ttsVoice || greeting.ttsModel}`
      : "Browser TTS";
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
  if (audioMode === "headset") resetListeningCalibration("sensitivity");
});

audioModeControl?.addEventListener("change", () => {
  applyAudioMode(audioModeControl.value);
});

startButton.addEventListener("click", () => {
  startCall().catch(async (error) => {
    setListeningState("Connection failed", error.message);
    await endCall();
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
