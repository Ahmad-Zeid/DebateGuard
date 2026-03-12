import { countFillerWords, countWords } from "./fillerWords";
import type { AudioChunkAnalytics, DeliveryMetricsSnapshot, MediaPipeFrameSignals } from "./types";

interface FaceSample {
  tsMs: number;
  eyeContactProxy: number;
  yawNormalized: number;
  headRollDeg: number;
  headPitchDeg: number;
}

interface PoseSample {
  tsMs: number;
  shoulderTiltDeg: number;
  slouchProxy: number;
}

type YawZone = "left" | "center" | "right";

const SAMPLE_WINDOW_MS = 30000;
const YAW_TURN_THRESHOLD = 0.18;
const HEAD_TURN_COOLDOWN_MS = 450;
const SPEECH_RMS_THRESHOLD = 0.02;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }

  const avg = mean(values);
  const variance = values.reduce((acc, value) => acc + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export class DeliveryMetricsAggregator {
  private startedAtMs = performance.now();
  private faceSamples: FaceSample[] = [];
  private poseSamples: PoseSample[] = [];

  private analyzedFrames = 0;
  private lastFrameTs = 0;
  private analysisFps = 0;

  private headTurnCount = 0;
  private lastTurnTs = -Infinity;
  private yawZone: YawZone = "center";

  private totalAudioMs = 0;
  private speakingAudioMs = 0;
  private currentPauseMs = 0;
  private pauseSegmentsMs: number[] = [];

  private userWordCount = 0;
  private fillerWordCount = 0;

  reset(nowMs = performance.now()): void {
    this.startedAtMs = nowMs;
    this.faceSamples = [];
    this.poseSamples = [];

    this.analyzedFrames = 0;
    this.lastFrameTs = 0;
    this.analysisFps = 0;

    this.headTurnCount = 0;
    this.lastTurnTs = -Infinity;
    this.yawZone = "center";

    this.totalAudioMs = 0;
    this.speakingAudioMs = 0;
    this.currentPauseMs = 0;
    this.pauseSegmentsMs = [];

    this.userWordCount = 0;
    this.fillerWordCount = 0;
  }

  ingestMediaPipeSignals(signals: MediaPipeFrameSignals): void {
    this.analyzedFrames += 1;

    if (this.lastFrameTs > 0) {
      const delta = Math.max(1, signals.tsMs - this.lastFrameTs);
      const instantFps = 1000 / delta;
      this.analysisFps = this.analysisFps === 0 ? instantFps : this.analysisFps * 0.9 + instantFps * 0.1;
    }
    this.lastFrameTs = signals.tsMs;

    if (signals.faceTracked) {
      if (
        signals.eyeContactProxy !== null &&
        signals.yawNormalized !== null &&
        signals.headRollDeg !== null &&
        signals.headPitchDeg !== null
      ) {
        this.faceSamples.push({
          tsMs: signals.tsMs,
          eyeContactProxy: clamp(signals.eyeContactProxy, 0, 1),
          yawNormalized: signals.yawNormalized,
          headRollDeg: signals.headRollDeg,
          headPitchDeg: signals.headPitchDeg,
        });

        const nextZone = this.resolveYawZone(signals.yawNormalized);
        if (
          this.yawZone !== "center" &&
          nextZone !== "center" &&
          this.yawZone !== nextZone &&
          signals.tsMs - this.lastTurnTs > HEAD_TURN_COOLDOWN_MS
        ) {
          this.headTurnCount += 1;
          this.lastTurnTs = signals.tsMs;
        }
        this.yawZone = nextZone;
      }
    }

    if (signals.poseTracked && signals.shoulderTiltDeg !== null && signals.slouchProxy !== null) {
      this.poseSamples.push({
        tsMs: signals.tsMs,
        shoulderTiltDeg: signals.shoulderTiltDeg,
        slouchProxy: clamp(signals.slouchProxy, 0, 1),
      });
    }

    this.pruneOldSamples(signals.tsMs);
  }

  ingestAudioChunk(sample: AudioChunkAnalytics): void {
    this.totalAudioMs += sample.durationMs;

    if (sample.rms >= SPEECH_RMS_THRESHOLD) {
      this.speakingAudioMs += sample.durationMs;
      if (this.currentPauseMs > 0) {
        this.pauseSegmentsMs.push(this.currentPauseMs);
        this.currentPauseMs = 0;
      }
    } else {
      this.currentPauseMs += sample.durationMs;
    }
  }

  ingestUserTranscript(text: string): void {
    this.userWordCount += countWords(text);
    this.fillerWordCount += countFillerWords(text);
  }

  snapshot(nowMs = performance.now()): DeliveryMetricsSnapshot {
    this.pruneOldSamples(nowMs);

    const eyeContact = mean(this.faceSamples.map((item) => item.eyeContactProxy));

    const rollStd = standardDeviation(this.faceSamples.map((item) => item.headRollDeg));
    const pitchStd = standardDeviation(this.faceSamples.map((item) => item.headPitchDeg));
    const instability = clamp((rollStd + pitchStd) / 40, 0, 1);

    const shoulderTiltProxy = clamp(mean(this.poseSamples.map((item) => Math.abs(item.shoulderTiltDeg))) / 18, 0, 1);
    const slouchProxy = clamp(mean(this.poseSamples.map((item) => item.slouchProxy)), 0, 1);

    const elapsedMin = Math.max((nowMs - this.startedAtMs) / 60000, 1 / 60);
    const speakingMin = Math.max(this.speakingAudioMs / 60000, 1 / 60);

    const headTurnFrequencyPerMin = this.headTurnCount / elapsedMin;
    const speakingPaceWpm = this.userWordCount / speakingMin;

    const avgPauseMs =
      this.pauseSegmentsMs.length === 0
        ? this.currentPauseMs
        : mean([...this.pauseSegmentsMs, this.currentPauseMs].filter((value) => value > 0));

    const fillerDensity = this.userWordCount > 0 ? this.fillerWordCount / this.userWordCount : 0;

    return {
      eyeContactProxy: clamp(eyeContact, 0, 1),
      headTurnFrequencyPerMin,
      headTiltPitchInstability: instability,
      shoulderTiltProxy,
      slouchProxy,
      speakingPaceWpm,
      averagePauseLengthSec: avgPauseMs / 1000,
      fillerWordDensity: clamp(fillerDensity, 0, 1),
      faceTracked: this.faceSamples.length > 0,
      poseTracked: this.poseSamples.length > 0,
      analyzedFrames: this.analyzedFrames,
      analysisFps: this.analysisFps,
    };
  }

  private resolveYawZone(yawNormalized: number): YawZone {
    if (yawNormalized <= -YAW_TURN_THRESHOLD) {
      return "left";
    }
    if (yawNormalized >= YAW_TURN_THRESHOLD) {
      return "right";
    }
    return "center";
  }

  private pruneOldSamples(nowMs: number): void {
    const minTs = nowMs - SAMPLE_WINDOW_MS;
    this.faceSamples = this.faceSamples.filter((item) => item.tsMs >= minTs);
    this.poseSamples = this.poseSamples.filter((item) => item.tsMs >= minTs);
    this.pauseSegmentsMs = this.pauseSegmentsMs.slice(-200);
  }
}
