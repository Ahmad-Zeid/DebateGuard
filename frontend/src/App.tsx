import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactElement } from "react";

import { PcmAudioPlayer } from "./lib/audioPlayback";
import { base64ToBytes, blobToBase64, bytesToBase64 } from "./lib/base64";
import { DeliveryMetricsAggregator } from "./services/analytics/deliveryAggregator";
import { createMediaPipeAnalyzer } from "./services/analytics/mediapipeService";
import type {
  DebugLogger,
  DeliveryMetricsSnapshot,
  DeliveryTransportMetrics,
  LocalMediaPipeAnalyzer,
} from "./services/analytics/types";
import type {
  AudioChunkEvent,
  ClientEvent,
  FactcheckAlertEvent,
  MetricsDeliveryEvent,
  RoundReportEvent,
  ServerEvent,
  SessionStartEvent,
  SpeakerRole,
  VideoSnapshotEvent,
} from "./types/events";

type PermissionStatus = "unknown" | "granted" | "denied";
type ConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "error" | "closed";
type AudioCaptureStatus = "idle" | "capturing" | "stopped";
type MediaPipeStatus = "idle" | "loading" | "running" | "error";
type Difficulty = "easy" | "medium" | "hard";
type Stance = "pro" | "con";

interface SetupFormState {
  topic: string;
  stance: Stance;
  roundLengthSec: number;
  difficulty: Difficulty;
  userLabel: string;
  demoMode: boolean;
}

interface TranscriptLine {
  id: string;
  role: SpeakerRole;
  text: string;
  ts: string;
}

interface DebugEntry {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  ts: string;
  payload?: unknown;
}

interface MetricWindowStats {
  chunks: number;
  speakingChunks: number;
  rmsSum: number;
  latestRms: number;
  bytesSent: number;
  snapshotsSent: number;
}

interface DashboardMetrics {
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
  analysisFps: number;
  analyzedFrames: number;

  averageRms: number;
  latestRms: number;
  pauseRatio: number;
  chunksSent: number;
  snapshotsSent: number;
  audioKbpsEstimate: number;
  reconnectCount: number;
  roundSecondsElapsed: number;
  websocketRoundTripMs: number | null;
}

interface HistoryRound {
  roundId: string;
  sessionId?: string;
  topic?: string;
  generatedAt?: string;
  summary?: string;
  rubric: {
    argument_strength?: number;
    evidence_quality?: number;
    responsiveness?: number;
    delivery?: number;
    factual_accuracy?: number;
    one_sentence_coach_summary?: string;
  };
}
const DEFAULT_SETUP: SetupFormState = {
  topic: "Should governments regulate AI models more strictly?",
  stance: "pro",
  roundLengthSec: 120,
  difficulty: "medium",
  userLabel: "Judge Demo User",
  demoMode: true,
};

const DEFAULT_DASHBOARD_METRICS: DashboardMetrics = {
  eyeContactProxy: 0,
  headTurnFrequencyPerMin: 0,
  headTiltPitchInstability: 0,
  shoulderTiltProxy: 0,
  slouchProxy: 0,
  speakingPaceWpm: 0,
  averagePauseLengthSec: 0,
  fillerWordDensity: 0,
  faceTracked: false,
  poseTracked: false,
  analysisFps: 0,
  analyzedFrames: 0,

  averageRms: 0,
  latestRms: 0,
  pauseRatio: 0,
  chunksSent: 0,
  snapshotsSent: 0,
  audioKbpsEstimate: 0,
  reconnectCount: 0,
  roundSecondsElapsed: 0,
  websocketRoundTripMs: null,
};

function makeId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}

function formatClock(value?: string): string {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString();
}

function toWebSocketUrl(apiBase: string): string {
  try {
    const normalized = new URL(apiBase, window.location.origin);
    normalized.protocol = normalized.protocol === "https:" ? "wss:" : "ws:";
    normalized.pathname = "/ws/live";
    normalized.search = "";
    normalized.hash = "";
    return normalized.toString();
  } catch {
    const fallback = apiBase.startsWith("http") ? apiBase : window.location.origin;
    const url = new URL(fallback);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws/live";
    return url.toString();
  }
}

function classForConnection(status: ConnectionStatus): string {
  switch (status) {
    case "connected":
      return "bg-emerald-500";
    case "connecting":
    case "reconnecting":
      return "bg-amber-400";
    case "error":
      return "bg-rose-500";
    default:
      return "bg-slate-500";
  }
}

function computeRms(chunk: Int16Array): number {
  if (chunk.length === 0) {
    return 0;
  }

  let sumSquares = 0;
  for (let index = 0; index < chunk.length; index += 1) {
    const normalized = chunk[index] / 32768;
    sumSquares += normalized * normalized;
  }

  return Math.sqrt(sumSquares / chunk.length);
}

function normalizeChunkPayload(payload: unknown): Int16Array | null {
  if (payload instanceof Int16Array) {
    return payload;
  }

  if (payload instanceof ArrayBuffer) {
    return new Int16Array(payload);
  }

  if (ArrayBuffer.isView(payload)) {
    return new Int16Array(payload.buffer, payload.byteOffset, Math.floor(payload.byteLength / 2));
  }

  return null;
}

interface AudioWorkletMessage {
  type?: string;
  chunk?: unknown;
}

interface SetupPanelProps {
  value: SetupFormState;
  onChange: (next: SetupFormState) => void;
  onEnableDevices: () => Promise<void>;
  onStartRound: () => Promise<void>;
  onStopRound: () => void;
  onReconnect: () => void;
  micPermission: PermissionStatus;
  webcamPermission: PermissionStatus;
  connectionStatus: ConnectionStatus;
  isRoundActive: boolean;
}

