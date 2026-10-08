# Synthetic speech fixtures

These mono 16 kHz, 16-bit WAV files contain generated system speech only: Samantha saying "No." and Vani saying "நன்றி" (Tamil thanks). They contain no microphone recordings.

The files were rendered with macOS `say -o` (no playback), decoded with FFmpeg, and attenuated to 0.1 of the rendered amplitude. Tests also scale them to 0.3 of that amplitude, corresponding to 0.03 of the original render. They exercise brief, faint speech against the real bundled detector weights without browser access, sound output, or external transcription.
