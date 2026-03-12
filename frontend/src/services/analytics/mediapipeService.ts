import type { DebugLogger, LocalMediaPipeAnalyzer, MediaPipeFrameSignals } from "./types";

const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";
const VISION_WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";

const FACE_INDEX = {
  leftEyeOuter: 33,
  rightEyeOuter: 263,
  noseTip: 1,
  chin: 152,
} as const;

const POSE_INDEX = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftHip: 23,
  rightHip: 24,
} as const;

interface Landmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

interface MediaPipeLandmarkerResults {
  faceLandmarks?: Landmark[][];
  landmarks?: Landmark[][];
}

interface MediaPipeDependencies {
  FilesetResolver: {
    forVisionTasks(wasmRoot: string): Promise<unknown>;
  };
  FaceLandmarker: {
    createFromOptions(vision: unknown, options: Record<string, unknown>): Promise<{
      detectForVideo(video: HTMLVideoElement, timestampMs: number): MediaPipeLandmarkerResults;
      close?(): void;
    }>;
  };
  PoseLandmarker: {
    createFromOptions(vision: unknown, options: Record<string, unknown>): Promise<{
      detectForVideo(video: HTMLVideoElement, timestampMs: number): MediaPipeLandmarkerResults;
      close?(): void;
    }>;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function angleDeg(y: number, x: number): number {
  return (Math.atan2(y, x) * 180) / Math.PI;
}

function dist(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function avg(a: Landmark, b: Landmark): Landmark {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: ((a.z ?? 0) + (b.z ?? 0)) / 2,
  };
}

function extractFaceSignals(face: Landmark[] | undefined): Partial<MediaPipeFrameSignals> {
  if (!face || face.length <= FACE_INDEX.chin) {
    return {
      faceTracked: false,
      eyeContactProxy: null,
      yawNormalized: null,
      headRollDeg: null,
      headPitchDeg: null,
    };
  }

  const leftEye = face[FACE_INDEX.leftEyeOuter];
  const rightEye = face[FACE_INDEX.rightEyeOuter];
  const nose = face[FACE_INDEX.noseTip];
  const chin = face[FACE_INDEX.chin];

  const eyeMid = avg(leftEye, rightEye);
  const eyeDistance = Math.max(dist(leftEye, rightEye), 1e-6);

  const yawNorm = (nose.x - eyeMid.x) / eyeDistance;
  const eyeContactProxy = clamp(1 - Math.min(1, Math.abs(yawNorm) * 1.75), 0, 1);

  const rollDeg = angleDeg(rightEye.y - leftEye.y, rightEye.x - leftEye.x);

  const chinDist = Math.max(Math.abs(chin.y - eyeMid.y), 1e-6);
  const pitchNorm = (nose.y - eyeMid.y) / chinDist;
  const pitchDeg = (pitchNorm - 0.45) * 70;

  return {
    faceTracked: true,
    eyeContactProxy,
    yawNormalized: yawNorm,
    headRollDeg: rollDeg,
    headPitchDeg: pitchDeg,
  };
}

function extractPoseSignals(pose: Landmark[] | undefined): Partial<MediaPipeFrameSignals> {
  if (!pose || pose.length <= POSE_INDEX.rightHip) {
    return {
      poseTracked: false,
      shoulderTiltDeg: null,
      slouchProxy: null,
    };
  }

  const leftShoulder = pose[POSE_INDEX.leftShoulder];
  const rightShoulder = pose[POSE_INDEX.rightShoulder];
  const leftHip = pose[POSE_INDEX.leftHip];
  const rightHip = pose[POSE_INDEX.rightHip];

  const shoulderMid = avg(leftShoulder, rightShoulder);
  const hipMid = avg(leftHip, rightHip);

  const shoulderDx = rightShoulder.x - leftShoulder.x;
  const shoulderDy = rightShoulder.y - leftShoulder.y;
  const shoulderTiltDeg = angleDeg(shoulderDy, shoulderDx);

  const torsoDx = shoulderMid.x - hipMid.x;
  const torsoDy = hipMid.y - shoulderMid.y;
  const torsoLeanDeg = angleDeg(torsoDx, Math.max(torsoDy, 1e-6));

  const torsoLength = Math.hypot(shoulderMid.x - hipMid.x, shoulderMid.y - hipMid.y);
  const shoulderWidth = Math.max(Math.hypot(shoulderDx, shoulderDy), 1e-6);
  const compression = clamp((0.72 - torsoLength / shoulderWidth) / 0.72, 0, 1);

  const slouchProxy = clamp((Math.abs(torsoLeanDeg) / 25) * 0.6 + compression * 0.4, 0, 1);

  return {
    poseTracked: true,
    shoulderTiltDeg,
    slouchProxy,
  };
}

export function createMediaPipeAnalyzer(
  onSignals: (signals: MediaPipeFrameSignals) => void,
  log: DebugLogger,
  analysisIntervalMs = 90
): LocalMediaPipeAnalyzer {
  let running = false;
  let rafId: number | null = null;
  let lastAnalysisTs = 0;

  let depsPromise: Promise<MediaPipeDependencies> | null = null;

  let faceLandmarker: {
    detectForVideo(video: HTMLVideoElement, timestampMs: number): MediaPipeLandmarkerResults;
    close?(): void;
  } | null = null;

  let poseLandmarker: {
    detectForVideo(video: HTMLVideoElement, timestampMs: number): MediaPipeLandmarkerResults;
    close?(): void;
  } | null = null;

  const ensureDeps = async (): Promise<MediaPipeDependencies> => {
    if (!depsPromise) {
      depsPromise = import("@mediapipe/tasks-vision") as Promise<MediaPipeDependencies>;
    }
    return depsPromise;
  };

  const ensureLandmarkers = async (): Promise<void> => {
    if (faceLandmarker && poseLandmarker) {
      return;
    }

    const deps = await ensureDeps();
    const vision = await deps.FilesetResolver.forVisionTasks(VISION_WASM_ROOT);

    faceLandmarker = await deps.FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODEL_URL },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });

