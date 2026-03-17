// AudioWorklet processor for capturing 16-bit PCM from microphone
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0]; // mono channel
      const pcm16 = new Int16Array(channelData.length);
      for (let i = 0; i < channelData.length; i++) {
        const s = Math.max(-1, Math.min(1, channelData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
