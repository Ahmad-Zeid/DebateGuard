class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4096;
    this.buffer = new Int16Array(this.bufferSize);
    this.frameCount = 0;
  
    this.noiseThreshold = 0.01; 
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0];
      
      // Calculate RMS for this specific input block
      let sumSquares = 0.0;
      for (let i = 0; i < channelData.length; i++) {
        sumSquares += channelData[i] * channelData[i];
      }
      const rms = Math.sqrt(sumSquares / channelData.length);
      const isNoise = rms < this.noiseThreshold;
      
      for (let i = 0; i < channelData.length; i++) {
        const val = isNoise ? 0 : channelData[i];
        const s = Math.max(-1, Math.min(1, val));
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