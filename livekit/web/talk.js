import { Room, RoomEvent, Track } from "/node_modules/livekit-client/dist/livekit-client.esm.mjs";

const callerRoot = document.querySelector('[data-client="caller"]');
const agentRoot = document.querySelector('[data-client="agent"]');
const callerStatus = callerRoot.querySelector('[data-role="status"]');
const agentStatus = agentRoot.querySelector('[data-role="status"]');
const startButton = document.querySelector("#start-call");
const muteButton = document.querySelector("#mute-call");
const endButton = document.querySelector("#end-call");
const participantsEl = document.querySelector("#participants");
const providerEl = document.querySelector("#provider");
const languageEl = document.querySelector("#language");
const transcriptEl = document.querySelector("#transcript");
const sourcesEl = document.querySelector("#sources");
const voiceStatusEl = document.querySelector("#voice-status");
const listeningStateEl = document.querySelector("#listening-state");
const eventsEl = document.querySelector("#events");
const pipelineEl = document.querySelector("#pipeline");
const endpointControl = document.querySelector("#endpoint-control");
const endpointValue = document.querySelector("#endpoint-value");
const sensitivityControl = document.querySelector("#sensitivity-control");
const sensitivityValue = document.querySelector("#sensitivity-value");
const vadReadout = document.querySelector("#vad-readout");
const typedTurnForm = document.querySelector("#typed-turn");
const typedTurnInput = document.querySelector("#typed-turn-input");

const metrics = {
  stt: document.querySelector("#metric-stt"),
  llm: document.querySelector("#metric-llm"),
  tools: document.querySelector("#metric-tools"),
  total: document.querySelector("#metric-total"),
  firstAudio: document.querySelector("#metric-first-audio"),
  barge: document.querySelector("#metric-barge"),
};

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
let listenCooldownUntil = 0;
let agentBusy = false;
let agentSpeaking = false;
let muted = false;
let noiseFloor = 0.008;
let smoothedLevel = 0;
let discardRecording = false;
let currentTrace = null;
let lastEndpointAt = 0;
let playbackStartedAt = 0;
let playbackEndedAt = 0;
let playbackEchoFloor = 0.012;
let pendingBargeInTurn = false;
let currentTurnWasBargeIn = false;
let currentTurnAfterPlayback = false;
let activeAgentAudio = null;
let playbackToken = 0;
let bargeRecordingCandidate = false;
let pendingBargeDetectedAt = 0;
const clientEvents = [];

const tuning = {
  endpointSilenceMs: 650,
  sensitivity: 3.2,
  minTurnMs: 500,
  speechConfirmationMs: 110,
  // Speaker echo is loud and steady; require a longer, louder burst to interrupt.
  bargeInConfirmationMs: 480,
  bargeInArmMs: 700,
  bargeEchoMultiple: 3.4,
  postPlaybackHoldMs: 1600,
  afterPlaybackEchoMs: 2800,
  maxTurnMs: 20000,
};

function setCallControls(connected) {
  startButton.disabled = connected;
  muteButton.disabled = !connected;
  endButton.disabled = !connected;
  callerRoot.classList.toggle("connected", connected);
  agentRoot.classList.toggle("connected", connected);
}

function setListeningState(state, detail) {
  listeningStateEl.textContent = state;
  voiceStatusEl.textContent = detail;
}

function addTranscript(role, text, meta = "") {
  transcriptEl.querySelector(".empty")?.remove();
  const item = document.createElement("div");
  item.className = `bubble ${role}`;
  const label = document.createElement("div");
  label.className = "bubble-label";
  label.textContent = `${role === "caller" ? "Caller Demo" : "Aurora Agent"}${meta ? ` | ${meta}` : ""}`;
  const body = document.createElement("div");
  body.textContent = text;
  item.append(label, body);
  transcriptEl.appendChild(item);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return item;
}

