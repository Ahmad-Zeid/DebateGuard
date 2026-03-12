export type SpeakerRole = "user" | "model";

export type ClientEventType =
  | "session.start"
  | "audio.chunk"
  | "video.snapshot"
  | "metrics.delivery"
  | "round.stop"
  | "ping";

export type ServerEventType =
  | "session.ready"
  | "transcript.partial"
  | "transcript.final"
  | "model.audio.chunk"
  | "model.text.delta"
  | "factcheck.alert"
  | "round.report"
  | "error";

export interface SessionStartEvent {
  type: "session.start";
  session_id: string;
  round_id: string;
  topic: string;
  stance: string;
  difficulty: string;
  user_label?: string;
  demo_mode: boolean;
  metadata: {
    round_length_sec: number;
  };
}

export interface AudioChunkEvent {
  type: "audio.chunk";
  chunk_b64: string;
  mime_type: "audio/pcm;rate=16000";
  sample_rate_hz: 16000;
  seq: number;
}

export interface VideoSnapshotEvent {
  type: "video.snapshot";
  image_b64: string;
  mime_type: "image/jpeg";
  width: number;
  height: number;
}

export interface MetricsDeliveryEvent {
  type: "metrics.delivery";
  metrics: Record<string, unknown>;
}

export interface RoundStopEvent {
  type: "round.stop";
  reason: string;
}

export interface PingEvent {
  type: "ping";
  nonce: string;
}

export type ClientEvent =
  | SessionStartEvent
  | AudioChunkEvent
  | VideoSnapshotEvent
  | MetricsDeliveryEvent
  | RoundStopEvent
  | PingEvent;

export interface SessionReadyEvent {
  type: "session.ready";
  event_id: string;
  ts: string;
  session_id: string;
  round_id: string;
  live_model: string;
  factcheck_model: string;
  heartbeat?: boolean;
  nonce?: string;
}

export interface TranscriptPartialEvent {
  type: "transcript.partial";
  event_id: string;
  ts: string;
  role: SpeakerRole;
  text: string;
}

export interface TranscriptFinalEvent {
  type: "transcript.final";
  event_id: string;
  ts: string;
  role: SpeakerRole;
  text: string;
}

export interface ModelAudioChunkEvent {
  type: "model.audio.chunk";
  event_id: string;
  ts: string;
  chunk_b64: string;
  mime_type: string;
}

export interface ModelTextDeltaEvent {
  type: "model.text.delta";
  event_id: string;
  ts: string;
  text: string;
}

export interface FactcheckAlertEvent {
  type: "factcheck.alert";
  event_id: string;
  ts: string;
  claim: string;
  verdict: "supported" | "disputed" | "unsupported" | "not-checkable";
  corrected_fact?: string;
  short_explanation: string;
  citations: string[];
  confidence: number;
  interrupt_now: boolean;
}

export interface ReportCorrection {
  claim: string;
  claim_class: "numeric" | "percentage" | "date" | "ranking" | "named_event" | "study_report";
  verdict: "supported" | "disputed" | "unsupported" | "not-checkable";
  corrected_fact?: string | null;
  short_explanation: string;
  citations: string[];
  confidence: number;
  interrupt_now: boolean;
  interrupted_live?: boolean;
}

export interface ReportRubric {
  argument_strength: number;
  evidence_quality: number;
  responsiveness: number;
  delivery: number;
  factual_accuracy: number;
  top_strengths: string[];
  top_issues: string[];
  cited_corrections: ReportCorrection[];
  next_drills: string[];
  one_sentence_coach_summary: string;
}

export interface RoundReportEvent {
  type: "round.report";
  event_id: string;
  ts: string;
  session_id: string;
  round_id: string;
  rubric: ReportRubric;
  cited_corrections: ReportCorrection[];
}

export interface ErrorEvent {
  type: "error";
  event_id?: string;
  ts?: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ServerEvent =
  | SessionReadyEvent
  | TranscriptPartialEvent
  | TranscriptFinalEvent
  | ModelAudioChunkEvent
  | ModelTextDeltaEvent
  | FactcheckAlertEvent
  | RoundReportEvent
  | ErrorEvent;
