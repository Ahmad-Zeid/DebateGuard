// AudioWorklet processor for capturing 16-bit PCM from microphone
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4096; // 256ms at 16000Hz
    this.buffer = new Int16Array(this.bufferSize);
    this.frameCount = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0]; // mono channel
      
      for (let i = 0; i < channelData.length; i++) {
        const s = Math.max(-1, Math.min(1, channelData[i]));
        this.buffer[this.frameCount++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        
        if (this.frameCount >= this.bufferSize) {
          const copy = new Int16Array(this.buffer);
          this.port.postMessage(copy.buffer, [copy.buffer]);
          this.frameCount = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);