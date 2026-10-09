class AuroraPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(Math.round(sampleRate / 20));
    this.used = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (const value of channel) {
        this.block[this.used++] = value;
        if (this.used === this.block.length) {
          this.port.postMessage(this.block, [this.block.buffer]);
          this.block = new Float32Array(Math.round(sampleRate / 20));
          this.used = 0;
        }
      }
    }
    // Output stays silent: microphone samples go only to the capture port.
    return true;
  }
}
registerProcessor("aurora-pcm", AuroraPcm);
