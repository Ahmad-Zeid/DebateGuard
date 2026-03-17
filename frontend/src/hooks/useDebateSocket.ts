import { useEffect, useRef, useCallback, useState } from 'react';
import { WS_BASE_URL } from '../lib/api';

interface UseDebateSocketOptions {
  debateId: string;
  onTranscript?: (msg: { role: 'user' | 'agent'; text: string; isFinal: boolean }) => void;
  onAudioData?: (data: ArrayBuffer) => void;
  enabled: boolean;
}

export function useDebateSocket({ debateId, onTranscript, enabled }: UseDebateSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // Playback queue for incoming audio
  const nextPlayTimeRef = useRef(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);

  const stopAllAudio = useCallback(() => {
    activeSourcesRef.current.forEach(source => {
      try { source.stop(); } catch { /* ignore if already stopped */ }
    });
    activeSourcesRef.current = [];
    if (audioContextRef.current) {
      nextPlayTimeRef.current = audioContextRef.current.currentTime;
    }
  }, []);

  const playPCM = useCallback((pcmData: ArrayBuffer) => {
    const ctx = audioContextRef.current;
    if (!ctx) return;

    const int16 = new Int16Array(pcmData);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    // Output at 24kHz (Gemini output sample rate)
    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    // Clean up from active sources when ended
    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
    };

    const now = ctx.currentTime;
    const startTime = Math.max(now, nextPlayTimeRef.current);
    source.start(startTime);
    
    activeSourcesRef.current.push(source);
    nextPlayTimeRef.current = startTime + buffer.duration;
  }, []);

  // Connect WebSocket + Mic
  useEffect(() => {
    if (!enabled) return;

    const token = localStorage.getItem('token');
    if (!token) return;

    const ws = new WebSocket(`${WS_BASE_URL}/ws/debate/${debateId}?token=${token}`);
    wsRef.current = ws;

    ws.binaryType = 'arraybuffer';

    ws.onopen = async () => {
      setIsConnected(true);

      // Setup AudioContext for both playback and mic capture
      const ctx = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = ctx;

      try {
        await ctx.audioWorklet.addModule('/pcm-processor.js');

        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
        micStreamRef.current = micStream;

        const source = ctx.createMediaStreamSource(micStream);
        const worklet = new AudioWorkletNode(ctx, 'pcm-processor');
        workletNodeRef.current = worklet;

        worklet.port.onmessage = (e: MessageEvent) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(e.data);
          }
        };

        source.connect(worklet);
        worklet.connect(ctx.destination);
        // We connect worklet to destination to ensure the audio graph runs, 
        // but pcm-processor doesn't write to outputs so it won't echo.
      } catch (err) {
        console.error('Mic setup failed:', err);
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        // Binary = audio from AI
        playPCM(event.data);
      } else {
        // JSON
        try {
          const payload = JSON.parse(event.data);
          
          if (payload.type === 'interrupted' || payload.type === 'turn_complete') {
             // Reset audio playback queue so new streams don't overlap with old target times
             stopAllAudio();
          }
          
          if (payload.type === 'transcript' && onTranscript) {
            onTranscript({
              role: payload.role === 'user' ? 'user' : 'agent',
              text: payload.text,
              isFinal: payload.is_final,
            });
          }
        } catch {
          // ignore parse errors
        }
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
    };

    ws.onerror = () => {
      setIsConnected(false);
    };

    return () => {
      // Cleanup
      if (workletNodeRef.current) {
        workletNodeRef.current.disconnect();
      }
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
  }, [enabled, debateId, onTranscript, playPCM, stopAllAudio]);

  const sendBinary = useCallback((data: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  const sendJson = useCallback((data: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const close = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }
  }, []);

  return { isConnected, sendBinary, sendJson, close };
}
