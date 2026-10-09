# Local LiveKit Voice Session

This folder provides the room and browser stage of the Aurora workshop. It runs against a self-contained LiveKit development server and does not require LiveKit Cloud credentials.

## Install

```bash
cd livekit
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
npm install
```

Install FFmpeg on the talk-server host (for example, `brew install ffmpeg` on
macOS). It decodes browser WebM/MP4/Opus for local speech detection. The Python
requirements install the CPU ONNX runtime; the pinned Silero weights and MIT
license are bundled in `vad_models/`, with no model download at runtime. A
compatible mono 16 kHz WAV needs no external decoder. If detection is unavailable,
audio remains eligible for transcription and `vad.evidence.available` is false.

## Run

Terminal 1:

```bash
./start_local_server.sh
```

Terminal 2:

```bash
source .venv/bin/activate
python create_room.py
python talk_server.py
```

Open `http://localhost:5173`, click **Start call**, and allow microphone access. Caller Demo and Aurora Agent join `aurora-demo-room` automatically.

The browser shows:

- LiveKit participants and published audio state
- Caller and agent activity
- Automatic turn detection
- Playback barge-in with candidate pre-roll so the first interrupted word is retained
- English and Spanish routing
- RAG sources
- STT, LLM, tool, server, first-audio, and interruption timing
- Adjustable endpoint silence and speech sensitivity

Language state changes only after an explicit request that names the target
language, such as `Please speak Spanish`, `Please speak Tamil`, or `Switch back to English`. Multilingual
speech by itself does not change the configured response language.

## Local Defaults

```env
LIVEKIT_URL=http://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
LIVEKIT_ROOM=aurora-demo-room
```

Override these values in `livekit/.env` when using another server. The scripts also read `pipeline/.env` for the selected agent provider.

## Provider Behavior

`PROVIDER=openai` or `PROVIDER=groq` transcribes the recorded browser turn and runs the live hotel agent. `PROVIDER=mock` uses scripted transcripts, deterministic tools, and no paid calls.

`TTS_BACKEND=provider` generates WAV audio through the selected provider using `TTS_MODEL` and `TTS_VOICE`. `TTS_BACKEND=system` renders the installed macOS voice into a WAV for controllable browser playback and avoids provider TTS cost. Unsupported hosts and rendering failures use browser speech synthesis. The browser also falls back to its installed voice if provider synthesis or playback fails.

The talk server stores independent agent state per browser session and writes structured telemetry to `../logs/voice-events.jsonl`.

## Architecture Boundary

The two identities are real room participants, but the AI processing path is a workshop bridge:

```text
browser microphone -> local endpointing -> HTTP /voice-agent -> STT and agent -> provider WAV or browser TTS
```

A room-native production worker would subscribe directly to the caller audio track, stream audio through STT or a realtime model, publish an agent audio track, and coordinate distributed cancellation.

## SIP Extension

```text
phone caller -> carrier -> SIP trunk -> SIP edge or SBC -> LiveKit room -> agent worker
```

A real SIP deployment requires a trunk, dispatch rule, internet-reachable signaling and media endpoints, authentication, codec negotiation, and transfer handling. A SIP REFER maps to Aurora's transfer action, while SIP BYE maps to the end-call action.

## Railway

The local commands above stay the in-person demo. Railway is a separate public URL and is not started by this checkout.

`talk_server.py` keeps `localhost:5173` unless the platform sets `PORT` and `TALK_PORT` is unset. In that case it binds `0.0.0.0` and Railway's `PORT`. A public bind refuses to start while LiveKit is still the local `ws://` dev server or the dev key pair, while `PROVIDER` is `mock`, or while `TELEMETRY_INCLUDE_CONTENT=true`. The refusal names the missing settings and does not print secret values.

