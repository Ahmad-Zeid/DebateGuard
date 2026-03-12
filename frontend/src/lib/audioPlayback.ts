function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = Math.floor(bytes.byteLength / 2);
  const output = new Float32Array(length);

  for (let index = 0; index < length; index += 1) {
    const sample = view.getInt16(index * 2, true);
    output[index] = sample < 0 ? sample / 32768 : sample / 32767;
  }

  return output;
}

export class PcmAudioPlayer {
  private context: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private nextPlaybackTime = 0;

  async ensureReady(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: "interactive" });
      this.gainNode = this.context.createGain();
      this.gainNode.gain.value = 1;
      this.gainNode.connect(this.context.destination);
    }

    if (this.context.state !== "running") {
      await this.context.resume();
    }
  }

  async enqueuePcm16(bytes: Uint8Array, sourceSampleRate = 24000): Promise<void> {
    await this.ensureReady();

    if (!this.context || !this.gainNode || bytes.byteLength < 2) {
      return;
    }

    const samples = pcm16ToFloat32(bytes);
    const audioBuffer = this.context.createBuffer(1, samples.length, sourceSampleRate);
    audioBuffer.copyToChannel(samples, 0);

    const source = this.context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode);

    const startTime = Math.max(this.context.currentTime, this.nextPlaybackTime);
    source.start(startTime);

    this.nextPlaybackTime = startTime + audioBuffer.duration;
  }

  resetQueue(): void {
    if (!this.context) {
      return;
    }

    this.nextPlaybackTime = this.context.currentTime;
  }

  async close(): Promise<void> {
    if (!this.context) {
      return;
    }

    await this.context.close();
    this.context = null;
    this.gainNode = null;
    this.nextPlaybackTime = 0;
  }
}
