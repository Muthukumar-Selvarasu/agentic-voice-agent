"""Local speech evidence for browser recordings; no audio leaves this module."""
from __future__ import annotations

import hashlib
import shutil
import subprocess
import threading
import wave
from io import BytesIO
from pathlib import Path

MODEL_PATH = Path(__file__).parent / "vad_models" / "silero_vad.onnx"
MODEL_SHA256 = "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"
SPEECH_PROBABILITY = 0.3  # Below upstream's 0.5 default to keep faint callers.
_session = None
_session_lock = threading.Lock()


def _load_session():
    global _session
    with _session_lock:
        if _session is None:
            import onnxruntime as ort
            ort.disable_telemetry_events()
            if hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest() != MODEL_SHA256:
                raise ValueError("Unexpected speech detector weights")
            options = ort.SessionOptions()
            options.inter_op_num_threads = options.intra_op_num_threads = 1
            _session = ort.InferenceSession(str(MODEL_PATH), options,
                                           providers=["CPUExecutionProvider"])
        return _session


def _decode_pcm(audio: bytes) -> bytes | None:
    try:
        with wave.open(BytesIO(audio)) as recording:
            if (recording.getnchannels(), recording.getsampwidth(), recording.getframerate()) == (1, 2, 16000):
                return recording.readframes(recording.getnframes())
    except (wave.Error, EOFError):
        pass
    decoder = shutil.which("ffmpeg")
    if not decoder:
        return None
    return subprocess.run(
        [decoder, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
         "-f", "s16le", "-ac", "1", "-ar", "16000", "pipe:1"],
        input=audio, capture_output=True, check=True, timeout=8,
    ).stdout


def classify_audio(audio: bytes) -> dict | None:
    """Return per-clip speech evidence, or None when decoding is unavailable.

    Recurrent state and context belong to this recording, never the shared
    inference session. The original encoded recording remains intact for STT.
    """
    import numpy as np
    pcm = _decode_pcm(audio)
    if not pcm or len(pcm) < 2:
        return None
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
    session = _load_session()
    state = np.zeros((2, 1, 128), dtype=np.float32)
    context = np.zeros((1, 64), dtype=np.float32)
    peak = 0.0
    voiced_samples = 0
    last_speech_sample = None
    for offset in range(0, len(samples), 512):
        frame = samples[offset:offset + 512]
        length = len(frame)
        frame = np.pad(frame, (0, 512 - length)).reshape(1, 512)
        current = np.concatenate((context, frame), axis=1)
        prediction, state = session.run(None, {"input": current, "state": state,
                                              "sr": np.array(16000, dtype=np.int64)})
        probability = float(prediction.item())
        peak = max(peak, probability)
        if probability >= SPEECH_PROBABILITY:
            voiced_samples += length
            last_speech_sample = offset + length
        context = current[:, -64:]
    return {"detector": "silero", "durationMs": len(samples) / 16,
            "voicedMs": voiced_samples / 16, "voicedFraction": voiced_samples / len(samples),
            "maxSpeechProbability": peak, "speechThreshold": SPEECH_PROBABILITY,
            "lastSpeechMs": None if last_speech_sample is None else last_speech_sample / 16}