Put `LIVEKIT_URL` (`wss`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_ROOM`, `PROVIDER`, and the matching API key in Railway variables. Use `TTS_BACKEND=provider` for provider audio, or `TTS_BACKEND=system` for system speech. On macOS, this server renders system speech into a temporary WAV with `say` and sends it to browser audio playback; rendering does not play sound on the server. English, Spanish, and Tamil use Samantha, Mónica, and Vani respectively. Other hosts, unavailable voices, and render failures fall back to browser speech. Do not deploy until those variables are set. Booking tools stay mocks.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Could not establish PC connection | Confirm `./start_local_server.sh` is still running on port 7880 |
| UI loads but Start call fails | Confirm both the LiveKit server and `talk_server.py` are running |
| No microphone activity | Allow browser microphone access, then restart the call |
| Background noise starts turns | Increase Speech sensitivity |
| Aurora interrupts itself | Reload the latest UI and inspect local speech evidence and playback-check diagnostics |
| Turns commit too quickly | Increase Endpoint silence |
| Turns feel slow | Decrease Endpoint silence carefully |
| No real transcription in mock mode | Set a live provider in `pipeline/.env` |
| Voice still sounds like the system voice | Set `TTS_BACKEND=provider`, restart `talk_server.py`, and confirm the UI shows `TTS: <voice>` |

## Speaker interruption check

With the patched browser page, start a call using laptop speakers and leave the
caller silent during the greeting and a longer answer. Repeat at the speaker
volumes used in the demo. Aurora should finish each answer without a second
caller turn. Then say "Wait, speak Tamil" over a longer answer; Aurora should
stop and respond to the caller. Repeat with headphones. If provider TTS is
configured, repeat the speaker check with that backend as well.

In the browser console, `window.__auroraTalk.state()` shows the capture track's
reported `echoCancellation` setting and current playback state.
`window.__auroraTalk.clientEvents()` distinguishes `barge_in.check_started`,
`barge_in.resumed`, `barge_in.speech_confirmed`, and `tts.playback_error`.
Echo checks use the same STT model while output continues; a rejected echo
candidate must produce no audible pause or agent reply. A real interruption
should produce `barge_in.speech_confirmed` (including onset-to-pause milliseconds)
and a caller transcript. AudioWorklet capture keeps 300 ms of PCM pre-roll and starts a complete WAV recording
on the first raw microphone hit. MediaRecorder remains a fallback when AudioWorklet
is unavailable. Capture continues during the check and while a reply is processing. Preview windows normally take 900 ms, or at least
400 ms for a brief utterance followed by silence, plus the STT round trip.
The listener clock also checks this deadline: some encoders stop delivering
timeslice chunks during silence, so chunk callbacks alone can strand a brief
"no" candidate indefinitely. End call discards open caller recordings and invalidates
pending activity, STT, typed-message, and greeting responses.
Measure the resulting latency on the actual device before calling it natural
talk-over. `barge_in.pause_acknowledged | false` means the browser failed to
pause native synthesis; the candidate is discarded without claiming an
interruption. Local macOS system speech uses browser audio to support pause and
resume at the same position. The native browser fallback still needs separate
hardware validation. A `tts.playback_error`
indicates an output failure rather than microphone detection. Browser track
settings and synthetic tests cannot verify physical echo cancellation; record
browser, microphone, output device, volume, and TTS backend with observations.

The listener resets speech candidates across long render gaps and ignores
suspended or stalled audio contexts. Recorded preview audio is preserved across
render gaps. Where the track advertises support, cancellation of all system
playout is requested for native browser TTS. Before transcription, recorded audio
is decoded and effectively silent clips are discarded; any audible 20 ms window
keeps a short reply eligible. If the browser cannot decode its recording format,
the existing transcription path remains available. The server then runs a local
Silero detector before external transcription: any 32 ms frame with speech
probability at least 0.3 keeps the clip eligible, without a minimum word count
or speech duration. A clip with no qualifying frames is ignored before STT,
reasoning, or TTS. Local speech evidence takes precedence over Whisper's
confidence metadata, which can label noise as confidently recognized speech.
When local detection is unavailable, the conservative fallback rejects a clip
only if every Whisper segment reports high silence probability and weak text
confidence. These checks keep the configured reasoning model, transcription
model, and TTS backend.

Whisper can still report zero silence probability for an entirely silent clip;
its confidence field alone does not establish that a caller spoke.
Live native-synthesis trials also produced novel false transcripts during
speaker echo, so transcript matching alone has not established a passing
silent-caller check. With the interfering Codex voice session ended, a local
in-app-browser trial using macOS WAV playback completed its 4-second greeting
and 54-second reply with no recorder activity or extra turns, including
26 seconds after the long reply. This covers the current laptop-speaker setup
at the app's 0.3 playback volume; other physical volumes and headphones remain
unverified. Later physical-microphone trials produced novel false transcripts
from room noise, so that one passing trial does not establish acceptance.
The integrated local detector rejects five saved problem clips offline (peak
speech probabilities 0.047–0.155), while retaining generated faint English and
Tamil one-word speech. A fresh trial with the integrated filter used Chrome
155, the built-in MacBook Pro microphone, requested echo/noise cancellation
and gain control, laptop speakers, and the app's 0.3 speaker playback volume.
The 4-second greeting and 29-second answer both finished naturally, with no
confirmed interruption or extra reply through 94 seconds after the greeting
and 82 seconds after the answer. Captured room-noise candidates were rejected
locally before STT. This establishes a bounded result on that setup; physical
human talk-over, other volumes/devices, headphones, and native fallback remain
unverified.

A separate temporary browser fixture supplied generated PCM as microphone
input, using the actual MediaRecorder, LiveKit connection, configured Groq
Whisper endpoint, reasoning model, and system audio output. "Wait, speak Tamil",
"Standard Queen" (also present in the playing answer), and the brief "No" all
paused output and retained their complete transcripts. Recorded onset-to-pause
times were 2.2, 1.9, and 1.3 seconds respectively. These are synthetic microphone
tests, not proof of genuine caller speech through the physical microphone;
the STT confirmation delay also needs usability assessment on real calls.
Repeating these recorder tests with the integrated neural filter preserved all
three complete caller transcripts and acknowledged playback pauses. Current
onset-to-pause times were 2.5 seconds for "No", 2.6 seconds for "Standard Queen",
and 1.1 seconds for "Wait, speak Tamil". Separate real-Groq checks retained all
ten generated English, Tamil and Spanish clips attenuated to 0.1 and 0.03 of
their rendered amplitude; these were generated test speech, not replays of
saved microphone recordings.

While recording, the browser checks the growing clip against the local detector
every 500 ms using `/speech-activity`. This endpoint does not invoke STT, reasoning,
or TTS. The last qualifying speech frame sets the silence timer, so persistent
room noise cannot hold a completed utterance open. A failed or unavailable local
check falls back to energy endpointing; requests time out after two seconds.
The default silence wait is 1,000 ms, with up to 550 ms extra for longer speech.
Late preview confirmation does not restart that wait. Ordinary capture starts
on the first microphone hit, and an early rejected preview can retry the same
recording twice to retain a short caller's first word. Final transcription still
covers the complete recording because the caller may continue after the preview.
Short callers repeating a room choice or saying "no"/"wait" remain eligible.
When a rendered playback reference is available, correlated echo is removed
before checking residual caller speech. Hardware verification remains necessary
for reverberant rooms and device processing that substantially alters playback.

A human retest exposed recordings lasting 6.84–24.96 seconds despite only
1.15–1.92 seconds of detected speech in representative clips. That was an
endpoint delay caused by noise, beyond the intentional silence wait. In the
subsequent generated microphone check, "No" followed by ten seconds of continuous
noise paused output after 1.14 seconds and closed its recording after 1.47 seconds.
The final request took 2.88 seconds: approximately 39 ms for local detection,
396 ms for STT, 1,532 ms for reasoning, and 905 ms for system speech rendering.
An ordinary "Wait, speak Tamil" retained its complete transcript, ended about
1.01 seconds after the last detected speech frame, and began its response
2.80 seconds after endpointing. These generated checks support the endpoint
repair. The user subsequently accepted the physical-microphone retest and
authorized closing FDE-243. Other volumes, devices, and native synthesis remain
unverified.

For timing diagnostics, inspect the VAD readout's `data-last-barge-timings` and
`data-last-turn-timings` attributes. They separate onset-to-check/pause,
endpoint-after-speech, request time, server stages, and endpoint-to-first-audio.
The server trace also records the submitted client timings when telemetry is
configured; content logging is not needed for these measurements.

Playback is armed before audio starts, with a watchdog for missing end events.
Confirmed speech suspends that watchdog while the caller's turn is processed;
rejected final transcription resumes the same audio position and the remaining
watchdog time. Native synthesis retries an asynchronous cancellation once, with
token checks to prevent a replaced reply from being replayed. The Start gesture
unlocks audio output, and recorder start failures leave the listener available.

Offline regressions: `node --test livekit/test_talk_browser.cjs` and
`livekit/.venv/bin/python -m unittest discover -s livekit -p 'test_*.py'` from
the repository root, after installing the requirements. The acoustic tests use
bundled synthetic WAVs and run locally without sound output or external STT.

## Automatic conversation and message controls

The default audio mode is Automatic for both speakers and headphones. It does
not identify or switch the OS output device. It uses a bounded, calibrated energy
trigger (0.003–0.012 RMS) only to open capture; local neural speech evidence and
STT confirm input before output pauses. Noise can open a speculative recording,
but rejected input produces no pause or agent turn. Device changes reset learned
noise at a safe turn boundary. Speaker/headset presets and the silence/sensitivity
controls remain optional overrides pending the separate user decision about the
caller-facing Turn tuning section; the internal defaults remain available either way.
The default Automatic endpoint is 1,000 ms after detected speech, including longer
answers. Manual speaker/headset presets can add up to 550 ms for longer answers.
Increasing the configured wait preserves longer pauses at the cost of response
delay. Language does not require a separate preset.

Caller speech is captured during processing. A ready response is held while a
candidate is checked: rejected noise releases it; confirmed speech supersedes it.
Preview transcription runs outside the reasoning lock. Request generations fence
late responses before rendering/delivery, and new calls use fresh session IDs.
Prepared replies that never played are removed from model history. Interrupted
replies carry the playback position and an approximate already-spoken prefix, so
the agent can avoid repeating it without assuming the caller heard or agreed to
the unplayed remainder. Completed tool results remain in history:
superseding a reply does not undo an already executed booking or other tool action.

Start call and End call are the only call controls. End stops playback, microphone
tracks, the PCM ring, outstanding requests, and the listener. The message form is
labeled “Message the agent” and explicitly supports English, Spanish, and Tamil.
Its text travels unchanged to the existing hotel agent and language router.

Generated microphone validation on Chrome 155/macOS, default Automatic mode,
Groq Whisper and the existing reasoning model/system WAV output retained complete
“Wait, speak Tamil”, “No”, and “Yes” transcripts. Mid-response Wait paused output
in 1.18 s; a correction at 0.1 voice amplitude during processing confirmed in
0.84 s and prevented the earlier reply from playing; No injected 80 ms after
playback began paused it in 1.00 s; Yes at 0.1 amplitude paused it in 0.86 s.
A working target is confirmation within 1.5 s on this setup, including the STT
round trip; provider latency can exceed that, and no hard real-time guarantee is
made. These are generated microphone checks, not new physical headset/device
acceptance. The earlier accepted physical retest belongs to FDE-243. Native
synthesis that cannot acknowledge pause remains a guarded unsupported interruption
path; system/provider WAV output is the validated controllable path.


### Playback reference verification

Each recording carries the actual playing reply's ID and playback position,
including the retained PCM pre-roll. The server keeps two rendered references
per session, bounded to eight sessions, and clears them on reset. It searches
within 500 ms of the reported position and subtracts a scaled reference only
when correlation is at least 0.72. A local neural check rejects a speech-free
residual before external transcription. A residual containing speech is sent to
STT as a complete WAV; its level correction is capped at four times and disabled
below the PCM quantization floor. Missing references, unavailable decoding, or
uncorrelated audio retain the existing speech and text checks. Browser-native
speech has no rendered reference and uses that fallback path.

A stronger generated browser echo-return check exposed a false interruption
before this reference repair: Whisper altered an echo fragment enough to defeat
the text comparison. The repair now passes offline reference-routing tests and
nine silent checks using freshly rendered system speech: echo-only return at
0.03 and 0.25 amplitude was rejected at onset, mid-response and near the end;
quiet “No” mixed with 0.25 playback remained speech in all three positions.
These WAVs were rendered into memory/files without playback or external STT.
The browser rerun and physical speaker/headphone verification are pending;
no browser or audible testing was performed during the user's meeting.

### Current repair checkpoint

The original checkout passes 88 Python tests and 47 browser-harness tests. These
are regression checks, not acceptance of natural turn-taking. Later generated
browser checks reproduced intermittent playback echo accepted as caller speech,
including altered room prices. The latest saved synthetic echo clip still left
26.6% residual energy and was classified as voiced, so the echo repair remains
open. Quiet short answers must remain eligible even below 2% residual energy;
raising that cutoff can hide echo failures by discarding genuine caller speech.

Physical microphone/speaker acceptance and end-to-end validation of repeated
reply endings remain pending. The recording-review checklist also covers honest
interruption labels, cancelled-turn state, ambiguous-room clarification, answer
provenance, distinct booking references, Tamil transcription and unsent drafts.
Committing this checkpoint does not mark those tasks complete.
