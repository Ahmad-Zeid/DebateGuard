class Pcm16CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const processorOptions = options?.processorOptions ?? {};
    this.targetSampleRate = processorOptions.targetSampleRate ?? 16000;
    this.chunkMs = processorOptions.chunkMs ?? 40;

    this.inputSampleRate = sampleRate;
    this.chunkSamples = Math.max(1, Math.round((this.targetSampleRate * this.chunkMs) / 1000));

    this._resampleOffset = 0;
    this._monoBuffer = [];
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) {
      return true;
    }

    const channelCount = input.length;
    const frameCount = input[0].length;
    const mixed = new Float32Array(frameCount);

    for (let frame = 0; frame < frameCount; frame += 1) {
      let sum = 0;
      for (let channel = 0; channel < channelCount; channel += 1) {
        sum += input[channel][frame] ?? 0;
      }
      mixed[frame] = sum / channelCount;
    }

    this._appendResampled(mixed);
    this._emitChunks();

    return true;
  }

  _appendResampled(mixed) {
    if (this.inputSampleRate === this.targetSampleRate) {
      for (let index = 0; index < mixed.length; index += 1) {
        this._monoBuffer.push(mixed[index]);
      }
      return;
    }

    const ratio = this.inputSampleRate / this.targetSampleRate;
    let sourcePosition = this._resampleOffset;

    while (sourcePosition < mixed.length) {
      const leftIndex = Math.floor(sourcePosition);
      const rightIndex = Math.min(leftIndex + 1, mixed.length - 1);
      const blend = sourcePosition - leftIndex;

      const interpolated = mixed[leftIndex] + (mixed[rightIndex] - mixed[leftIndex]) * blend;
      this._monoBuffer.push(interpolated);

      sourcePosition += ratio;
    }

    this._resampleOffset = sourcePosition - mixed.length;
  }

  _emitChunks() {
    while (this._monoBuffer.length >= this.chunkSamples) {
      const chunk = this._monoBuffer.splice(0, this.chunkSamples);
      const pcm16 = new Int16Array(this.chunkSamples);

      for (let index = 0; index < this.chunkSamples; index += 1) {
        const clamped = Math.max(-1, Math.min(1, chunk[index]));
        pcm16[index] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      }

      this.port.postMessage(
        {
          type: "pcm16",
          sampleRate: this.targetSampleRate,
          durationMs: this.chunkMs,
          chunk: pcm16,
        },
        [pcm16.buffer]
      );
    }
  }
}

registerProcessor("pcm16-capture-processor", Pcm16CaptureProcessor);
