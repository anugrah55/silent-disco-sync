// AudioWorklet: downmix the captured tab audio to mono and hand it to the main
// thread in fixed-size chunks. Plain JS in /public so it loads under a strict
// CSP (script-src 'self') without a bundler step.
class LiveCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options.processorOptions.chunkSamples;
    this.buf = new Float32Array(this.size);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let v = 0;
      for (let c = 0; c < input.length; c++) v += input[c][i];
      this.buf[this.fill++] = v / input.length;
      if (this.fill === this.size) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('live-capture', LiveCaptureProcessor);