    poseLandmarker = await deps.PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: POSE_MODEL_URL },
      runningMode: "VIDEO",
      numPoses: 1,
    });
  };

  const loop = (videoEl: HTMLVideoElement) => {
    if (!running) {
      return;
    }

    rafId = window.requestAnimationFrame(() => loop(videoEl));

    const now = performance.now();
    if (now - lastAnalysisTs < analysisIntervalMs) {
      return;
    }
    lastAnalysisTs = now;

    if (!faceLandmarker || !poseLandmarker) {
      return;
    }

    if (videoEl.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return;
    }

    try {
      const faceResult = faceLandmarker.detectForVideo(videoEl, now);
      const poseResult = poseLandmarker.detectForVideo(videoEl, now);

      const faceSignals = extractFaceSignals(faceResult.faceLandmarks?.[0]);
      const poseSignals = extractPoseSignals(poseResult.landmarks?.[0]);

      onSignals({
        tsMs: now,
        eyeContactProxy: faceSignals.eyeContactProxy ?? null,
        yawNormalized: faceSignals.yawNormalized ?? null,
        headRollDeg: faceSignals.headRollDeg ?? null,
        headPitchDeg: faceSignals.headPitchDeg ?? null,
        shoulderTiltDeg: poseSignals.shoulderTiltDeg ?? null,
        slouchProxy: poseSignals.slouchProxy ?? null,
        faceTracked: faceSignals.faceTracked ?? false,
        poseTracked: poseSignals.poseTracked ?? false,
      });
    } catch (error) {
      log("warn", "MediaPipe frame analysis failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return {
    async start(videoEl: HTMLVideoElement): Promise<void> {
      if (running) {
        return;
      }

      log("info", "Initializing MediaPipe Face/Pose landmarkers for local analysis");
      await ensureLandmarkers();

      running = true;
      lastAnalysisTs = 0;
      loop(videoEl);
      log("info", "MediaPipe analysis started");
    },

    stop(): void {
      running = false;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    },

    isRunning(): boolean {
      return running;
    },
  };
}