function addInterruption() {
  transcriptEl.querySelector(".empty")?.remove();
  const item = document.createElement("div");
  item.className = "bubble interruption";
  item.textContent = "Caller interrupted agent playback";
  transcriptEl.appendChild(item);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function formatMs(value) {
  return `${Math.round(value || 0)} ms`;
}

function eventDetail(event) {
  const attributes = event.attributes || {};
  if (attributes.tool) return `${event.name} | ${attributes.tool}`;
  if (attributes.language) return `${event.name} | ${attributes.language}`;
  if (attributes.durationMs !== undefined) return `${event.name} | ${formatMs(attributes.durationMs)}`;
  return event.name;
}

function renderTrace(trace) {
  currentTrace = trace;
  const timings = trace.timings || {};
  metrics.stt.textContent = formatMs(timings.stt);
  metrics.llm.textContent = formatMs(timings.llm);
  metrics.tools.textContent = formatMs(timings.tools);
  metrics.total.textContent = formatMs(trace.totalMs);

  for (const element of pipelineEl.querySelectorAll("[data-stage]")) {
    const stage = element.dataset.stage;
    const completed = stage === "vad" || timings[stage] !== undefined;
    element.classList.toggle("complete", completed);
  }

  paintEvents();
}

function paintEvents() {
  eventsEl.innerHTML = "";
  const serverEvents = (currentTrace?.events || []).slice(-14);
  if (!clientEvents.length && !serverEvents.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Turn events will appear here.";
    eventsEl.appendChild(empty);
    return;
  }
  for (const name of clientEvents.slice(-8)) {
    const row = document.createElement("div");
    row.className = "event-row";
    const time = document.createElement("time");
    time.textContent = "client";
    const detail = document.createElement("span");
    detail.textContent = name;
    row.append(time, detail);
    eventsEl.appendChild(row);
  }
  for (const event of serverEvents) {
    const row = document.createElement("div");
    row.className = "event-row";
    const time = document.createElement("time");
    time.textContent = `+${Math.round(event.offsetMs)}ms`;
    const detail = document.createElement("span");
    detail.textContent = eventDetail(event);
    row.append(time, detail);
    eventsEl.appendChild(row);
  }
  eventsEl.scrollTop = eventsEl.scrollHeight;
}

function appendRuntimeEvent(name) {
  clientEvents.push(name);
  paintEvents();
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
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
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
  playbackStartedAt = Date.now();
  playbackEchoFloor = Math.max(noiseFloor, 0.012);
  listenCooldownUntil = playbackStartedAt + tuning.bargeInArmMs;
  bargeCandidateAt = 0;
  bargeRecordingCandidate = false;
  if (recorder) stopTurnRecording(true);
  pipelineEl.querySelector('[data-stage="tts"]')?.classList.add("complete");
  appendRuntimeEvent(`tts.playback_started | ${backend}`);
  if (lastEndpointAt) {
    const firstAudioMs = Date.now() - lastEndpointAt;
    metrics.firstAudio.textContent = formatMs(firstAudioMs);
    appendRuntimeEvent(`turn.first_audio | ${formatMs(firstAudioMs)}`);
    lastEndpointAt = 0;
  }
  setListeningState("Agent speaking", "Interrupt naturally by speaking over Aurora.");
}

function finishAgentPlayback(token) {
  if (token !== playbackToken) return;
  activeAgentAudio = null;
  agentSpeaking = false;
  agentRoot.classList.remove("speaking");
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
  const voice = chooseVoice(locale);
  if (voice) utterance.voice = voice;

  utterance.onstart = () => beginAgentPlayback(token, "browser");
  utterance.onend = () => finishAgentPlayback(token);
  utterance.onerror = () => finishAgentPlayback(token);
  window.speechSynthesis.speak(utterance);
}

function speak(text, locale = "en-US", audioBase64 = "", audioContentType = "audio/wav") {
  stopAgentPlayback();
  const token = playbackToken;
  if (!audioBase64) {
    speakWithBrowserVoice(text, locale, token);
    return;
  }

  const audio = new Audio(`data:${audioContentType};base64,${audioBase64}`);
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

function interruptAgent(detectedAt, turnAlreadyRecording = false) {
  if (!agentSpeaking) return;
  stopAgentPlayback();
  agentSpeaking = false;
  agentRoot.classList.remove("speaking");
  playbackEndedAt = Date.now();
  listenCooldownUntil = Date.now() + 80;
  pendingBargeInTurn = !turnAlreadyRecording;
  pendingBargeDetectedAt = detectedAt;
  setListeningState("Interrupted", "Aurora stopped. Listening to the caller.");
}

function commitBargeIn(detectedAt) {
  addInterruption();
  appendRuntimeEvent("barge_in.detected");
  metrics.barge.textContent = formatMs(Date.now() - detectedAt);
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
  const start = Math.min(0.09, Math.max(0.012, noiseFloor * tuning.sensitivity));
  // Speaker playback often sits near playbackEchoFloor; barge must clear it clearly.
  const barge = Math.min(
    0.18,
    Math.max(0.045, start * 2.1, playbackEchoFloor * tuning.bargeEchoMultiple),
  );
  return {
    start,
    end: Math.max(0.008, start * 0.58),
    barge,
  };
}

function startTurnRecording(isBargeIn = false) {
  if (!listenStream || recorder || agentBusy || muted) return;
  recordedChunks = [];
  discardRecording = false;
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
    recorder = null;
    recordedChunks = [];
    callerRoot.classList.remove("speaking");
    if (shouldDiscard || audioBlob.size < 800) {
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
  renderTrace(payload.trace);
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
      renderTrace(payload.trace);
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
    noiseFloor = (noiseFloor * 0.985) + (rawLevel * 0.015);
  }
  vadReadout.textContent = agentSpeaking
    ? `echo ${playbackEchoFloor.toFixed(3)} | barge ${limit.barge.toFixed(3)}`
    : `noise ${noiseFloor.toFixed(3)} | trigger ${limit.start.toFixed(3)}`;

  if (agentSpeaking && !muted) {
    const playbackAge = now - playbackStartedAt;
    // Track speaker bleed into the mic so the barge threshold rides above it.
    playbackEchoFloor = (playbackEchoFloor * 0.82) + (smoothedLevel * 0.18);
    if (playbackAge < tuning.bargeInArmMs) {
      bargeCandidateAt = 0;
      bargeRecordingCandidate = false;
    } else if (smoothedLevel > limit.barge) {
      if (!bargeCandidateAt) {
        bargeCandidateAt = now;
        bargeRecordingCandidate = true;
        appendRuntimeEvent("barge_in.candidate");
      }
      // Only interrupt + record after sustained loud speech. Do not record echo
      // candidates early — that is what made Aurora cut herself off on speakers.
      if (now - bargeCandidateAt >= tuning.bargeInConfirmationMs) {
        bargeRecordingCandidate = false;
        interruptAgent(bargeCandidateAt, false);
        startTurnRecording(true);
        lastSpeechAt = now;
        bargeCandidateAt = 0;
      }
    } else {
      if (bargeRecordingCandidate) {
        bargeRecordingCandidate = false;
        appendRuntimeEvent("barge_in.candidate_dropped");
      }
      bargeCandidateAt = 0;
    }
  } else if (!agentBusy && !muted && now > listenCooldownUntil) {
    if (!recorder) {
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
      if (smoothedLevel > limit.end) lastSpeechAt = now;
      const duration = now - recordingStartedAt;
      const endpointReached = duration >= tuning.minTurnMs
        && now - lastSpeechAt >= tuning.endpointSilenceMs;
      if (endpointReached || duration >= tuning.maxTurnMs) {
        lastEndpointAt = Date.now();
        appendRuntimeEvent(endpointReached ? "vad.endpoint_detected" : "vad.max_turn_reached");
        stopTurnRecording();
      }
    }
  }

  vadFrame = requestAnimationFrame(vadLoop);
}

function attachRoomEvents(room) {
  room.on(RoomEvent.ParticipantConnected, renderParticipants);
  room.on(RoomEvent.ParticipantDisconnected, renderParticipants);
  room.on(RoomEvent.TrackPublished, renderParticipants);
  room.on(RoomEvent.TrackUnpublished, renderParticipants);
  room.on(RoomEvent.Disconnected, renderParticipants);
}

async function connectParticipant(identity, name) {
  const params = new URLSearchParams({ identity, name });
  const response = await fetch(`/token?${params}`);
  if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
  const session = await response.json();
  const room = new Room({ adaptiveStream: true, dynacast: true });
  attachRoomEvents(room);
  await room.connect(session.url, session.token);
  return room;
}

function renderParticipants() {
  participantsEl.innerHTML = "";
  if (!callerRoom) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Participants join when the call starts.";
    participantsEl.appendChild(empty);
    return;
  }

  const participants = [callerRoom.localParticipant, ...callerRoom.remoteParticipants.values()];
  for (const participant of participants) {
    const row = document.createElement("div");
    row.className = "participant";
    const name = document.createElement("strong");
    name.textContent = participant.name || participant.identity;
    const state = document.createElement("span");
    const audioPublished = [...participant.trackPublications.values()]
      .some((publication) => publication.kind === "audio");
    state.textContent = audioPublished ? "audio published" : "room participant";
    row.append(name, state);
    participantsEl.appendChild(row);
  }
}

async function prepareListener() {
  listenStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
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
  callerRoom = await connectParticipant("caller-demo", "Caller Demo");
  await callerRoom.localParticipant.publishTrack(listenStream.getAudioTracks()[0], {
    source: Track.Source.Microphone,
    name: "caller-microphone",
  });
  callerStatus.textContent = "Connected";
  renderParticipants();
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
    renderTrace(greeting.trace);
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
  currentTrace = null;
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
  renderParticipants();
  paintEvents();
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
});

startButton.addEventListener("click", () => {
  startCall().catch(async (error) => {
    setListeningState("Connection failed", error.message);
    await endCall();
  });
});
muteButton.addEventListener("click", () => toggleMute().catch((error) => {
  setListeningState("Mute failed", error.message);
}));
endButton.addEventListener("click", () => endCall());

setCallControls(false);
loadState();
