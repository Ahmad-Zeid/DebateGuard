import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../lib/api';
import { useDebateSocket } from '../hooks/useDebateSocket';
import { useHeuristics } from '../hooks/useHeuristics';
import { X, Loader2, Timer, Mic, Video, AlertTriangle } from 'lucide-react';

const DEBATE_DURATION = 120; // 2 minutes in seconds

const METRIC_LABELS = ['Gaze', 'Posture', 'Shielding', 'Yaw', 'Soothing', 'Swaying', 'Tilt'];
const NUDGE_TEXTS: Record<string, string> = {
  gaze: 'User is breaking eye contact. Tell him to look at the camera.',
  posture: 'User is slouching. Tell him to sit up.',
  shielding: 'User is crossing his arms. Tell him to uncross them.',
  yaw: 'User is turning his head rapidly. Tell him to stay steady.',
  soothing: 'User is touching his face/neck. Tell him to keep his hands down.',
  swaying: 'User is swaying. Tell him to plant his feet.',
  tilt: 'User is tilting his shoulders. Tell him to square up.',
};
const METRIC_KEYS = ['gaze', 'posture', 'shielding', 'yaw', 'soothing', 'swaying', 'tilt'];
// Priority: Gaze > Posture > Shielding > Yaw > Soothing > Swaying > Tilt
const PRIORITY_ORDER = [0, 1, 2, 3, 4, 5, 6];

interface TranscriptMessage {
  role: 'user' | 'agent';
  text: string;
  isFinal: boolean;
}

