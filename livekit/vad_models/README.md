# Local speech detector

`silero_vad.onnx` is the MIT-licensed [Silero VAD model](https://github.com/snakers4/silero-vad/blob/60b7ffa243625ebdc1070275a29f18c87843786a/src/silero_vad/data/silero_vad.onnx), pinned to upstream commit `60b7ffa243625ebdc1070275a29f18c87843786a`. Its SHA-256 is `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`; the loader verifies it once when creating the CPU inference session. The upstream license is included beside the weights.

The [upstream ONNX wrapper](https://github.com/snakers4/silero-vad/blob/60b7ffa243625ebdc1070275a29f18c87843786a/src/silero_vad/utils_vad.py) defines the 512-sample frames, 64-sample context and recurrent state used by `speech_detector.py`. State resets for each recording. Inference is local, telemetry is disabled, and no runtime model download occurs.

Any frame with speech probability at least 0.3 keeps the recording eligible; there is no minimum word count or speech duration. This is below upstream's default 0.5 threshold to retain faint callers. FFmpeg decodes browser WebM/MP4/Opus to mono 16 kHz PCM; an already compatible WAV needs no external decoder. If dependencies, weights or decoding are unavailable, the talk server retains its transcription path and reports `vad.evidence.available=false` instead of discarding unverified audio.
