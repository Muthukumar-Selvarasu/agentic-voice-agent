"""Remove a strongly correlated playback reference before local speech checks."""
from functools import lru_cache
from io import BytesIO
import wave

import numpy as np
from speech_detector import _decode_pcm


@lru_cache(maxsize=4)
def _reference_samples(audio: bytes):
    pcm = _decode_pcm(audio)
    return None if not pcm else np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768


def _truncated_residual(mic: np.ndarray, spoken: np.ndarray, offset_ms: float,
                        playback_end_ms: float):
    """Subtract only the portion the caller recording could have heard.

    A typed message or confirmed interruption can stop playback halfway
    through a microphone recording. Matching the whole clip against the full
    reply then fails because the reply tail was never played; matching just
    the overlap lets us preserve any caller speech after the stop.
    """
    start = int(round(offset_ms * 16))
    end = int(round(playback_end_ms * 16))
    mic_start = max(0, -start)
    ref_start = max(0, start + mic_start)
    overlap = min(len(mic) - mic_start, end - ref_start, len(spoken) - ref_start)
    if overlap < 3200:
        return None
    # Keep a shorter fixed comparison window so plausible alignment movement
    # still has enough played samples after either edge.
    overlap = min(overlap, 16000)
    mic_part = mic[mic_start:mic_start + overlap]
    mic_centered = mic_part - mic_part.mean()
    mic_energy = float(np.dot(mic_centered, mic_centered))
    if mic_energy < 1e-10:
        return None

    search = 8000
    low = max(-search, start - search)
    high = min(end, len(spoken), start + search)
    if high - low < overlap:
        return None
    low = (low // 16) * 16
    candidate = np.zeros(high - low + overlap + 16, dtype=np.float32)
    first, last = max(0, low), min(end, len(spoken), low + len(candidate))
    if last <= first:
        return None
    candidate[first - low:last - low] = spoken[first:last]
    mic_small = mic_centered[:overlap // 16 * 16].reshape(-1, 16).mean(axis=1)
    ref_small = candidate[:len(candidate) // 16 * 16].reshape(-1, 16).mean(axis=1)
    centered = mic_small - mic_small.mean()
    score_energy = float(np.dot(centered, centered))
    if score_energy < 1e-10:
        return None
    dots = np.correlate(ref_small, centered, mode='valid')
    sums = np.concatenate(([0.0], np.cumsum(ref_small, dtype=np.float64)))
    squares = np.concatenate(([0.0], np.cumsum(ref_small ** 2, dtype=np.float64)))
    width = len(mic_small)
    energies = squares[width:] - squares[:-width] - (sums[width:] - sums[:-width]) ** 2 / width
    scores = dots ** 2 / np.maximum(energies * score_energy, 1e-20)
    coarse = int(np.argmax(scores)) * 16
    best = None
    for position in range(max(0, coarse - 24), min(len(candidate) - overlap, coarse + 24) + 1):
        frame = candidate[position:position + overlap]
        frame = frame - frame.mean()
        energy = float(np.dot(frame, frame))
        if energy < 1e-10:
            continue
        dot = float(np.dot(frame, mic_centered))
        score = dot ** 2 / max(energy * mic_energy, 1e-20)
        if best is None or score > best[0]:
            best = (score, position, dot / energy, frame)
    if best is None or best[0] < .50:
        return None

    score, position, gain, frame = best
    residual = mic.copy()
    local = mic_part - mic_part.mean() - frame * gain
    residual[mic_start:mic_start + overlap] = local
    total = float(np.dot(mic - mic.mean(), mic - mic.mean()))
    fraction = float(np.dot(residual - residual.mean(), residual - residual.mean())) / max(total, 1e-20)
    rms = float(np.sqrt(np.mean(residual ** 2)))
    amplification = min(4.0, .02 / rms) if rms >= .0001 else 1.0
    amplification = max(1.0, amplification)
    residual *= amplification
    output = BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
        wav.writeframes((np.clip(residual, -1, 1) * 32767).astype('<i2').tobytes())
    evidence = {'correlation': round(score ** .5, 4),
                'offsetMs': round((low + position - mic_start) / 16, 1),
                'residualEnergyFraction': round(fraction, 6),
                'residualGain': round(amplification, 3),
                'matchedMs': round(overlap / 16, 1),
                'truncatedPlayback': True}
    return output.getvalue(), evidence


def residual_audio(audio: bytes, reference: bytes, offset_ms: float | None = None,
                   playback_end_ms: float | None = None) -> tuple[bytes, dict] | None:
    pcm = _decode_pcm(audio)
    spoken = _reference_samples(reference)
    if not pcm or spoken is None:
        return None
    mic = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768
    if len(mic) < 1600 or float(np.dot(mic, mic)) < 1e-8:
        return None
    if offset_ms is not None and playback_end_ms is not None:
        truncated = _truncated_residual(mic, spoken, offset_ms, playback_end_ms)
        if truncated is not None:
            return truncated
    # Search near the browser's playback position, including acoustic delay and
    # worklet buffering. A missing position can still match the bounded reference.
    if offset_ms is None:
        low, high = -4800, len(spoken)
    else:
        center = int(offset_ms * 16)
        low, high = center - 8000, center + 8000
    low, high = max(-8000, low), min(len(spoken) + 8000, high)
    if high < low:
        return None
    low = (low // 16) * 16
    length = high - low + len(mic) + 32
    candidate = np.zeros(length, dtype=np.float32)
    first, last = max(0, low), min(len(spoken), low + length)
    if last <= first:
        return None
    candidate[first - low:last - low] = spoken[first:last]
    # A 1 kHz coarse search, then refine the alignment at 16 kHz. This avoids
    # a large full-rate search on long responses and never learns a new gate.
    mic_small = mic[:len(mic) // 16 * 16].reshape(-1, 16).mean(axis=1)
    ref_small = candidate[:len(candidate) // 16 * 16].reshape(-1, 16).mean(axis=1)
    centered = mic_small - mic_small.mean()
    mic_energy = float(np.dot(centered, centered))
    if mic_energy < 1e-10:
        return None
    dots = np.correlate(ref_small, centered, mode='valid')
    sums = np.concatenate(([0.0], np.cumsum(ref_small, dtype=np.float64)))
    squares = np.concatenate(([0.0], np.cumsum(ref_small ** 2, dtype=np.float64)))
    width = len(mic_small)
    energies = squares[width:] - squares[:-width] - (sums[width:] - sums[:-width]) ** 2 / width
    scores = dots ** 2 / np.maximum(energies * mic_energy, 1e-20)
    coarse = int(np.argmax(scores)) * 16
    mic_centered = mic - mic.mean()
    total = float(np.dot(mic_centered, mic_centered))
    best = None
    for position in range(max(0, coarse - 24), min(len(candidate) - len(mic), coarse + 24) + 1):
        frame = candidate[position:position + len(mic)]
        frame = frame - frame.mean()
        energy = float(np.dot(frame, frame))
        if energy < 1e-10:
            continue
        dot = float(np.dot(frame, mic_centered))
        score = dot ** 2 / max(energy * total, 1e-20)
        if best is None or score > best[0]:
            best = (score, position, dot / energy, frame)
    if best is None or best[0] < .50:
        return None
    score, position, gain, frame = best
    residual = mic_centered - frame * gain
    evidence = {'correlation': round(score ** .5, 4), 'offsetMs': round((low + position) / 16, 1),
                'residualEnergyFraction': round(float(np.dot(residual, residual)) / max(total, 1e-20), 6)}
    # Subtraction can expose a quiet caller beneath louder playback. Apply a
    # bounded level correction only above the PCM quantization floor; never
    # turn a nearly empty residual into normalized speech.
    rms = float(np.sqrt(np.mean(residual ** 2)))
    amplification = min(4.0, .02 / rms) if rms >= .0001 else 1.0
    amplification = max(1.0, amplification)
    evidence['residualGain'] = round(amplification, 3)
    residual *= amplification
    output = BytesIO()
    with wave.open(output, 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
        wav.writeframes((np.clip(residual, -1, 1) * 32767).astype('<i2').tobytes())
    return output.getvalue(), evidence