export default function DebateRoom() {
  const { debateId } = useParams<{ debateId: string }>();
  const navigate = useNavigate();

  // State
  const [calibrating, setCalibrating] = useState(true);
  const [calibrationCountdown, setCalibrationCountdown] = useState(3);
  const [timeLeft, setTimeLeft] = useState(DEBATE_DURATION);
  const [isActive, setIsActive] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastFading, setToastFading] = useState(false);
  const [generatingReport, setGeneratingReport] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptMessage[]>([]);
  const [debateMode, setDebateMode] = useState<'DEBATE'|'COACH'|null>(null);

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cycleCountRef = useRef(0);
  const elapsedRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);

  // Fetch Debate Mode
  useEffect(() => {
    if (!debateId) return;
    api.get(`/debates/${debateId}`).then(res => {
      if (res.data.has_transcripts) {
        navigate(`/report/${debateId}`);
        return;
      }
      setDebateMode(res.data.mode);
    }).catch(err => {
      console.error(err);
      setDebateMode('COACH');
    });
  }, [debateId, navigate]);

  const handleTranscript = useCallback((msg: TranscriptMessage) => {
    setTranscripts((prev) => {
      // Find the most recent message of the SAME role
      let lastRoleIndex = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === msg.role) {
          lastRoleIndex = i;
          break;
        }
      }

      // If we found an active (non-final) message for this role, update it
      if (lastRoleIndex !== -1 && !prev[lastRoleIndex].isFinal) {
        const next = [...prev];
        next[lastRoleIndex] = msg;
        return next;
      }
      
      // Otherwise append it as a new message bubble
      return [...prev, msg];
    });
  }, []);

  // WebSocket hook
  const {
    isConnected,
    sendJson,
    close: closeSocket,
  } = useDebateSocket({
    debateId: debateId!,
    onTranscript: handleTranscript,
    onAudioData: undefined, // handled internally by the hook
    enabled: isActive && !calibrating,
  });

  // Heuristics hook
  const { getMetrics, resetBuffer } = useHeuristics({
    videoRef,
    enabled: isActive && !calibrating,
  });

  // Show toast for 3 seconds
  const showToast = useCallback((message: string) => {
    setToast(message);
    setToastFading(false);
    setTimeout(() => setToastFading(true), 2500);
    setTimeout(() => setToast(null), 3000);
  }, []);

  // End debate
  const endDebate = useCallback(async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setIsActive(false);
    closeSocket();

    // Stop media
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
    }

    // Generate report
    setGeneratingReport(true);
    try {
      await api.post(`/debates/${debateId}/report`);
    } catch {
      // still navigate
    }
    navigate(`/report/${debateId}`);
  }, [debateId, closeSocket, navigate]);

  // Setup camera
  useEffect(() => {
    const setupCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 768, height: 768, facingMode: 'user' },
          audio: false,
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (err) {
        console.error('Camera access denied:', err);
      }
    };
    setupCamera();

    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  // Calibration countdown
  useEffect(() => {
    if (!calibrating) return;

    const interval = setInterval(() => {
      setCalibrationCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          setCalibrating(false);
          setIsActive(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [calibrating]);

  // Main timer countdown
  useEffect(() => {
    if (!isActive) return;

    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          endDebate();
          return 0;
        }
        return prev - 1;
      });
      elapsedRef.current += 1;
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isActive, endDebate]);

  // Video frame capture (1 FPS)
  useEffect(() => {
    if (!isActive || !isConnected) return;

    const interval = setInterval(() => {
      if (!videoRef.current || !canvasRef.current) return;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      canvas.width = 768;
      canvas.height = 768;
      ctx.drawImage(videoRef.current, 0, 0, 768, 768);

      canvas.toBlob(
        (blob) => {
          if (!blob) return;
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = (reader.result as string).split(',')[1];
            sendJson({
              type: 'image',
              mime_type: 'image/jpeg',
              data: base64,
            });
          };
          reader.readAsDataURL(blob);
        },
        'image/jpeg',
        0.5
      );
    }, 1000);

    return () => clearInterval(interval);
  }, [isActive, isConnected, sendJson]);

  // 5-second heuristics cycle
  useEffect(() => {
    if (!isActive) return;

    const interval = setInterval(() => {
      cycleCountRef.current += 1;
      const metrics = getMetrics();
      const secondStart = (cycleCountRef.current - 1) * 5;
      const secondEnd = cycleCountRef.current * 5;

      // 1. Send telemetry to WS (stored in DB)
      sendJson({
        type: 'telemetry',
        metrics,
        secondStart,
        secondEnd,
      });

      // 2. UI Warning toast — find highest priority true metric
      // Only show toast and nudge in COACH mode
      if (debateMode !== 'DEBATE') {
        const highPriorityIdx = PRIORITY_ORDER.find((i) => metrics[i]);
        if (highPriorityIdx !== undefined) {
          showToast(`⚠️ ${METRIC_LABELS[highPriorityIdx]} issue detected`);
        }

        // 3. Every 2nd cycle (10s): send AI nudge
        if (cycleCountRef.current % 2 === 0) {
          const nudgeIdx = PRIORITY_ORDER.find((i) => metrics[i]);
          if (nudgeIdx !== undefined) {
            sendJson({
              type: 'nudge',
              text: NUDGE_TEXTS[METRIC_KEYS[nudgeIdx]],
            });
          }
        }
      }

      // 4. Flush buffer
      resetBuffer();
    }, 5000);

    return () => clearInterval(interval);
  }, [isActive, debateMode, getMetrics, resetBuffer, sendJson, showToast]);

  // Prevent accidental refresh / closing during active debate
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isActive && !generatingReport) {
        e.preventDefault();
        // Chrome requires returnValue to be set
        e.returnValue = ''; 
        return '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isActive, generatingReport]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcripts]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const timerColor = timeLeft <= 30 ? 'text-red-400' : timeLeft <= 60 ? 'text-orange-400' : 'text-gray-100';

  // Waveform bars for AI visualizer
  const waveformBars = Array.from({ length: 40 }, (_, i) => i);

  return (
    <div className="h-[calc(100vh-64px)] flex flex-col bg-gray-950 overflow-hidden">
      {/* Calibration Overlay */}
      {calibrating && (
        <div className="absolute inset-0 z-50 bg-gray-950/95 flex items-center justify-center">
          <div className="text-center">
            <div className="relative w-32 h-32 mx-auto mb-6">
              <div className="absolute inset-0 rounded-full border-4 border-red-500/30 calibration-pulse" />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-5xl font-bold text-red-400">{calibrationCountdown}</span>
              </div>
            </div>
            <h2 className="text-2xl font-bold text-gray-100 mb-2">Calibrating</h2>
            <p className="text-gray-400">Sit straight & look at the camera</p>
          </div>
        </div>
      )}

      {/* Generating Report Overlay */}
      {generatingReport && (
        <div className="absolute inset-0 z-50 bg-gray-950/95 flex items-center justify-center">
          <div className="text-center">
            <Loader2 className="w-12 h-12 animate-spin text-red-400 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-gray-100 mb-2">Generating Report...</h2>
            <p className="text-gray-400">Analyzing your performance</p>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-red-500/15 border border-red-500/40 text-red-400 px-6 py-3 rounded-xl shadow-2xl backdrop-blur-sm ${toastFading ? 'toast-exit' : 'toast-enter'
            }`}
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            <span className="text-sm font-medium">{toast}</span>
          </div>
        </div>
      )}

      {/* Top Bar */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-800/60 bg-gray-900/50 backdrop-blur-sm">
        <div className="flex items-center gap-4 min-w-0">
          <div className="flex items-center gap-2 text-gray-400">
            <Mic className="w-4 h-4 text-green-400" />
            <Video className="w-4 h-4 text-green-400" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-gray-200 truncate">Live Debate</h1>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Timer */}
          <div className={`flex items-center gap-2 px-4 py-1.5 rounded-lg bg-gray-800/50 border border-gray-700/50 ${timerColor}`}>
            <Timer className="w-4 h-4" />
            <span className="font-mono text-lg font-bold">{formatTime(timeLeft)}</span>
          </div>

          {/* End Debate */}
          <button
            onClick={endDebate}
            className="flex items-center gap-2 px-4 py-1.5 bg-red-600 hover:bg-red-500 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
            End Debate
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Stage */}
        <div className="flex-1 flex flex-col relative">
          {/* User Camera — Primary View */}
          <div className="flex-1 flex items-center justify-center bg-gray-950 overflow-hidden">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="h-full w-full object-cover"
              style={{ transform: 'scaleX(-1)' }}
            />
          </div>

          {/* AI Audio Visualizer — PiP Overlay */}
          <div className="absolute bottom-4 left-4 px-4 py-3 rounded-xl bg-gray-900/80 backdrop-blur-sm border border-gray-700/50 shadow-2xl flex items-end gap-0.5 h-14">
            {waveformBars.map((i) => {
              const h = isActive && isConnected ? 8 + ((i * 7 + 3) % 25) : 8;
              return (
                <div
                  key={i}
                  className="w-1 bg-linear-to-t from-red-500 to-orange-400 rounded-full opacity-60"
                  style={{
                    height: `${h}px`,
                    transition: 'height 0.15s ease',
                    animationDelay: `${i * 0.05}s`,
                  }}
                />
              );
            })}
          </div>

          {/* Hidden canvas for frame capture */}
          <canvas ref={canvasRef} className="hidden" />
        </div>

        {/* Transcript Panel */}
        <div className="w-80 border-l border-gray-800/60 flex flex-col bg-gray-900/30">
          <div className="px-4 py-3 border-b border-gray-800/60">
            <h2 className="text-sm font-semibold text-gray-300">Transcript</h2>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {transcripts.length === 0 && (
              <p className="text-xs text-gray-600 text-center mt-8">
                Conversation will appear here...
              </p>
            )}
            {transcripts.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] px-3 py-2 rounded-xl text-sm ${msg.role === 'user'
                    ? 'bg-red-500/15 text-red-200 rounded-br-sm'
                    : 'bg-gray-800/60 text-gray-300 rounded-bl-sm'
                    } ${!msg.isFinal ? 'opacity-60' : ''}`}
                >
                  <p className="text-xs font-medium mb-0.5 opacity-50">
                    {msg.role === 'user' ? 'You' : 'AI'}
                  </p>
                  {msg.text}
                </div>
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
