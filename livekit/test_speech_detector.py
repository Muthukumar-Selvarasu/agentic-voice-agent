"""Offline acoustic regressions using bundled weights and synthetic speech."""
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
import shutil
import subprocess
import unittest
import wave

import numpy as np

from speech_detector import classify_audio


def pcm_wave(samples):
    buffer = BytesIO()
    with wave.open(buffer, "wb") as recording:
        recording.setnchannels(1)
        recording.setsampwidth(2)
        recording.setframerate(16000)
        recording.writeframes(samples.astype("<i2").tobytes())
    return buffer.getvalue()


class SpeechDetectorTests(unittest.TestCase):
    def test_faint_one_word_english_and_tamil_are_retained(self):
        for filename in ("synthetic_no_16k.wav", "synthetic_tamil_16k.wav"):
            with wave.open(str(Path(__file__).parent / "test_audio" / filename)) as recording:
                samples = np.frombuffer(recording.readframes(recording.getnframes()), dtype="<i2")
            for gain in (1.0, 0.3):
                with self.subTest(filename=filename, gain=gain):
                    evidence = classify_audio(pcm_wave(samples * gain))
                    self.assertGreaterEqual(evidence["maxSpeechProbability"], evidence["speechThreshold"])
                    self.assertGreater(evidence["voicedMs"], 0)

    def test_broadband_noise_and_impact_do_not_count_as_speech(self):
        samples = np.random.default_rng(243).normal(0, 0.015, 32000)
        samples[8000:8160] += np.hanning(160) * 0.15
        evidence = classify_audio(pcm_wave(samples.clip(-1, 1) * 32767))
        self.assertLess(evidence["maxSpeechProbability"], evidence["speechThreshold"])
        self.assertEqual(evidence["voicedMs"], 0)

    @unittest.skipUnless(shutil.which("ffmpeg"), "Install FFmpeg to verify browser audio decoding")
    def test_faint_no_survives_browser_opus_encoding_and_decoding(self):
        with wave.open(str(Path(__file__).parent / "test_audio" / "synthetic_no_16k.wav")) as recording:
            samples = np.frombuffer(recording.readframes(recording.getnframes()), dtype="<i2")
        encoded = subprocess.run(
            [shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error",
             "-i", "pipe:0", "-c:a", "libopus", "-f", "webm", "pipe:1"],
            input=pcm_wave(samples * 0.3), capture_output=True, check=True, timeout=8,
        ).stdout
        evidence = classify_audio(encoded)
        self.assertGreaterEqual(evidence["maxSpeechProbability"], evidence["speechThreshold"])

    def test_shared_model_never_reuses_recording_state(self):
        speech = (Path(__file__).parent / "test_audio" / "synthetic_no_16k.wav").read_bytes()
        silence = pcm_wave(np.zeros(16000))
        expected_speech = classify_audio(speech)
        expected_silence = classify_audio(silence)
        # Concurrent calls also share the session while keeping clip state private.
        with ThreadPoolExecutor(max_workers=2) as pool:
            actual = list(pool.map(classify_audio, (speech, silence, silence, speech)))
        self.assertEqual(actual, [expected_speech, expected_silence, expected_silence, expected_speech])

    def test_noise_tail_does_not_extend_the_last_speech_position(self):
        with wave.open(str(Path(__file__).parent / "test_audio" / "synthetic_no_16k.wav")) as recording:
            speech = np.frombuffer(recording.readframes(recording.getnframes()), dtype="<i2")
        noise = np.random.default_rng(243).normal(0, 100, 32000)
        evidence = classify_audio(pcm_wave(np.concatenate((speech, noise))))
        # Allow the detector's recurrent speech tail, but not the whole noise tail.
        self.assertLess(evidence["lastSpeechMs"], len(speech) / 16 + 300)
        self.assertGreater(evidence["durationMs"] - evidence["lastSpeechMs"], 1700)
        # Later quiet speech must advance the endpoint, preserving continuation.
        continuation = classify_audio(pcm_wave(np.concatenate((speech, noise, speech * .3))))
        self.assertGreater(continuation["lastSpeechMs"], evidence["durationMs"])


if __name__ == "__main__":
    unittest.main()
