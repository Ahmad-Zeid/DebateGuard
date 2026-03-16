import { useEffect, useRef, useCallback, useState, type RefObject } from 'react';
import { FaceLandmarker, PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

// Landmark indices 
// Pose: 0=nose, 11=left_shoulder, 12=right_shoulder, 13=left_elbow, 14=right_elbow,
//        15=left_wrist, 16=right_wrist, 23=left_hip, 24=right_hip
// Face: 468-472 = iris landmarks, 33=right_eye_outer, 133=right_eye_inner,
//        362=left_eye_outer, 263=left_eye_inner, 1=nose_tip, 234=right_ear, 454=left_ear

interface FrameSnapshot {
  // Pose
  leftShoulder: { x: number; y: number };
  rightShoulder: { x: number; y: number };
  leftHip: { x: number; y: number };
  rightHip: { x: number; y: number };
  leftWrist: { x: number; y: number };
  rightWrist: { x: number; y: number };
  leftElbow: { x: number; y: number };
  rightElbow: { x: number; y: number };
  nose: { x: number; y: number };
  // Face
  leftIris?: { x: number };
  rightIris?: { x: number };
  leftEyeOuter?: { x: number };
  leftEyeInner?: { x: number };
  rightEyeOuter?: { x: number };
  rightEyeInner?: { x: number };
  noseTip?: { x: number };
  leftEar?: { x: number };
  rightEar?: { x: number };
}

interface UseHeuristicsOptions {
  videoRef: RefObject<HTMLVideoElement | null>;
  enabled: boolean;
}

export function useHeuristics({ videoRef, enabled }: UseHeuristicsOptions) {
  const faceLandmarkerRef = useRef<FaceLandmarker | null>(null);
  const poseLandmarkerRef = useRef<PoseLandmarker | null>(null);
  const bufferRef = useRef<FrameSnapshot[]>([]);
  const calibrationRef = useRef<number | null>(null); // shoulder-to-hip baseline Y distance
  const [calibrationBaseline, setCalibrationBaseline] = useState<number | null>(null);
  const animFrameRef = useRef<number>(0);
  const initRef = useRef(false);

  // Initialize MediaPipe models
  useEffect(() => {
    if (!enabled || initRef.current) return;
    initRef.current = true;

    const init = async () => {
      try {
        const vision = await FilesetResolver.forVisionTasks(WASM_CDN);

        const face = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false,
        });
        faceLandmarkerRef.current = face;

        const pose = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
        });
        poseLandmarkerRef.current = pose;
      } catch (err) {
        console.error('Failed to initialize MediaPipe:', err);
      }
    };

    init();
  }, [enabled]);

  // Run detection loop ~30 FPS
  useEffect(() => {
    if (!enabled) return;

    let lastTimestamp = 0;

    const detect = () => {
      const vid = videoRef.current;
      if (!vid || vid.readyState < 2) {
        animFrameRef.current = requestAnimationFrame(detect);
        return;
      }

      const now = performance.now();
      // Throttle to ~30 FPS
      if (now - lastTimestamp < 33) {
        animFrameRef.current = requestAnimationFrame(detect);
        return;
      }
      lastTimestamp = now;

      const snapshot: FrameSnapshot = {
        leftShoulder: { x: 0, y: 0 },
        rightShoulder: { x: 0, y: 0 },
        leftHip: { x: 0, y: 0 },
        rightHip: { x: 0, y: 0 },
        leftWrist: { x: 0, y: 0 },
        rightWrist: { x: 0, y: 0 },
        leftElbow: { x: 0, y: 0 },
        rightElbow: { x: 0, y: 0 },
        nose: { x: 0, y: 0 },
      };

      // Pose detection
      if (poseLandmarkerRef.current) {
        try {
          const poseResult = poseLandmarkerRef.current.detectForVideo(vid, now);
          if (poseResult.landmarks && poseResult.landmarks.length > 0) {
            const lm = poseResult.landmarks[0];
            snapshot.leftShoulder = { x: lm[11].x, y: lm[11].y };
            snapshot.rightShoulder = { x: lm[12].x, y: lm[12].y };
            snapshot.leftHip = { x: lm[23].x, y: lm[23].y };
            snapshot.rightHip = { x: lm[24].x, y: lm[24].y };
            snapshot.leftWrist = { x: lm[15].x, y: lm[15].y };
            snapshot.rightWrist = { x: lm[16].x, y: lm[16].y };
            snapshot.leftElbow = { x: lm[13].x, y: lm[13].y };
            snapshot.rightElbow = { x: lm[14].x, y: lm[14].y };
            snapshot.nose = { x: lm[0].x, y: lm[0].y };

            // Set calibration baseline (average shoulder-to-hip dist)
            if (calibrationRef.current === null) {
              const leftDist = Math.abs(lm[11].y - lm[23].y);
              const rightDist = Math.abs(lm[12].y - lm[24].y);
              calibrationRef.current = (leftDist + rightDist) / 2;
              setCalibrationBaseline(calibrationRef.current);
            }
          }
        } catch { /* skip frame */ }
      }

      // Face detection
      if (faceLandmarkerRef.current) {
        try {
          const faceResult = faceLandmarkerRef.current.detectForVideo(vid, now);
          if (faceResult.faceLandmarks && faceResult.faceLandmarks.length > 0) {
            const fl = faceResult.faceLandmarks[0];
            // Iris centers (478 landmarks model: 468-472 right iris, 473-477 left iris)
            if (fl.length > 473) {
              snapshot.rightIris = { x: fl[468].x };
              snapshot.leftIris = { x: fl[473].x };
            }
            snapshot.rightEyeOuter = { x: fl[33].x };
            snapshot.rightEyeInner = { x: fl[133].x };
            snapshot.leftEyeOuter = { x: fl[362].x };
            snapshot.leftEyeInner = { x: fl[263].x };
            snapshot.noseTip = { x: fl[1].x };
            if (fl.length > 454) {
              snapshot.rightEar = { x: fl[234].x };
              snapshot.leftEar = { x: fl[454].x };
            }
          }
        } catch { /* skip frame */ }
      }

      bufferRef.current.push(snapshot);
      animFrameRef.current = requestAnimationFrame(detect);
    };

    animFrameRef.current = requestAnimationFrame(detect);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [enabled, videoRef]);

  // Evaluate heuristics on the current buffer
  const getMetrics = useCallback((): boolean[] => {
    const buf = bufferRef.current;
    if (buf.length === 0) return [false, false, false, false, false, false, false];

    const total = buf.length;
    const threshold = 0.6; // 60% of window

    // 1. Slouch: Y-distance shoulder-to-hip < 85% of calibration baseline for > 60%
    let slouchCount = 0;
    if (calibrationRef.current) {
      for (const f of buf) {
        const leftDist = Math.abs(f.leftShoulder.y - f.leftHip.y);
        const rightDist = Math.abs(f.rightShoulder.y - f.rightHip.y);
        const avgDist = (leftDist + rightDist) / 2;
        if (avgDist < calibrationRef.current * 0.85) {
          slouchCount++;
        }
      }
    }
    const slouch = slouchCount / total > threshold;

    // 2. Eye Contact: iris-to-eye-corner X-ratio exits 0.4-0.6 band for > 60%
    let gazeFailCount = 0;
    for (const f of buf) {
      if (f.leftIris && f.leftEyeOuter && f.leftEyeInner) {
        const eyeWidth = Math.abs(f.leftEyeInner.x - f.leftEyeOuter.x);
        if (eyeWidth > 0.001) {
          const ratio = Math.abs(f.leftIris.x - f.leftEyeOuter.x) / eyeWidth;
          if (ratio < 0.4 || ratio > 0.6) gazeFailCount++;
        }
      }
    }
    const gaze = gazeFailCount / total > threshold;

    // 3. Asymmetrical Tilt: Y-axis variance between shoulders > 10deg for > 60%
    let tiltCount = 0;
    for (const f of buf) {
      const yDiff = Math.abs(f.leftShoulder.y - f.rightShoulder.y);
      const xDiff = Math.abs(f.leftShoulder.x - f.rightShoulder.x);
      if (xDiff > 0.001) {
        const angleDeg = Math.atan2(yDiff, xDiff) * (180 / Math.PI);
        if (angleDeg > 10) tiltCount++;
      }
    }
    const tilt = tiltCount / total > threshold;

    // 4. Defensive Shielding: wrists cross torso center-line near opposite elbows > 60%
    let shieldCount = 0;
    for (const f of buf) {
      const torsoCenter = (f.leftShoulder.x + f.rightShoulder.x) / 2;
      const leftCrossed = f.leftWrist.x > torsoCenter; // left wrist past center to right side
      const rightCrossed = f.rightWrist.x < torsoCenter;
      if (leftCrossed && rightCrossed) shieldCount++;
    }
    const shielding = shieldCount / total > threshold;

    // 5. Self-Soothing: wrist-to-face distance approaches zero > 60%
    let soothingCount = 0;
    for (const f of buf) {
      const lDist = Math.sqrt(
        Math.pow(f.leftWrist.x - f.nose.x, 2) + Math.pow(f.leftWrist.y - f.nose.y, 2)
      );
      const rDist = Math.sqrt(
        Math.pow(f.rightWrist.x - f.nose.x, 2) + Math.pow(f.rightWrist.y - f.nose.y, 2)
      );
      if (lDist < 0.15 || rDist < 0.15) soothingCount++;
    }
    const soothing = soothingCount / total > threshold;

    // 6. Yaw Instability: nose-to-ear X-variance, >= 4 rapid directional shifts
    let yawShifts = 0;
    let lastDirection: 'left' | 'right' | null = null;
    for (const f of buf) {
      if (f.noseTip && f.leftEar && f.rightEar) {
        const earCenter = (f.leftEar.x + f.rightEar.x) / 2;
        const dir: 'left' | 'right' = f.noseTip.x < earCenter ? 'left' : 'right';
        if (lastDirection && dir !== lastDirection) yawShifts++;
        lastDirection = dir;
      }
    }
    const yaw = yawShifts >= 4;

    // 7. Swaying: X-axis hip center oscillation, shifts > 5% of frame width
    let swayCount = 0;
    let prevHipX: number | null = null;
    let swayDirection: 'left' | 'right' | null = null;
    for (const f of buf) {
      const hipCenterX = (f.leftHip.x + f.rightHip.x) / 2;
      if (prevHipX !== null) {
        const diff = hipCenterX - prevHipX;
        if (Math.abs(diff) > 0.05) {
          const dir: 'left' | 'right' = diff > 0 ? 'right' : 'left';
          if (swayDirection && dir !== swayDirection) swayCount++;
          swayDirection = dir;
        }
      }
      prevHipX = hipCenterX;
    }
    const swaying = swayCount > 2;

    // Return in order: Gaze, Posture(Slouch), Shielding, Yaw, Soothing, Swaying, Tilt
    return [gaze, slouch, shielding, yaw, soothing, swaying, tilt];
  }, []);

  const resetBuffer = useCallback(() => {
    bufferRef.current = [];
  }, []);

  return { getMetrics, resetBuffer, calibrationBaseline };
}
