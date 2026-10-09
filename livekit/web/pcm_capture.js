// A continuous microphone ring keeps the syllables before the VAD frame.
// Each snapshot is a complete WAV, including its header, even after pre-roll.
export class PcmCapture {
  constructor(sampleRate, preRollMs = 300) {
    this.sampleRate = sampleRate;
    this.preRollFrames = Math.round(sampleRate * preRollMs / 1000);
    this.ring = [];
    this.frames = 0;
    this.recorders = new Set();
  }

  accept(samples) {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const value = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = Math.round(value * (value < 0 ? 32768 : 32767));
    }
    const chunk = new Blob([pcm.buffer]);
    for (const recorder of this.recorders) recorder.ondataavailable?.({ data: chunk });
    this.ring.push(chunk);
    this.frames += samples.length;
    while (this.ring.length > 1 && this.frames - this.ring[0].size / 2 >= this.preRollFrames) {
      this.frames -= this.ring.shift().size / 2;
    }
  }

  createRecorder() {
    const capture = this;
    return {
      state: "inactive", mimeType: "audio/wav", preRollMs: 0,
      start() {
        this.state = "recording";
        this.preRollMs = capture.frames * 1000 / capture.sampleRate;
        capture.recorders.add(this);
        for (const chunk of capture.ring) this.ondataavailable?.({ data: chunk });
      },
      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        capture.recorders.delete(this);
        this.onstop?.();
      },
      formatRecording(chunks) {
        const bytes = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
        const buffer = new ArrayBuffer(44);
        const header = new DataView(buffer);
        const tag = (offset, value) => [...value].forEach((char, i) => header.setUint8(offset + i, char.charCodeAt(0)));
        tag(0, "RIFF"); header.setUint32(4, bytes + 36, true); tag(8, "WAVE");
        tag(12, "fmt "); header.setUint32(16, 16, true); header.setUint16(20, 1, true);
        header.setUint16(22, 1, true); header.setUint32(24, capture.sampleRate, true);
        header.setUint32(28, capture.sampleRate * 2, true); header.setUint16(32, 2, true);
        header.setUint16(34, 16, true); tag(36, "data"); header.setUint32(40, bytes, true);
        return new Blob([buffer, ...chunks], { type: "audio/wav" });
      },
    };
  }

  close() {
    this.recorders.clear();
    this.ring = [];
    this.frames = 0;
  }
}
