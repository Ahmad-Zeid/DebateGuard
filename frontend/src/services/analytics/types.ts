export interface MediaPipeFrameSignals {
  tsMs: number;
  eyeContactProxy: number | null;
  yawNormalized: number | null;
  headRollDeg: number | null;
  headPitchDeg: number | null;
  shoulderTiltDeg: number | null;
  slouchProxy: number | null;
  faceTracked: boolean;
  poseTracked: boolean;
}

export interface DeliveryMetricsSnapshot {
  eyeContactProxy: number;
  headTurnFrequencyPerMin: number;
  headTiltPitchInstability: number;
  shoulderTiltProxy: number;
  slouchProxy: number;
  speakingPaceWpm: number;
  averagePauseLengthSec: number;
  fillerWordDensity: number;
  faceTracked: boolean;
  poseTracked: boolean;
  analyzedFrames: number;
  analysisFps: number;
}

export interface DeliveryTransportMetrics {
  eye_contact_proxy: number;
  head_turn_frequency_per_min: number;
  head_tilt_pitch_instability: number;
  shoulder_tilt_proxy: number;
  slouch_proxy: number;
  speaking_pace_wpm: number;
  average_pause_length_sec: number;
  filler_word_density: number;
  face_tracked: boolean;
  pose_tracked: boolean;
  analyzed_frames: number;
  analysis_fps: number;
}

export interface AudioChunkAnalytics {
  rms: number;
  durationMs: number;
  tsMs: number;
}

export interface LocalMediaPipeAnalyzer {
  start(videoEl: HTMLVideoElement): Promise<void>;
  stop(): void;
  isRunning(): boolean;
}

export type DebugLogger = (level: "info" | "warn" | "error", message: string, payload?: unknown) => void;