function SetupPanel(props: SetupPanelProps): ReactElement {
  const {
    value,
    onChange,
    onEnableDevices,
    onStartRound,
    onStopRound,
    onReconnect,
    micPermission,
    webcamPermission,
    connectionStatus,
    isRoundActive,
  } = props;

  const updateField = <K extends keyof SetupFormState>(field: K, fieldValue: SetupFormState[K]) => {
    onChange({ ...value, [field]: fieldValue });
  };

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900/90 p-5 shadow-xl shadow-black/30">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Round Setup</h2>
        <span className={`h-3 w-3 rounded-full ${classForConnection(connectionStatus)}`} aria-hidden />
      </div>

      <div className="space-y-4 text-sm">
        <label className="block">
          <span className="mb-1 block text-slate-300">Topic</span>
          <textarea
            value={value.topic}
            onChange={(event) => updateField("topic", event.target.value)}
            rows={3}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-teal-400 focus:outline-none"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-slate-300">Stance</span>
            <select
              value={value.stance}
              onChange={(event) => updateField("stance", event.target.value as Stance)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-teal-400 focus:outline-none"
            >
              <option value="pro">Pro</option>
              <option value="con">Con</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-slate-300">Difficulty</span>
            <select
              value={value.difficulty}
              onChange={(event) => updateField("difficulty", event.target.value as Difficulty)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-teal-400 focus:outline-none"
            >
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-slate-300">Round Length (sec)</span>
            <input
              type="number"
              min={30}
              max={600}
              step={10}
              value={value.roundLengthSec}
              onChange={(event) => updateField("roundLengthSec", Number(event.target.value))}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-teal-400 focus:outline-none"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-slate-300">User Label</span>
            <input
              value={value.userLabel}
              onChange={(event) => updateField("userLabel", event.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 focus:border-teal-400 focus:outline-none"
            />
          </label>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-slate-300">
          <input
            type="checkbox"
            checked={value.demoMode}
            onChange={(event) => updateField("demoMode", event.target.checked)}
            className="h-4 w-4 rounded border-slate-500 text-teal-500 focus:ring-teal-500"
          />
          Demo mode (seeded fact-check behavior)
        </label>
      </div>

      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => {
            void onEnableDevices().catch(() => undefined);
          }}
          className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700"
        >
          Enable Mic + Webcam
        </button>

        {!isRoundActive ? (
          <button
            type="button"
            onClick={() => {
              void onStartRound().catch(() => undefined);
            }}
            className="rounded-lg bg-teal-500 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-teal-400"
          >
            Start Round
          </button>
        ) : (
          <button
            type="button"
            onClick={onStopRound}
            className="rounded-lg bg-rose-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-rose-400"
          >
            Stop Round
          </button>
        )}

        <button
          type="button"
          onClick={onReconnect}
          className="rounded-lg border border-amber-500/60 bg-amber-950/40 px-3 py-2 text-sm font-medium text-amber-200 transition hover:bg-amber-900/50 sm:col-span-2"
        >
          Reconnect Socket
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-slate-300">
        <div className="rounded-lg border border-slate-700 bg-slate-950/70 p-3">
          <p className="font-medium text-slate-100">Microphone</p>
          <p className="mt-1 uppercase tracking-wide">{micPermission}</p>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-950/70 p-3">
          <p className="font-medium text-slate-100">Webcam</p>
          <p className="mt-1 uppercase tracking-wide">{webcamPermission}</p>
        </div>
      </div>
    </section>
  );
}

function App(): ReactElement {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? window.location.origin;
  const wsUrl = useMemo(() => toWebSocketUrl(apiBaseUrl), [apiBaseUrl]);

  const [setup, setSetup] = useState<SetupFormState>(DEFAULT_SETUP);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("idle");
  const [connectionMessage, setConnectionMessage] = useState("Socket not connected yet.");
  const [audioCaptureStatus, setAudioCaptureStatus] = useState<AudioCaptureStatus>("idle");
  const [mediaPipeStatus, setMediaPipeStatus] = useState<MediaPipeStatus>("idle");

  const [micPermission, setMicPermission] = useState<PermissionStatus>("unknown");
  const [webcamPermission, setWebcamPermission] = useState<PermissionStatus>("unknown");

  const [isRoundActive, setIsRoundActive] = useState(false);
  const [sessionId, setSessionId] = useState<string>("-");
  const [roundId, setRoundId] = useState<string>("-");

  const [metrics, setMetrics] = useState<DashboardMetrics>(DEFAULT_DASHBOARD_METRICS);

  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [partialByRole, setPartialByRole] = useState<Record<SpeakerRole, string>>({ user: "", model: "" });

  const [factAlerts, setFactAlerts] = useState<FactcheckAlertEvent[]>([]);
  const [roundReport, setRoundReport] = useState<RoundReportEvent | null>(null);
  const [historyRounds, setHistoryRounds] = useState<HistoryRound[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [reportActionMessage, setReportActionMessage] = useState<string | null>(null);

  const [uiError, setUiError] = useState<string | null>(null);
  const [showDebugLogs, setShowDebugLogs] = useState(false);
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const snapshotTimerRef = useRef<number | null>(null);
  const metricsTimerRef = useRef<number | null>(null);
  const stopRoundFallbackTimerRef = useRef<number | null>(null);

  const streamRef = useRef<MediaStream | null>(null);

  const captureContextRef = useRef<AudioContext | null>(null);
  const captureSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const captureWorkletRef = useRef<AudioWorkletNode | null>(null);

  const audioPlayerRef = useRef(new PcmAudioPlayer());
  const analyticsAggregatorRef = useRef(new DeliveryMetricsAggregator());
  const mediaPipeAnalyzerRef = useRef<LocalMediaPipeAnalyzer | null>(null);

  const shouldReconnectRef = useRef(false);
  const roundActiveRef = useRef(false);
  const pendingStopRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const pingSentAtRef = useRef<Map<string, number>>(new Map());

  const scheduleReconnectRef = useRef<() => void>(() => undefined);
  const sessionStartPayloadRef = useRef<SessionStartEvent | null>(null);
  const chunkSeqRef = useRef(0);
  const snapshotInFlightRef = useRef(false);
  const roundStartedAtRef = useRef<number | null>(null);

  const metricWindowRef = useRef<MetricWindowStats>({
    chunks: 0,
    speakingChunks: 0,
    rmsSum: 0,
    latestRms: 0,
    bytesSent: 0,
    snapshotsSent: 0,
  });

  const appendDebug = useCallback<DebugLogger>((level, message, payload) => {
    setDebugEntries((previous) => {
      const next = [
        ...previous,
        {
          id: makeId("log"),
          level,
          message,
          ts: new Date().toISOString(),
          payload,
        },
      ];
      return next.length > 250 ? next.slice(next.length - 250) : next;
    });
  }, []);

  const clearTimer = useCallback((ref: MutableRefObject<number | null>) => {
    if (ref.current !== null) {
      window.clearInterval(ref.current);
      window.clearTimeout(ref.current);
      ref.current = null;
    }
  }, []);

  const sendClientEvent = useCallback(
    (event: ClientEvent): boolean => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return false;
      }

      socket.send(JSON.stringify(event));
      appendDebug("info", `Sent ${event.type}`, event);
      return true;
    },
    [appendDebug]
  );

  const stopHeartbeat = useCallback(() => {
    clearTimer(heartbeatTimerRef);
  }, [clearTimer]);

  const closeSocket = useCallback(
    (reason: string) => {
      stopHeartbeat();
      clearTimer(reconnectTimerRef);

      const socket = wsRef.current;
      wsRef.current = null;

      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close(1000, reason);
      }
    },
    [clearTimer, stopHeartbeat]
  );

  const stopMediaPipe = useCallback(() => {
    mediaPipeAnalyzerRef.current?.stop();
    setMediaPipeStatus((previous) => (previous === "error" ? previous : "idle"));
  }, []);

  const startMediaPipe = useCallback(async () => {
    if (!videoRef.current) {
      return;
    }

    if (!mediaPipeAnalyzerRef.current) {
      mediaPipeAnalyzerRef.current = createMediaPipeAnalyzer(
        (signals) => analyticsAggregatorRef.current.ingestMediaPipeSignals(signals),
        appendDebug
      );
    }

    if (mediaPipeAnalyzerRef.current.isRunning()) {
      return;
    }

    setMediaPipeStatus("loading");
    try {
      await mediaPipeAnalyzerRef.current.start(videoRef.current);
      setMediaPipeStatus("running");
    } catch (error) {
      const message = error instanceof Error ? error.message : "MediaPipe initialization failed";
      setMediaPipeStatus("error");
      appendDebug("error", "MediaPipe startup failed", { message });
      setUiError(`MediaPipe failed to start: ${message}`);
    }
  }, [appendDebug]);

  const stopAudioCapture = useCallback(async () => {
    const source = captureSourceNodeRef.current;
    const worklet = captureWorkletRef.current;
    const context = captureContextRef.current;

    captureSourceNodeRef.current = null;
    captureWorkletRef.current = null;
    captureContextRef.current = null;

    try {
      source?.disconnect();
      worklet?.disconnect();
    } catch {
      // already disconnected
    }

    if (context) {
      await context.close();
    }

    setAudioCaptureStatus("stopped");
  }, []);

  const stopSnapshotLoop = useCallback(() => {
    clearTimer(snapshotTimerRef);
    snapshotInFlightRef.current = false;
  }, [clearTimer]);

  const stopMetricsLoop = useCallback(() => {
    clearTimer(metricsTimerRef);
  }, [clearTimer]);

  const stopAllRoundPipelines = useCallback(async () => {
    stopHeartbeat();
    stopSnapshotLoop();
    stopMetricsLoop();
    stopMediaPipe();
    await stopAudioCapture();
  }, [stopAudioCapture, stopHeartbeat, stopMediaPipe, stopMetricsLoop, stopSnapshotLoop]);

  const requestDevices = useCallback(async () => {
    setUiError(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      const message = "This browser does not support getUserMedia";
      setUiError(message);
      appendDebug("error", message);
      throw new Error(message);
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: {
          width: { ideal: 960 },
          height: { ideal: 540 },
          frameRate: { ideal: 15, max: 15 },
        },
      });

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }

      setMicPermission("granted");
      setWebcamPermission("granted");
      appendDebug("info", "Device permissions granted");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to access microphone/webcam";
      setMicPermission("denied");
      setWebcamPermission("denied");
      setUiError(message);
      appendDebug("error", "Device permission request failed", { message });
      throw error;
    }
  }, [appendDebug]);

  const captureAndSendSnapshot = useCallback(async () => {
    if (!roundActiveRef.current || !sessionStartPayloadRef.current) {
      return;
    }

    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || !canvas || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || snapshotInFlightRef.current) {
      return;
    }

    snapshotInFlightRef.current = true;
    try {
      const width = Math.max(1, video.videoWidth || 640);
      const height = Math.max(1, video.videoHeight || 360);

      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }

      context.drawImage(video, 0, 0, width, height);

      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", 0.75);
      });

      if (!blob) {
        return;
      }

      const eventPayload: VideoSnapshotEvent = {
        type: "video.snapshot",
        image_b64: await blobToBase64(blob),
        mime_type: "image/jpeg",
        width,
        height,
      };

      if (sendClientEvent(eventPayload)) {
        metricWindowRef.current.snapshotsSent += 1;
      }
    } finally {
      snapshotInFlightRef.current = false;
    }
  }, [sendClientEvent]);

  const startSnapshotLoop = useCallback(() => {
    if (snapshotTimerRef.current !== null) {
      return;
    }

    snapshotTimerRef.current = window.setInterval(() => {
      void captureAndSendSnapshot();
    }, 1000);
  }, [captureAndSendSnapshot]);

  const startHeartbeat = useCallback(() => {
    clearTimer(heartbeatTimerRef);

    heartbeatTimerRef.current = window.setInterval(() => {
      if (!roundActiveRef.current) {
        return;
      }

      const nonce = makeId("ping");
      pingSentAtRef.current.set(nonce, Date.now());
      sendClientEvent({ type: "ping", nonce });
    }, 10000);
  }, [clearTimer, sendClientEvent]);

  const publishMetrics = useCallback(() => {
    const nowMs = performance.now();
    const analyticSnapshot: DeliveryMetricsSnapshot = analyticsAggregatorRef.current.snapshot(nowMs);

    const windowStats = metricWindowRef.current;
    const averageRms = windowStats.chunks > 0 ? windowStats.rmsSum / windowStats.chunks : 0;
    const pauseRatio =
      windowStats.chunks > 0 ? (windowStats.chunks - windowStats.speakingChunks) / windowStats.chunks : 0;
    const audioKbps = windowStats.bytesSent > 0 ? Number(((windowStats.bytesSent * 8) / 1000 / 2).toFixed(1)) : 0;

    const elapsedSec =
      roundStartedAtRef.current !== null ? Math.max(0, Math.floor((Date.now() - roundStartedAtRef.current) / 1000)) : 0;

    setMetrics((previous) => ({
      ...previous,
      eyeContactProxy: analyticSnapshot.eyeContactProxy,
      headTurnFrequencyPerMin: analyticSnapshot.headTurnFrequencyPerMin,
      headTiltPitchInstability: analyticSnapshot.headTiltPitchInstability,
      shoulderTiltProxy: analyticSnapshot.shoulderTiltProxy,
      slouchProxy: analyticSnapshot.slouchProxy,
      speakingPaceWpm: analyticSnapshot.speakingPaceWpm,
      averagePauseLengthSec: analyticSnapshot.averagePauseLengthSec,
      fillerWordDensity: analyticSnapshot.fillerWordDensity,
      faceTracked: analyticSnapshot.faceTracked,
      poseTracked: analyticSnapshot.poseTracked,
      analysisFps: analyticSnapshot.analysisFps,
      analyzedFrames: analyticSnapshot.analyzedFrames,

      averageRms,
      latestRms: windowStats.latestRms,
      pauseRatio,
      chunksSent: previous.chunksSent + windowStats.chunks,
      snapshotsSent: previous.snapshotsSent + windowStats.snapshotsSent,
      audioKbpsEstimate: audioKbps,
      roundSecondsElapsed: elapsedSec,
    }));

    const transportMetrics: DeliveryTransportMetrics = {
      eye_contact_proxy: analyticSnapshot.eyeContactProxy,
      head_turn_frequency_per_min: analyticSnapshot.headTurnFrequencyPerMin,
      head_tilt_pitch_instability: analyticSnapshot.headTiltPitchInstability,
      shoulder_tilt_proxy: analyticSnapshot.shoulderTiltProxy,
      slouch_proxy: analyticSnapshot.slouchProxy,
      speaking_pace_wpm: analyticSnapshot.speakingPaceWpm,
      average_pause_length_sec: analyticSnapshot.averagePauseLengthSec,
      filler_word_density: analyticSnapshot.fillerWordDensity,
      face_tracked: analyticSnapshot.faceTracked,
      pose_tracked: analyticSnapshot.poseTracked,
      analyzed_frames: analyticSnapshot.analyzedFrames,
      analysis_fps: analyticSnapshot.analysisFps,
    };

    const eventPayload: MetricsDeliveryEvent = {
      type: "metrics.delivery",
      metrics: {
        ...transportMetrics,
        mic_rms_avg: Number(averageRms.toFixed(4)),
        mic_rms_latest: Number(windowStats.latestRms.toFixed(4)),
        pause_ratio_audio_window: Number(pauseRatio.toFixed(4)),
        chunks_in_window: windowStats.chunks,
        snapshots_in_window: windowStats.snapshotsSent,
      },
    };

    void sendClientEvent(eventPayload);

    metricWindowRef.current = {
      chunks: 0,
      speakingChunks: 0,
      rmsSum: 0,
      latestRms: 0,
      bytesSent: 0,
      snapshotsSent: 0,
    };
  }, [sendClientEvent]);

  const startMetricsLoop = useCallback(() => {
    if (metricsTimerRef.current !== null) {
      return;
    }

    metricsTimerRef.current = window.setInterval(() => {
      publishMetrics();
    }, 2000);
  }, [publishMetrics]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/api/history?limit=8`);
      if (!response.ok) {
        throw new Error(`History request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as { rounds?: unknown[] };
      const roundsRaw = Array.isArray(payload.rounds) ? payload.rounds : [];
      const normalized: HistoryRound[] = roundsRaw
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }

          const record = item as Record<string, unknown>;
          const rubric = record.rubric;
          if (!rubric || typeof rubric !== "object") {
            return null;
          }

          return {
            roundId: String(record.roundId ?? record.round_id ?? "-"),
            sessionId: typeof record.sessionId === "string" ? record.sessionId : undefined,
            topic: typeof record.topic === "string" ? record.topic : undefined,
            generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : undefined,
            summary: typeof record.summary === "string" ? record.summary : undefined,
            rubric: rubric as HistoryRound["rubric"],
          };
        })
        .filter((item): item is HistoryRound => item !== null);

      setHistoryRounds(normalized);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load session history";
      setHistoryError(message);
      appendDebug("warn", "History load failed", { message });
    } finally {
      setHistoryLoading(false);
    }
  }, [apiBaseUrl, appendDebug]);

  const buildReportSummaryText = useCallback((report: RoundReportEvent): string => {
    const rubric = report.rubric;
    const lines = [
      "DebateGuard Round Report",
      `Session: ${report.session_id}`,
      `Round: ${report.round_id}`,
      `Generated: ${formatClock(report.ts)}`,
      "",
      "Scores",
      `- Argument strength: ${rubric.argument_strength}/10`,
      `- Evidence quality: ${rubric.evidence_quality}/10`,
      `- Responsiveness: ${rubric.responsiveness}/10`,
      `- Delivery: ${rubric.delivery}/10`,
      `- Factual accuracy: ${rubric.factual_accuracy}/10`,
      "",
      "Coach summary",
      rubric.one_sentence_coach_summary,
      "",
      "Top strengths",
      ...rubric.top_strengths.map((item) => `- ${item}`),
      "",
      "Top issues",
      ...rubric.top_issues.map((item) => `- ${item}`),
      "",
      "Next drills",
      ...rubric.next_drills.map((item) => `- ${item}`),
      "",
      "Fact corrections",
      ...(report.cited_corrections.length > 0
        ? report.cited_corrections.flatMap((correction) => {
            const base = [
              `- Claim: ${correction.claim}`,
              `  Verdict: ${correction.verdict} (${Math.round(correction.confidence * 100)}% confidence)`,
            ];
            if (correction.corrected_fact) {
              base.push(`  Correction: ${correction.corrected_fact}`);
            }
            if (correction.citations.length > 0) {
              base.push(...correction.citations.map((citation) => `  Source: ${citation}`));
            }
            return base;
          })
        : ["- No corrections recorded."]),
    ];

    return lines.join("\n");
  }, []);

  const handleCopySummary = useCallback(async () => {
    if (!roundReport) {
      return;
    }

    try {
      await navigator.clipboard.writeText(buildReportSummaryText(roundReport));
      setReportActionMessage("Summary copied to clipboard.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Clipboard write failed";
      setReportActionMessage(`Unable to copy summary: ${message}`);
    }
  }, [buildReportSummaryText, roundReport]);

  const handleDownloadSummary = useCallback(() => {
    if (!roundReport) {
      return;
    }

    const blob = new Blob([buildReportSummaryText(roundReport)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `debateguard-round-${roundReport.round_id}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    setReportActionMessage("Summary downloaded as .txt.");
  }, [buildReportSummaryText, roundReport]);

  const overallRubricScore = useMemo(() => {
    if (!roundReport) {
      return null;
    }

    const scores = [
      roundReport.rubric.argument_strength,
      roundReport.rubric.evidence_quality,
      roundReport.rubric.responsiveness,
      roundReport.rubric.delivery,
      roundReport.rubric.factual_accuracy,
    ];

    const total = scores.reduce((accumulator, value) => accumulator + value, 0);
    return (total / scores.length).toFixed(1);
  }, [roundReport]);

  const deliveryNotes = useMemo(() => {
    if (!roundReport) {
      return [] as string[];
    }

    const notes = roundReport.rubric.top_issues.filter((issue) => {
      const lowered = issue.toLowerCase();
      return (
        lowered.includes("delivery") ||
        lowered.includes("pace") ||
        lowered.includes("posture") ||
        lowered.includes("eye") ||
        lowered.includes("filler") ||
        lowered.includes("pause")
      );
    });

    return notes.length > 0 ? notes : ["Delivery was generally stable; continue monitoring pace and posture consistency."];
  }, [roundReport]);

  const startAudioCapture = useCallback(async () => {
    if (captureContextRef.current || !streamRef.current) {
      return;
    }

    const context = new AudioContext({ latencyHint: "interactive" });
    try {
      await context.audioWorklet.addModule("/worklets/pcm16-capture-processor.js");

      const source = context.createMediaStreamSource(streamRef.current);
      const node = new AudioWorkletNode(context, "pcm16-capture-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        processorOptions: {
          targetSampleRate: 16000,
          chunkMs: 40,
        },
      });

      node.port.onmessage = (event: MessageEvent<AudioWorkletMessage>) => {
        const message = event.data;
        if (!message || message.type !== "pcm16") {
          return;
        }

        const chunk = normalizeChunkPayload(message.chunk);
        if (!chunk || chunk.length === 0) {
          return;
        }

        const rms = computeRms(chunk);
        const stats = metricWindowRef.current;
        stats.chunks += 1;
        stats.rmsSum += rms;
        stats.latestRms = rms;
        stats.bytesSent += chunk.byteLength;
        if (rms > 0.02) {
          stats.speakingChunks += 1;
        }

        analyticsAggregatorRef.current.ingestAudioChunk({
          rms,
          durationMs: 40,
          tsMs: performance.now(),
        });

        if (!roundActiveRef.current) {
          return;
        }

        const payload: AudioChunkEvent = {
          type: "audio.chunk",
          chunk_b64: bytesToBase64(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
          mime_type: "audio/pcm;rate=16000",
          sample_rate_hz: 16000,
          seq: chunkSeqRef.current,
        };

        chunkSeqRef.current += 1;
        sendClientEvent(payload);
      };

      source.connect(node);
      captureContextRef.current = context;
      captureSourceNodeRef.current = source;
      captureWorkletRef.current = node;

      await context.resume();
      setAudioCaptureStatus("capturing");
      appendDebug("info", "Audio capture started");
    } catch (error) {
      await context.close();
      setAudioCaptureStatus("idle");
      const message = error instanceof Error ? error.message : "Audio capture failed";
      appendDebug("error", "Audio capture initialization failed", { message });
      throw error;
    }
  }, [appendDebug, sendClientEvent]);

  const handleServerEvent = useCallback(
    async (event: ServerEvent) => {
      appendDebug("info", `Received ${event.type}`, event);

      switch (event.type) {
        case "session.ready": {
          if (event.heartbeat && event.nonce) {
            const sentAt = pingSentAtRef.current.get(event.nonce);
            if (sentAt) {
              const latency = Date.now() - sentAt;
              pingSentAtRef.current.delete(event.nonce);
              setMetrics((previous) => ({ ...previous, websocketRoundTripMs: latency }));
            }
            return;
          }

          setSessionId(event.session_id);
          setRoundId(event.round_id);
          setConnectionStatus("connected");
          setConnectionMessage(`Connected to ${event.live_model}`);
          return;
        }

        case "transcript.partial": {
          setPartialByRole((previous) => ({ ...previous, [event.role]: event.text }));
          return;
        }

        case "transcript.final": {
          setTranscriptLines((previous) => [
            ...previous,
            { id: event.event_id, role: event.role, text: event.text, ts: event.ts },
          ]);
          setPartialByRole((previous) => ({ ...previous, [event.role]: "" }));

          if (event.role === "user") {
            analyticsAggregatorRef.current.ingestUserTranscript(event.text);
          }
          return;
        }

        case "model.text.delta": {
          setPartialByRole((previous) => ({ ...previous, model: `${previous.model}${event.text}` }));
          return;
        }

        case "model.audio.chunk": {
          await audioPlayerRef.current.enqueuePcm16(base64ToBytes(event.chunk_b64), 24000);
          return;
        }

        case "factcheck.alert": {
          setFactAlerts((previous) => [event, ...previous].slice(0, 10));
          return;
        }

        case "round.report": {
          setRoundReport(event);
          setReportActionMessage(null);
          void loadHistory();
          if (pendingStopRef.current) {
            pendingStopRef.current = false;
            clearTimer(stopRoundFallbackTimerRef);
            closeSocket("round-stopped");
            setConnectionStatus("closed");
            setConnectionMessage("Round stopped");
          }
          return;
        }

        case "error": {
          const detailFromKnownKeys =
            event.details && typeof event.details === "object"
              ? typeof event.details.error === "string"
                ? event.details.error
                : typeof event.details.validation_error === "string"
                ? event.details.validation_error
                : typeof event.details.reason === "string"
                ? event.details.reason
                : null
              : null;

          const detailText =
            detailFromKnownKeys ??
            (event.details && typeof event.details === "object" ? JSON.stringify(event.details) : null);

          const backendDetail = detailText ? ` | detail: ${String(detailText).slice(0, 280)}` : "";
          const message = `[${event.code}] ${event.message}${backendDetail}`;
          setUiError(message);
          setConnectionStatus("error");
          setConnectionMessage(message);
          appendDebug("error", "Backend error event", event);
          return;
        }

        default:
          return;
      }
    },
    [appendDebug, clearTimer, closeSocket, loadHistory]
  );

  const connectSocket = useCallback(
    (payload: SessionStartEvent, isReconnect = false) => {
      closeSocket("new-connection");

      setConnectionStatus(isReconnect ? "reconnecting" : "connecting");
      setConnectionMessage(isReconnect ? "Reconnecting websocket..." : "Connecting websocket...");

      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        reconnectAttemptsRef.current = 0;
        setConnectionStatus("connected");
        setConnectionMessage(isReconnect ? "Socket reconnected" : "Connected. Starting live session...");

        socket.send(JSON.stringify(payload));
        startHeartbeat();
        appendDebug("info", "Socket open; sent session.start", { payload, isReconnect });
      };

      socket.onmessage = (messageEvent) => {
        try {
          const payloadJson = JSON.parse(messageEvent.data as string) as ServerEvent;
          void handleServerEvent(payloadJson);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown parse error";
          setUiError(`Malformed websocket payload: ${message}`);
          appendDebug("error", "Failed to parse websocket payload", { raw: messageEvent.data });
        }
      };

      socket.onerror = () => {
        const message = "WebSocket transport error. Check backend logs and network.";
        setConnectionStatus("error");
        setConnectionMessage(message);
        setUiError(message);
        appendDebug("error", "WebSocket transport error");
      };

      socket.onclose = (closeEvent) => {
        stopHeartbeat();
        if (roundActiveRef.current && shouldReconnectRef.current) {
          scheduleReconnectRef.current();
          return;
        }
        const reason = closeEvent.reason ? ` (${closeEvent.reason})` : "";
        const message = `Socket closed [${closeEvent.code}]${reason}`;
        setConnectionStatus("closed");
        setConnectionMessage(message);
        if (closeEvent.code !== 1000) {
          setUiError(message);
          appendDebug("warn", "WebSocket closed unexpectedly", {
            code: closeEvent.code,
            reason: closeEvent.reason,
          });
        }
      };
    },
    [appendDebug, closeSocket, handleServerEvent, startHeartbeat, stopHeartbeat, wsUrl]
  );

  const scheduleReconnect = useCallback(() => {
    if (!shouldReconnectRef.current || !sessionStartPayloadRef.current) {
      return;
    }

    const nextAttempt = reconnectAttemptsRef.current + 1;
    reconnectAttemptsRef.current = nextAttempt;

    const delayMs = Math.min(1000 * 2 ** (nextAttempt - 1), 8000);
    setConnectionStatus("reconnecting");
    setConnectionMessage(`Socket dropped. Reconnecting in ${Math.round(delayMs / 1000)}s...`);
    setMetrics((previous) => ({ ...previous, reconnectCount: nextAttempt }));

    clearTimer(reconnectTimerRef);
    reconnectTimerRef.current = window.setTimeout(() => {
      const payload = sessionStartPayloadRef.current;
      if (!payload) {
        return;
      }
      connectSocket(payload, true);
    }, delayMs);
  }, [clearTimer, connectSocket]);

  scheduleReconnectRef.current = scheduleReconnect;

  const handleStartRound = useCallback(async () => {
    setUiError(null);

    try {
      if (!streamRef.current) {
        await requestDevices();
      }

      await audioPlayerRef.current.ensureReady();

      const nextSessionId = makeId("session");
      const nextRoundId = makeId("round");

      const payload: SessionStartEvent = {
        type: "session.start",
        session_id: nextSessionId,
        round_id: nextRoundId,
        topic: setup.topic,
        stance: setup.stance,
        difficulty: setup.difficulty,
        user_label: setup.userLabel,
        demo_mode: setup.demoMode,
        metadata: {
          round_length_sec: setup.roundLengthSec,
        },
      };

      sessionStartPayloadRef.current = payload;
      shouldReconnectRef.current = true;
      roundActiveRef.current = true;
      pendingStopRef.current = false;
      setIsRoundActive(true);

      setSessionId(nextSessionId);
      setRoundId(nextRoundId);
      setTranscriptLines([]);
      setFactAlerts([]);
      setRoundReport(null);
      setReportActionMessage(null);
      setPartialByRole({ user: "", model: "" });
      setMetrics(DEFAULT_DASHBOARD_METRICS);

      chunkSeqRef.current = 0;
      roundStartedAtRef.current = Date.now();

      analyticsAggregatorRef.current.reset(performance.now());
      metricWindowRef.current = {
        chunks: 0,
        speakingChunks: 0,
        rmsSum: 0,
        latestRms: 0,
        bytesSent: 0,
        snapshotsSent: 0,
      };

      await startAudioCapture();
      await startMediaPipe();
      startSnapshotLoop();
      startMetricsLoop();

      connectSocket(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start round";
      setUiError(message);
      setConnectionStatus("error");
      setConnectionMessage(message);
      shouldReconnectRef.current = false;
      roundActiveRef.current = false;
      setIsRoundActive(false);
      appendDebug("error", "Round start failed", { message });
    }
  }, [appendDebug, connectSocket, requestDevices, setup, startAudioCapture, startMediaPipe, startMetricsLoop, startSnapshotLoop]);

  const handleStopRound = useCallback(() => {
    if (!roundActiveRef.current) {
      return;
    }

    roundActiveRef.current = false;
    shouldReconnectRef.current = false;
    pendingStopRef.current = true;
    setIsRoundActive(false);

    const sent = sendClientEvent({
      type: "round.stop",
      reason: "user_stopped_round",
    });

    if (!sent) {
      pendingStopRef.current = false;
      closeSocket("round-stop-no-socket");
    } else {
      clearTimer(stopRoundFallbackTimerRef);
      stopRoundFallbackTimerRef.current = window.setTimeout(() => {
        pendingStopRef.current = false;
        closeSocket("round-stop-timeout");
      }, 5000);
    }

    void stopAllRoundPipelines();
  }, [clearTimer, closeSocket, sendClientEvent, stopAllRoundPipelines]);

  const handleManualReconnect = useCallback(() => {
    const payload = sessionStartPayloadRef.current;
    if (!payload) {
      setUiError("No active session payload to reconnect.");
      return;
    }

    shouldReconnectRef.current = true;
    roundActiveRef.current = true;
    setIsRoundActive(true);
    connectSocket(payload, true);
  }, [connectSocket]);


  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    return () => {
      shouldReconnectRef.current = false;
      roundActiveRef.current = false;

      closeSocket("component-unmount");
      clearTimer(reconnectTimerRef);
      clearTimer(snapshotTimerRef);
      clearTimer(metricsTimerRef);
      clearTimer(stopRoundFallbackTimerRef);

      stopMediaPipe();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }

      void stopAudioCapture();
      void audioPlayerRef.current.close();
    };
  }, [clearTimer, closeSocket, stopAudioCapture, stopMediaPipe]);

  const scoreBadge = (value: number): string => {
    if (value >= 0.75) {
      return "text-emerald-300";
    }
    if (value >= 0.45) {
      return "text-amber-300";
    }
    return "text-rose-300";
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <div className="mx-auto max-w-7xl px-5 py-8 lg:px-8">
        <header className="mb-6 rounded-2xl border border-slate-700 bg-slate-900/70 p-5 shadow-xl shadow-black/20">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-teal-300">DebateGuard Live Console</h1>
              <p className="mt-1 text-sm text-slate-300">
                Local MediaPipe delivery analysis + live Gemini debate stream with grounded feedback.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowDebugLogs((current) => !current)}
              className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm font-medium hover:bg-slate-700"
            >
              {showDebugLogs ? "Hide" : "Show"} Debug Drawer
            </button>
          </div>

          <div className="mt-4 grid gap-3 text-xs text-slate-300 sm:grid-cols-5">
            <div className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2">
              <p className="uppercase tracking-wide text-slate-400">Connection</p>
              <p className="mt-1 font-semibold text-slate-100">{connectionStatus}</p>
            </div>
            <div className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2">
              <p className="uppercase tracking-wide text-slate-400">Audio Capture</p>
              <p className="mt-1 font-semibold text-slate-100">{audioCaptureStatus}</p>
            </div>
            <div className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2">
              <p className="uppercase tracking-wide text-slate-400">MediaPipe</p>
              <p className="mt-1 font-semibold text-slate-100">{mediaPipeStatus}</p>
            </div>
            <div className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2">
              <p className="uppercase tracking-wide text-slate-400">Session</p>
              <p className="mt-1 font-semibold text-slate-100">{sessionId}</p>
            </div>
            <div className="rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2">
              <p className="uppercase tracking-wide text-slate-400">Round</p>
              <p className="mt-1 font-semibold text-slate-100">{roundId}</p>
            </div>
          </div>

          <p className="mt-3 text-sm text-slate-300">{connectionMessage}</p>

          {uiError ? (
            <div className="mt-3 rounded-lg border border-rose-500/60 bg-rose-950/30 px-3 py-2 text-sm text-rose-200">
              <div className="flex items-start justify-between gap-3">
                <p className="leading-relaxed">{uiError}</p>
                <button
                  type="button"
                  onClick={() => setUiError(null)}
                  className="rounded border border-rose-400/60 px-2 py-0.5 text-xs text-rose-100 hover:bg-rose-900/40"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}
        </header>

        <div className="grid gap-5 lg:grid-cols-12">
          <div className="space-y-5 lg:col-span-4">
            <SetupPanel
              value={setup}
              onChange={setSetup}
              onEnableDevices={requestDevices}
              onStartRound={handleStartRound}
              onStopRound={handleStopRound}
              onReconnect={handleManualReconnect}
              micPermission={micPermission}
              webcamPermission={webcamPermission}
              connectionStatus={connectionStatus}
              isRoundActive={isRoundActive}
            />

            <section className="rounded-2xl border border-slate-700 bg-slate-900/90 p-5">
              <h2 className="mb-3 text-lg font-semibold">Live Audio + Connection</h2>

              <div className="space-y-3 text-sm">
                <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                  <p className="text-slate-300">Mic RMS (instant)</p>
                  <p className="mt-1 text-xl font-semibold text-teal-300">{metrics.latestRms.toFixed(3)}</p>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                    <p className="text-slate-400">Pause Ratio</p>
                    <p className="mt-1 text-sm font-semibold text-slate-100">{(metrics.pauseRatio * 100).toFixed(1)}%</p>
                  </div>
                  <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                    <p className="text-slate-400">Audio Throughput</p>
                    <p className="mt-1 text-sm font-semibold text-slate-100">~{metrics.audioKbpsEstimate} kbps</p>
                  </div>
                  <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                    <p className="text-slate-400">Reconnects</p>
                    <p className="mt-1 text-sm font-semibold text-slate-100">{metrics.reconnectCount}</p>
                  </div>
                  <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                    <p className="text-slate-400">RTT</p>
                    <p className="mt-1 text-sm font-semibold text-slate-100">
                      {metrics.websocketRoundTripMs ? `${metrics.websocketRoundTripMs} ms` : "-"}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-700 bg-slate-900/90 p-5">
              <h2 className="mb-3 text-lg font-semibold">Webcam Coaching Metrics</h2>

              <div className="overflow-hidden rounded-xl border border-slate-700 bg-black/40">
                <video ref={videoRef} className="aspect-video w-full object-cover" muted playsInline />
              </div>
              <canvas ref={canvasRef} className="hidden" />

              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-2">
                  <p className="text-slate-400">Analysis FPS</p>
                  <p className="mt-1 font-semibold">{metrics.analysisFps.toFixed(1)}</p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-2">
                  <p className="text-slate-400">Frames</p>
                  <p className="mt-1 font-semibold">{metrics.analyzedFrames}</p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-2">
                  <p className="text-slate-400">Chunks Sent</p>
                  <p className="mt-1 font-semibold">{metrics.chunksSent}</p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-2">
                  <p className="text-slate-400">Snapshots Sent</p>
                  <p className="mt-1 font-semibold">{metrics.snapshotsSent}</p>
                </div>
              </div>

              <div className="mt-3 rounded-lg border border-teal-700/50 bg-teal-950/20 px-3 py-2 text-xs text-teal-100">
                Privacy note: Face/Pose landmark analysis runs locally in your browser. Raw webcam video is not stored by
                default. Backend receives aggregate metrics every 2s and sparse JPEG snapshots at max 1 FPS.
              </div>
            </section>

            <section className="rounded-2xl border border-slate-700 bg-slate-900/90 p-5">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">Session History</h2>
                <button
                  type="button"
                  onClick={() => {
                    void loadHistory();
                  }}
                  className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                >
                  Refresh
                </button>
              </div>

              {historyLoading ? (
                <p className="text-sm text-slate-400">Loading recent rounds...</p>
              ) : historyError ? (
                <p className="rounded-lg border border-rose-500/50 bg-rose-950/20 px-3 py-2 text-sm text-rose-200">
                  {historyError}
                </p>
              ) : historyRounds.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-700 bg-slate-950/40 px-3 py-3 text-sm text-slate-400">
                  No saved rounds yet.
                </p>
              ) : (
                <ul className="space-y-2">
                  {historyRounds.map((item) => (
                    <li key={item.roundId} className="rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-400">{formatClock(item.generatedAt)}</p>
                      <p className="mt-1 text-sm font-medium text-slate-100">{item.topic || "Debate round"}</p>
                      <p className="mt-1 text-xs text-slate-300">
                        Score avg:{" "}
                        {[
                          item.rubric.argument_strength,
                          item.rubric.evidence_quality,
                          item.rubric.responsiveness,
                          item.rubric.delivery,
                          item.rubric.factual_accuracy,
                        ]
                          .filter((value): value is number => typeof value === "number")
                          .reduce((sum, value, _, array) => sum + value / array.length, 0)
                          .toFixed(1)}
                        /10
                      </p>
                      {item.summary ? <p className="mt-1 text-xs text-slate-300">{item.summary}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="space-y-5 lg:col-span-8">
            <section className="rounded-2xl border border-slate-700 bg-slate-900/90 p-5">
              <h2 className="mb-3 text-lg font-semibold">Delivery Analytics (Local MediaPipe)</h2>

              <div className="grid gap-2 sm:grid-cols-4 text-xs">
                <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                  <p className="text-slate-400">Eye Contact Proxy</p>
                  <p className={`mt-1 text-lg font-semibold ${scoreBadge(metrics.eyeContactProxy)}`}>
                    {(metrics.eyeContactProxy * 100).toFixed(0)}%
                  </p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                  <p className="text-slate-400">Head Turns / Min</p>
                  <p className="mt-1 text-lg font-semibold text-slate-100">{metrics.headTurnFrequencyPerMin.toFixed(1)}</p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                  <p className="text-slate-400">Tilt/Pitch Instability</p>
                  <p className={`mt-1 text-lg font-semibold ${scoreBadge(1 - metrics.headTiltPitchInstability)}`}>
                    {(metrics.headTiltPitchInstability * 100).toFixed(0)}%
                  </p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                  <p className="text-slate-400">Shoulder Tilt Proxy</p>
                  <p className={`mt-1 text-lg font-semibold ${scoreBadge(1 - metrics.shoulderTiltProxy)}`}>
                    {(metrics.shoulderTiltProxy * 100).toFixed(0)}%
                  </p>
                </div>

                <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                  <p className="text-slate-400">Slouch Proxy</p>
                  <p className={`mt-1 text-lg font-semibold ${scoreBadge(1 - metrics.slouchProxy)}`}>
                    {(metrics.slouchProxy * 100).toFixed(0)}%
                  </p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                  <p className="text-slate-400">Speaking Pace</p>
                  <p className="mt-1 text-lg font-semibold text-slate-100">{metrics.speakingPaceWpm.toFixed(0)} wpm</p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                  <p className="text-slate-400">Avg Pause Length</p>
                  <p className="mt-1 text-lg font-semibold text-slate-100">{metrics.averagePauseLengthSec.toFixed(2)} s</p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                  <p className="text-slate-400">Filler Word Density</p>
                  <p className="mt-1 text-lg font-semibold text-slate-100">{(metrics.fillerWordDensity * 100).toFixed(1)}%</p>
                </div>
              </div>

              <p className="mt-3 text-xs text-slate-400">
                Metrics are updated every 2 seconds from local Face/Pose landmarks and audio activity.
              </p>
            </section>

            <section className="rounded-2xl border border-slate-700 bg-slate-900/90 p-5">
              <h2 className="mb-4 text-lg font-semibold">Live Transcript</h2>

              <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
                {transcriptLines.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-slate-700 bg-slate-950/40 px-3 py-4 text-sm text-slate-400">
                    Transcript will appear once the round starts.
                  </p>
                ) : (
                  transcriptLines.map((line) => (
                    <div
                      key={line.id}
                      className={`rounded-lg border px-3 py-2 text-sm ${
                        line.role === "user"
                          ? "border-teal-700/80 bg-teal-950/30"
                          : "border-indigo-700/80 bg-indigo-950/30"
                      }`}
                    >
                      <div className="mb-1 flex items-center justify-between text-xs uppercase tracking-wide">
                        <span className="font-semibold">{line.role === "user" ? "You" : "Gemini Agent"}</span>
                        <span className="text-slate-400">{formatClock(line.ts)}</span>
                      </div>
                      <p className="whitespace-pre-wrap leading-relaxed">{line.text}</p>
                    </div>
                  ))
                )}
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                  <p className="mb-1 text-xs uppercase tracking-wide text-slate-400">User Partial</p>
                  <p className="text-sm text-slate-200">{partialByRole.user || "-"}</p>
                </div>
                <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                  <p className="mb-1 text-xs uppercase tracking-wide text-slate-400">Agent Partial</p>
                  <p className="text-sm text-slate-200">{partialByRole.model || "-"}</p>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-700 bg-slate-900/90 p-5">
              <h2 className="mb-3 text-lg font-semibold">Fact-Check Alerts</h2>
              <div className="space-y-3">
                {factAlerts.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-slate-700 bg-slate-950/40 px-3 py-3 text-sm text-slate-400">
                    No live fact-check alerts yet.
                  </p>
                ) : (
                  factAlerts.map((alert) => (
                    <article key={alert.event_id} className="rounded-xl border border-amber-600/60 bg-amber-950/20 p-3">
                      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-amber-200">
                        <span>{alert.verdict}</span>
                        <span>{(alert.confidence * 100).toFixed(0)}% confidence</span>
                      </div>
                      <p className="text-sm text-slate-100">
                        <span className="font-semibold">Claim:</span> {alert.claim}
                      </p>
                      <p className="mt-1 text-sm text-slate-200">{alert.short_explanation}</p>
                      {alert.corrected_fact ? (
                        <p className="mt-1 text-sm text-teal-200">
                          <span className="font-semibold">Correction:</span> {alert.corrected_fact}
                        </p>
                      ) : null}
                      {alert.citations.length > 0 ? (
                        <div className="mt-2 rounded-lg border border-slate-700/70 bg-slate-900/40 p-2">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-300">Citations</p>
                          <ul className="mt-1 space-y-1 text-xs text-slate-200">
                            {alert.citations.map((citation) => (
                              <li key={`${alert.event_id}-${citation}`}>
                                <a
                                  href={citation}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="underline decoration-slate-400 hover:text-teal-200"
                                >
                                  {citation}
                                </a>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </article>
                  ))
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-700 bg-slate-900/90 p-5">
              <h2 className="mb-3 text-lg font-semibold">Round Report</h2>

              {!roundReport ? (
                <p className="rounded-lg border border-dashed border-slate-700 bg-slate-950/40 px-3 py-3 text-sm text-slate-400">
                  Round report will appear after you stop the round.
                </p>
              ) : (
                <div className="space-y-4">
                  <div className="grid gap-2 sm:grid-cols-6">
                    <div className="rounded-lg border border-emerald-700/70 bg-emerald-950/30 p-3 text-center">
                      <p className="text-xs uppercase text-emerald-200">Overall</p>
                      <p className="mt-1 text-lg font-semibold text-emerald-100">{overallRubricScore ?? "-"}</p>
                    </div>
                    <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3 text-center">
                      <p className="text-xs uppercase text-slate-400">Argument</p>
                      <p className="mt-1 text-lg font-semibold text-emerald-300">{roundReport.rubric.argument_strength}</p>
                    </div>
                    <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3 text-center">
                      <p className="text-xs uppercase text-slate-400">Evidence</p>
                      <p className="mt-1 text-lg font-semibold text-emerald-300">{roundReport.rubric.evidence_quality}</p>
                    </div>
                    <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3 text-center">
                      <p className="text-xs uppercase text-slate-400">Response</p>
                      <p className="mt-1 text-lg font-semibold text-emerald-300">{roundReport.rubric.responsiveness}</p>
                    </div>
                    <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3 text-center">
                      <p className="text-xs uppercase text-slate-400">Delivery</p>
                      <p className="mt-1 text-lg font-semibold text-emerald-300">{roundReport.rubric.delivery}</p>
                    </div>
                    <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3 text-center">
                      <p className="text-xs uppercase text-slate-400">Factual</p>
                      <p className="mt-1 text-lg font-semibold text-emerald-300">{roundReport.rubric.factual_accuracy}</p>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-slate-100">Coach Summary</p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            void handleCopySummary();
                          }}
                          className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                        >
                          Copy Summary
                        </button>
                        <button
                          type="button"
                          onClick={handleDownloadSummary}
                          className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                        >
                          Download .txt
                        </button>
                      </div>
                    </div>
                    <p className="mt-1 text-sm text-slate-300">{roundReport.rubric.one_sentence_coach_summary}</p>
                    {reportActionMessage ? <p className="mt-2 text-xs text-teal-200">{reportActionMessage}</p> : null}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                      <p className="text-sm font-medium text-slate-100">Top Strengths</p>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-300">
                        {roundReport.rubric.top_strengths.map((strength) => (
                          <li key={strength}>{strength}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                      <p className="text-sm font-medium text-slate-100">Top Issues</p>
                      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-300">
                        {roundReport.rubric.top_issues.map((issue) => (
                          <li key={issue}>{issue}</li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                    <p className="text-sm font-medium text-slate-100">Delivery Notes</p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-300">
                      {deliveryNotes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                    <p className="text-sm font-medium text-slate-100">Fact Corrections</p>
                    {roundReport.cited_corrections.length === 0 ? (
                      <p className="mt-2 text-sm text-slate-400">No corrections were logged this round.</p>
                    ) : (
                      <div className="mt-2 space-y-3">
                        {roundReport.cited_corrections.map((correction, index) => (
                          <article
                            key={`${correction.claim}-${index}`}
                            className="rounded border border-slate-700 bg-slate-900/50 p-3 text-sm"
                          >
                            <div className="flex items-center justify-between gap-2 text-xs uppercase tracking-wide text-amber-200">
                              <span>{correction.verdict}</span>
                              <span>{Math.round(correction.confidence * 100)}% confidence</span>
                            </div>
                            <p className="mt-1 text-slate-100">
                              <span className="font-semibold">Claim:</span> {correction.claim}
                            </p>
                            <p className="mt-1 text-slate-300">{correction.short_explanation}</p>
                            {correction.corrected_fact ? (
                              <p className="mt-1 text-teal-200">
                                <span className="font-semibold">Correction:</span> {correction.corrected_fact}
                              </p>
                            ) : null}
                            {correction.citations.length > 0 ? (
                              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-300">
                                {correction.citations.map((citation) => (
                                  <li key={`${correction.claim}-${citation}`}>
                                    <a
                                      href={citation}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="underline decoration-slate-400 hover:text-teal-200"
                                    >
                                      {citation}
                                    </a>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </article>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                    <p className="text-sm font-medium text-slate-100">Next Drills</p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-300">
                      {roundReport.rubric.next_drills.map((drill) => (
                        <li key={drill}>{drill}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
      {showDebugLogs ? (
        <aside className="fixed bottom-0 left-0 right-0 h-72 border-t border-slate-700 bg-slate-950/95 px-5 py-3 backdrop-blur">
          <div className="mx-auto flex h-full max-w-7xl flex-col">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-200">Debug Event Log</h3>
              <button
                type="button"
                onClick={() => setDebugEntries([])}
                className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
              >
                Clear
              </button>
            </div>

            <div className="overflow-y-auto rounded border border-slate-700 bg-black/40 p-2 text-xs">
              {debugEntries.length === 0 ? (
                <p className="text-slate-400">No debug entries yet.</p>
              ) : (
                <ul className="space-y-1">
                  {debugEntries
                    .slice()
                    .reverse()
                    .map((entry) => (
                      <li key={entry.id} className="rounded border border-slate-800 bg-slate-900/70 px-2 py-1">
                        <div className="flex items-center justify-between gap-3">
                          <span
                            className={`font-semibold uppercase ${
                              entry.level === "error"
                                ? "text-rose-300"
                                : entry.level === "warn"
                                ? "text-amber-300"
                                : "text-teal-300"
                            }`}
                          >
                            {entry.level}
                          </span>
                          <span className="text-slate-500">{formatClock(entry.ts)}</span>
                        </div>
                        <p className="mt-0.5 text-slate-200">{entry.message}</p>
                        {entry.payload ? (
                          <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap text-[11px] text-slate-400">
                            {JSON.stringify(entry.payload, null, 2)}
                          </pre>
                        ) : null}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </div>
        </aside>
      ) : null}
    </main>
  );
}

export default App;
