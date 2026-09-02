/**
 * RWANG local perception controller.
 *
 * Runtime privacy contract:
 * - No CDN or cross-origin assets are loaded. MediaPipe and its models must be
 *   served by this application.
 * - Camera frames and microphone samples are never uploaded or persisted.
 * - Biometric templates are coarse, experimental descriptors stored only in
 *   this origin's localStorage. They are not suitable as a sole authorization
 *   factor.
 *
 * Required files copied from the official @mediapipe/tasks-vision package and
 * official MediaPipe model bundles:
 *   /vendor/tasks-vision.mjs
 *   /vendor/wasm/vision_wasm_internal.js
 *   /vendor/wasm/vision_wasm_internal.wasm
 *   /vendor/wasm/vision_wasm_module_internal.js
 *   /vendor/wasm/vision_wasm_module_internal.wasm
 *   /vendor/wasm/vision_wasm_nosimd_internal.js
 *   /vendor/wasm/vision_wasm_nosimd_internal.wasm
 *   /vendor/gesture_recognizer.task
 *   /vendor/face_landmarker.task
 *
 * Optional manual-landmark fallback:
 *   /vendor/hand_landmarker.task
 */

export const PERCEPTION_ASSETS = Object.freeze({
  visionModule: "/vendor/tasks-vision.mjs",
  wasmRoot: "/vendor/wasm",
  gestureModel: "/vendor/gesture_recognizer.task",
  handModel: "/vendor/hand_landmarker.task",
  faceModel: "/vendor/face_landmarker.task",
  wasmFiles: Object.freeze([
    "vision_wasm_internal.js",
    "vision_wasm_internal.wasm",
    "vision_wasm_module_internal.js",
    "vision_wasm_module_internal.wasm",
    "vision_wasm_nosimd_internal.js",
    "vision_wasm_nosimd_internal.wasm",
  ]),
});

export const PERCEPTION_API_ASSUMPTIONS = Object.freeze({
  secureContext:
    "Camera and microphone access require HTTPS or a browser-trusted localhost origin.",
  mediaPipe:
    "The local module exports FilesetResolver, GestureRecognizer, FaceLandmarker, and optionally HandLandmarker from @mediapipe/tasks-vision.",
  inference:
    "GestureRecognizer/HandLandmarker and FaceLandmarker run in VIDEO mode with monotonically increasing timestamps.",
  privacy:
    "All inference is on-device; only coarse templates are stored in localStorage and no raw media is retained.",
  biometricSafety:
    "Face and voice matches are heuristic and experimental. Never use either as a sole authorization factor.",
});

const FACE_STORAGE_KEY = "rwang.perception.face-profiles.v1";
const VOICE_STORAGE_KEY = "rwang.perception.voice-profiles.v1";
const TEMPLATE_VERSION = 1;

const HAND_CONNECTIONS = Object.freeze([
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
]);

// Stable mesh points covering the eyes, nose, mouth, jaw, forehead and cheeks.
// FaceLandmarker is not a face-recognition model; these points only form a
// lightweight, pose-sensitive descriptor for an experimental local hint.
const FACE_DESCRIPTOR_INDICES = Object.freeze([
  10, 33, 133, 263, 362, 1, 4, 61, 291, 78, 308, 13, 14, 152, 172, 397,
  234, 454, 127, 356, 93, 323,
]);

const FACE_OVERLAY_INDICES = Object.freeze([
  10, 67, 109, 151, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361,
  288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172,
  58, 132, 93, 234, 127, 162, 21, 54, 103,
]);

const DEFAULTS = Object.freeze({
  inferenceFps: 10,
  maxHands: 2,
  gestureStableFrames: 3,
  gestureCooldownMs: 900,
  faceMatchThreshold: 0.78,
  voiceMatchThreshold: 0.76,
  stopOnHidden: true,
  mirror: true,
});

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function distance3(a, b) {
  const dx = (a?.x ?? 0) - (b?.x ?? 0);
  const dy = (a?.y ?? 0) - (b?.y ?? 0);
  const dz = (a?.z ?? 0) - (b?.z ?? 0);
  return Math.hypot(dx, dy, dz);
}

function angleDegrees(a, b, c) {
  if (!a || !b || !c) return 0;
  const ab = { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
  const cb = { x: c.x - b.x, y: c.y - b.y, z: (c.z ?? 0) - (b.z ?? 0) };
  const dot = ab.x * cb.x + ab.y * cb.y + ab.z * cb.z;
  const magnitude = Math.hypot(ab.x, ab.y, ab.z) * Math.hypot(cb.x, cb.y, cb.z);
  if (magnitude < 1e-8) return 0;
  return Math.acos(clamp(dot / magnitude, -1, 1)) * (180 / Math.PI);
}

function averageVectors(vectors) {
  if (!vectors.length) return [];
  const length = vectors[0].length;
  const mean = new Array(length).fill(0);
  let accepted = 0;
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== length) continue;
    accepted += 1;
    for (let index = 0; index < length; index += 1) mean[index] += vector[index];
  }
  if (!accepted) return [];
  return mean.map((value) => value / accepted);
}

function vectorVariance(vectors, mean) {
  if (!vectors.length || !mean.length) return [];
  const variance = new Array(mean.length).fill(0);
  let accepted = 0;
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== mean.length) continue;
    accepted += 1;
    for (let index = 0; index < mean.length; index += 1) {
      const delta = vector[index] - mean[index];
      variance[index] += delta * delta;
    }
  }
  return variance.map((value) => value / Math.max(1, accepted));
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    magnitudeA += a[index] * a[index];
    magnitudeB += b[index] * b[index];
  }
  if (magnitudeA < 1e-10 || magnitudeB < 1e-10) return 0;
  return clamp((dot / Math.sqrt(magnitudeA * magnitudeB) + 1) / 2);
}

function rmsDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return Infinity;
  let squared = 0;
  for (let index = 0; index < a.length; index += 1) {
    const delta = a[index] - b[index];
    squared += delta * delta;
  }
  return Math.sqrt(squared / a.length);
}

function cleanLabel(value) {
  const label = String(value ?? "owner").trim().slice(0, 64);
  if (!label) throw new Error("A non-empty profile label is required.");
  return label;
}

function safeJsonParse(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function classifyGesture(landmarks, handednessScore = 1) {
  if (!Array.isArray(landmarks) || landmarks.length < 21) {
    return { name: "none", confidence: 0 };
  }

  const wrist = landmarks[0];
  const fingerScore = (mcp, pip, dip, tip) => {
    const straightness = clamp((angleDegrees(landmarks[mcp], landmarks[pip], landmarks[tip]) - 105) / 70);
    const tipStraightness = clamp((angleDegrees(landmarks[pip], landmarks[dip], landmarks[tip]) - 100) / 75);
    const reachRatio = distance3(landmarks[tip], wrist) / Math.max(1e-5, distance3(landmarks[pip], wrist));
    const reach = clamp((reachRatio - 0.98) / 0.35);
    return clamp(straightness * 0.45 + tipStraightness * 0.3 + reach * 0.25);
  };

  const index = fingerScore(5, 6, 7, 8);
  const middle = fingerScore(9, 10, 11, 12);
  const ring = fingerScore(13, 14, 15, 16);
  const pinky = fingerScore(17, 18, 19, 20);
  const palmCenter = {
    x: (landmarks[0].x + landmarks[5].x + landmarks[9].x + landmarks[17].x) / 4,
    y: (landmarks[0].y + landmarks[5].y + landmarks[9].y + landmarks[17].y) / 4,
    z: ((landmarks[0].z ?? 0) + (landmarks[5].z ?? 0) + (landmarks[9].z ?? 0) + (landmarks[17].z ?? 0)) / 4,
  };
  const thumbStraightness = clamp((angleDegrees(landmarks[2], landmarks[3], landmarks[4]) - 95) / 80);
  const thumbReachRatio = distance3(landmarks[4], palmCenter) / Math.max(1e-5, distance3(landmarks[3], palmCenter));
  const thumb = clamp(thumbStraightness * 0.6 + clamp((thumbReachRatio - 1) / 0.45) * 0.4);
  const folded = [index, middle, ring, pinky].map((score) => 1 - score);
  const otherFingersFolded = (folded[0] + folded[1] + folded[2] + folded[3]) / 4;
  const thumbVector = {
    x: landmarks[4].x - landmarks[2].x,
    y: landmarks[4].y - landmarks[2].y,
  };
  const verticality = Math.abs(thumbVector.y) / Math.max(1e-5, Math.hypot(thumbVector.x, thumbVector.y));
  const detectorWeight = clamp(Number(handednessScore) || 0.5, 0.5, 1);
  const withDetector = (score) => clamp(score * (0.75 + detectorWeight * 0.25));

  if (otherFingersFolded > 0.66 && thumb > 0.57 && verticality > 0.62) {
    const directionScore = clamp((verticality - 0.55) / 0.45);
    return {
      name: thumbVector.y < 0 ? "thumbs_up" : "thumbs_down",
      confidence: withDetector((otherFingersFolded + thumb + directionScore) / 3),
    };
  }

  const victoryScore = (index + middle + (1 - ring) + (1 - pinky)) / 4;
  if (index > 0.6 && middle > 0.6 && ring < 0.46 && pinky < 0.46) {
    return { name: "victory", confidence: withDetector(victoryScore) };
  }

  const pointingScore = (index + (1 - middle) + (1 - ring) + (1 - pinky)) / 4;
  if (index > 0.62 && middle < 0.48 && ring < 0.48 && pinky < 0.48) {
    return { name: "pointing", confidence: withDetector(pointingScore) };
  }

  const openScore = (index + middle + ring + pinky + Math.max(thumb, 0.55)) / 5;
  if (index > 0.56 && middle > 0.56 && ring > 0.54 && pinky > 0.5 && openScore > 0.58) {
    return { name: "open_palm", confidence: withDetector(openScore) };
  }

  const fistScore = otherFingersFolded * 0.85 + (1 - thumb) * 0.15;
  if (index < 0.48 && middle < 0.48 && ring < 0.48 && pinky < 0.48) {
    return { name: "closed_fist", confidence: withDetector(fistScore) };
  }

  return { name: "unknown", confidence: withDetector(0.35) };
}

function normalizeMediaPipeGesture(category, landmarks, handednessScore) {
  const aliases = {
    Closed_Fist: "closed_fist",
    Open_Palm: "open_palm",
    Pointing_Up: "pointing",
    Thumb_Down: "thumbs_down",
    Thumb_Up: "thumbs_up",
    Victory: "victory",
  };
  const officialName = aliases[category?.categoryName];
  if (officialName) {
    return {
      name: officialName,
      confidence: clamp(Number(category?.score) || 0),
      source: "mediapipe-gesture-recognizer",
    };
  }
  const fallback = classifyGesture(landmarks, handednessScore);
  return { ...fallback, source: "landmark-heuristic" };
}

function createFaceDescriptor(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 455) return null;
  const leftEye = landmarks[33];
  const rightEye = landmarks[263];
  const nose = landmarks[1];
  if (!leftEye || !rightEye || !nose) return null;
  const eyeDistance = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);
  if (eyeDistance < 0.025) return null;
  const eyeAngle = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);
  const cosine = Math.cos(-eyeAngle);
  const sine = Math.sin(-eyeAngle);
  const descriptor = [];
  for (const index of FACE_DESCRIPTOR_INDICES) {
    const point = landmarks[index];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    const dx = (point.x - nose.x) / eyeDistance;
    const dy = (point.y - nose.y) / eyeDistance;
    descriptor.push(clamp(dx * cosine - dy * sine, -4, 4));
    descriptor.push(clamp(dx * sine + dy * cosine, -4, 4));
    descriptor.push(clamp(((point.z ?? 0) - (nose.z ?? 0)) / eyeDistance, -4, 4));
  }
  return descriptor;
}

function faceFrameQuality(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 20) return 0;
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  let valid = 0;
  for (const point of landmarks) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    valid += 1;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const coverage = clamp((Math.max(maxX - minX, maxY - minY) - 0.08) / 0.32);
  return clamp((valid / landmarks.length) * 0.5 + coverage * 0.5);
}

function compareFaceDescriptor(sample, template) {
  const mean = template?.mean;
  if (!Array.isArray(mean) || sample.length !== mean.length) return 0;
  const distance = rmsDistance(sample, mean);
  const shapeScore = Math.exp(-distance * 4.5);
  const directionScore = cosineSimilarity(sample, mean);
  return clamp(shapeScore * 0.72 + directionScore * 0.28);
}

function extractVoiceFrame(analyser, timeData, frequencyData, sampleRate) {
  analyser.getFloatTimeDomainData(timeData);
  analyser.getFloatFrequencyData(frequencyData);

  let energy = 0;
  let zeroCrossings = 0;
  for (let index = 0; index < timeData.length; index += 1) {
    const sample = timeData[index];
    energy += sample * sample;
    if (index > 0 && (sample >= 0) !== (timeData[index - 1] >= 0)) zeroCrossings += 1;
  }
  const rms = Math.sqrt(energy / timeData.length);
  if (rms < 0.007) return null;

  const nyquist = sampleRate / 2;
  const binHz = nyquist / frequencyData.length;
  const minimumHz = 80;
  const maximumHz = Math.min(8000, nyquist);
  const bandCount = 14;
  const bandPowers = new Array(bandCount).fill(0);
  let totalPower = 0;
  let weightedFrequency = 0;
  const powers = new Float64Array(frequencyData.length);

  for (let index = 1; index < frequencyData.length; index += 1) {
    const hz = index * binHz;
    if (hz < minimumHz || hz > maximumHz) continue;
    const db = Number.isFinite(frequencyData[index]) ? frequencyData[index] : -120;
    const power = 10 ** (db / 10);
    powers[index] = power;
    totalPower += power;
    weightedFrequency += hz * power;
    const position = Math.log(hz / minimumHz) / Math.log(maximumHz / minimumHz);
    const band = Math.min(bandCount - 1, Math.floor(clamp(position, 0, 0.999999) * bandCount));
    bandPowers[band] += power;
  }

  if (totalPower < 1e-12) return null;
  let cumulative = 0;
  let rolloffHz = maximumHz;
  for (let index = 1; index < powers.length; index += 1) {
    cumulative += powers[index];
    if (cumulative >= totalPower * 0.85) {
      rolloffHz = index * binHz;
      break;
    }
  }

  const normalizedBands = bandPowers.map((power) => Math.log1p((power / totalPower) * 100) / Math.log(101));
  const logRms = clamp((Math.log10(rms + 1e-6) + 3) / 3);
  const zeroCrossingRate = zeroCrossings / Math.max(1, timeData.length - 1);
  const centroid = weightedFrequency / totalPower / maximumHz;
  const rolloff = rolloffHz / maximumHz;
  return [logRms, zeroCrossingRate, clamp(centroid), clamp(rolloff), ...normalizedBands];
}

function compareVoiceDescriptor(sample, template) {
  const mean = template?.mean;
  if (!Array.isArray(mean) || sample.length !== mean.length) return 0;
  // Amplitude varies considerably by microphone, so the first component is
  // down-weighted. The remainder represents coarse spectral shape and timing.
  let weightedSquared = 0;
  let totalWeight = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const weight = index === 0 ? 0.2 : index < 4 ? 0.65 : 1;
    const delta = sample[index] - mean[index];
    weightedSquared += delta * delta * weight;
    totalWeight += weight;
  }
  const distance = Math.sqrt(weightedSquared / Math.max(1e-8, totalWeight));
  const distanceScore = Math.exp(-distance * 8);
  const directionScore = cosineSimilarity(sample.slice(1), mean.slice(1));
  return clamp(distanceScore * 0.76 + directionScore * 0.24);
}

export function createPerceptionController(options = {}) {
  const root = typeof window !== "undefined" ? window : globalThis;
  const documentRef = options.document ?? root.document;
  const navigatorRef = options.navigator ?? root.navigator;
  const locationRef = options.location ?? root.location;
  const video = options.videoElement ?? documentRef?.createElement?.("video") ?? null;
  const canvas = options.canvasElement ?? null;
  const context = canvas?.getContext?.("2d") ?? null;
  const callbacks = {
    state: typeof options.onState === "function" ? options.onState : null,
    gesture: typeof options.onGesture === "function" ? options.onGesture : null,
    face: typeof options.onFace === "function" ? options.onFace : null,
    voiceprint: typeof options.onVoiceprint === "function" ? options.onVoiceprint : null,
    error: typeof options.onError === "function" ? options.onError : null,
  };
  const settings = {
    inferenceFps: clamp(Number(options.inferenceFps) || DEFAULTS.inferenceFps, 1, 30),
    maxHands: clamp(Math.round(Number(options.maxHands) || DEFAULTS.maxHands), 1, 4),
    gestureStableFrames: clamp(Math.round(Number(options.gestureStableFrames) || DEFAULTS.gestureStableFrames), 1, 12),
    gestureCooldownMs: clamp(Number(options.gestureCooldownMs) || DEFAULTS.gestureCooldownMs, 100, 10000),
    faceMatchThreshold: clamp(Number(options.faceMatchThreshold) || DEFAULTS.faceMatchThreshold, 0.5, 0.99),
    voiceMatchThreshold: clamp(Number(options.voiceMatchThreshold) || DEFAULTS.voiceMatchThreshold, 0.5, 0.99),
    stopOnHidden: options.stopOnHidden ?? DEFAULTS.stopOnHidden,
    mirror: options.mirror ?? DEFAULTS.mirror,
  };
  const assetPaths = { ...PERCEPTION_ASSETS, ...(options.assets ?? {}) };

  if (video) {
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
  }

  let destroyed = false;
  let cameraStream = null;
  let cameraStartPromise = null;
  let lifecycle = 0;
  let animationFrame = 0;
  let lastInferenceAt = 0;
  let lastVideoTime = -1;
  let gestureRecognizer = null;
  let handLandmarker = null;
  let faceLandmarker = null;
  let visionModule = null;
  let currentFaceDescriptor = null;
  let faceCollector = null;
  let voiceSession = null;
  let lastGestureCandidate = "none";
  let gestureCandidateFrames = 0;
  let lastGestureEmitted = "none";
  let lastGestureAt = 0;
  let consecutiveHandErrors = 0;
  let consecutiveFaceErrors = 0;

  const state = {
    supported: Boolean(navigatorRef?.mediaDevices?.getUserMedia),
    secureContext: Boolean(root.isSecureContext),
    camera: "idle",
    microphone: "idle",
    vision: { module: "idle", hand: "idle", face: "idle" },
    gesture: { name: "none", confidence: 0, handedness: null, source: null },
    face: { present: false, count: 0, quality: 0, experimental: true },
    voiceprint: { capturing: false, experimental: true },
    lastError: null,
  };

  function snapshotState() {
    return Object.freeze({
      ...state,
      vision: Object.freeze({ ...state.vision }),
      gesture: Object.freeze({ ...state.gesture }),
      face: Object.freeze({ ...state.face }),
      voiceprint: Object.freeze({ ...state.voiceprint }),
    });
  }

  function emitState() {
    if (!callbacks.state) return;
    try {
      callbacks.state(snapshotState());
    } catch {
      // Consumer callbacks must never interrupt media cleanup or inference.
    }
  }

  function patchState(patch) {
    Object.assign(state, patch);
    emitState();
  }

  function reportError(code, error, recoverable = true) {
    const detail = {
      code,
      message: error instanceof Error ? error.message : String(error),
      recoverable,
      at: new Date().toISOString(),
    };
    state.lastError = detail;
    emitState();
    if (callbacks.error) {
      try {
        callbacks.error(Object.freeze({ ...detail }));
      } catch {
        // Ignore callback errors.
      }
    }
  }

  function requireActiveController() {
    if (destroyed) throw new Error("Perception controller has been destroyed.");
  }

  function sameOriginUrl(path, directory = false) {
    if (!locationRef?.href || !locationRef?.origin) {
      throw new Error("A browser location is required for local perception assets.");
    }
    const url = new URL(String(path), locationRef.href);
    if (url.origin !== locationRef.origin) {
      throw new Error(`Cross-origin perception asset blocked: ${url.origin}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`Unsupported perception asset protocol: ${url.protocol}`);
    }
    if (directory && !url.pathname.endsWith("/")) url.pathname += "/";
    return url.href;
  }

  async function localAssetAvailable(path) {
    const url = sameOriginUrl(path);
    if (typeof root.fetch !== "function") return true;
    try {
      const response = await root.fetch(url, {
        method: "HEAD",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
      });
      return response.ok || response.status === 405;
    } catch {
      return false;
    }
  }

  async function closeTask(task) {
    if (!task || typeof task.close !== "function") return;
    try {
      await task.close();
    } catch {
      // Best-effort disposal; tracks are stopped independently.
    }
  }

  async function disposeVision() {
    const gesture = gestureRecognizer;
    const hand = handLandmarker;
    const face = faceLandmarker;
    gestureRecognizer = null;
    handLandmarker = null;
    faceLandmarker = null;
    visionModule = null;
    await Promise.all([closeTask(gesture), closeTask(hand), closeTask(face)]);
    state.vision = { module: "idle", hand: "idle", face: "idle" };
  }

  async function initializeVision(token) {
    state.vision = { module: "loading", hand: "checking", face: "checking" };
    emitState();
    let moduleUrl;
    try {
      moduleUrl = sameOriginUrl(assetPaths.visionModule);
      sameOriginUrl(assetPaths.wasmRoot, true);
      sameOriginUrl(assetPaths.gestureModel);
      sameOriginUrl(assetPaths.handModel);
      sameOriginUrl(assetPaths.faceModel);
    } catch (error) {
      state.vision = { module: "unavailable", hand: "unavailable", face: "unavailable" };
      reportError("vision-assets-not-local", error, true);
      return;
    }

    if (!(await localAssetAvailable(assetPaths.visionModule))) {
      state.vision = { module: "missing", hand: "missing", face: "missing" };
      emitState();
      return;
    }

    try {
      const imported = await import(moduleUrl);
      if (token !== lifecycle || !cameraStream) return;
      visionModule = imported?.default && !imported.FilesetResolver ? imported.default : imported;
      const { FilesetResolver, GestureRecognizer, HandLandmarker, FaceLandmarker } = visionModule;
      if (!FilesetResolver || !FaceLandmarker || (!GestureRecognizer && !HandLandmarker)) {
        throw new Error("Local tasks-vision module does not expose the expected MediaPipe classes.");
      }
      const fileset = await FilesetResolver.forVisionTasks(sameOriginUrl(assetPaths.wasmRoot, true));
      if (token !== lifecycle || !cameraStream) return;
      state.vision.module = "ready";

      if (GestureRecognizer && await localAssetAvailable(assetPaths.gestureModel)) {
        try {
          gestureRecognizer = await GestureRecognizer.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: sameOriginUrl(assetPaths.gestureModel) },
            runningMode: "VIDEO",
            numHands: settings.maxHands,
            minHandDetectionConfidence: 0.55,
            minHandPresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
            cannedGesturesClassifierOptions: {
              maxResults: 1,
              scoreThreshold: 0.45,
              categoryAllowlist: [
                "Closed_Fist",
                "Open_Palm",
                "Pointing_Up",
                "Thumb_Down",
                "Thumb_Up",
                "Victory",
              ],
            },
          });
          state.vision.hand = "ready";
          state.vision.gestureEngine = "GestureRecognizer";
        } catch (error) {
          reportError("gesture-model-initialization-failed", error, true);
        }
      }

      // GestureRecognizer already returns its hand landmarks. HandLandmarker is
      // only needed when the official gesture bundle is absent or cannot load.
      if (!gestureRecognizer && HandLandmarker && await localAssetAvailable(assetPaths.handModel)) {
        try {
          handLandmarker = await HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: sameOriginUrl(assetPaths.handModel) },
            runningMode: "VIDEO",
            numHands: settings.maxHands,
            minHandDetectionConfidence: 0.55,
            minHandPresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });
          state.vision.hand = "ready";
          state.vision.gestureEngine = "HandLandmarker heuristic fallback";
        } catch (error) {
          reportError("hand-model-initialization-failed", error, true);
        }
      }
      if (!gestureRecognizer && !handLandmarker) {
        state.vision.hand = "missing";
      }

      if (token !== lifecycle || !cameraStream) {
        await disposeVision();
        return;
      }

      if (await localAssetAvailable(assetPaths.faceModel)) {
        try {
          faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: sameOriginUrl(assetPaths.faceModel) },
            runningMode: "VIDEO",
            numFaces: 1,
            minFaceDetectionConfidence: 0.55,
            minFacePresenceConfidence: 0.55,
            minTrackingConfidence: 0.5,
            outputFaceBlendshapes: false,
            outputFacialTransformationMatrixes: false,
          });
          state.vision.face = "ready";
        } catch (error) {
          state.vision.face = "unavailable";
          reportError("face-model-initialization-failed", error, true);
        }
      } else {
        state.vision.face = "missing";
      }
      if (token !== lifecycle || !cameraStream) {
        await disposeVision();
        return;
      }
      emitState();
    } catch (error) {
      state.vision = { module: "unavailable", hand: "unavailable", face: "unavailable" };
      reportError("vision-initialization-failed", error, true);
    }
  }

  function prepareOverlay() {
    if (!canvas || !context || !video?.videoWidth || !video?.videoHeight) return;
    const cssWidth = canvas.clientWidth || video.clientWidth || video.videoWidth;
    const cssHeight = canvas.clientHeight || video.clientHeight || video.videoHeight;
    const dpr = clamp(Number(root.devicePixelRatio) || 1, 1, 3);
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);
  }

  function canvasPoint(point) {
    const width = canvas?.clientWidth || video?.clientWidth || video?.videoWidth || 1;
    const height = canvas?.clientHeight || video?.clientHeight || video?.videoHeight || 1;
    const normalizedX = settings.mirror ? 1 - point.x : point.x;
    return { x: normalizedX * width, y: point.y * height };
  }

  function drawHands(handSets, gestures) {
    if (!context || !canvas) return;
    context.save();
    context.lineWidth = 2;
    context.lineCap = "round";
    for (let handIndex = 0; handIndex < handSets.length; handIndex += 1) {
      const landmarks = handSets[handIndex];
      if (!landmarks) continue;
      context.strokeStyle = "rgba(78, 245, 210, 0.9)";
      context.fillStyle = "rgba(132, 255, 229, 0.95)";
      context.beginPath();
      for (const [from, to] of HAND_CONNECTIONS) {
        const a = canvasPoint(landmarks[from]);
        const b = canvasPoint(landmarks[to]);
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
      }
      context.stroke();
      for (const point of landmarks) {
        const drawn = canvasPoint(point);
        context.beginPath();
        context.arc(drawn.x, drawn.y, 2.4, 0, Math.PI * 2);
        context.fill();
      }
      const wrist = canvasPoint(landmarks[0]);
      const label = gestures[handIndex]?.name?.replaceAll("_", " ") ?? "hand";
      context.font = "600 12px system-ui, sans-serif";
      context.fillText(label, wrist.x + 8, wrist.y + 16);
    }
    context.restore();
  }

  function drawFace(faceLandmarks, quality) {
    if (!context || !canvas || !faceLandmarks) return;
    context.save();
    context.strokeStyle = "rgba(98, 187, 255, 0.9)";
    context.fillStyle = "rgba(98, 187, 255, 0.8)";
    context.lineWidth = 1.5;
    context.beginPath();
    for (let index = 0; index < FACE_OVERLAY_INDICES.length; index += 1) {
      const point = faceLandmarks[FACE_OVERLAY_INDICES[index]];
      if (!point) continue;
      const drawn = canvasPoint(point);
      if (index === 0) context.moveTo(drawn.x, drawn.y);
      else context.lineTo(drawn.x, drawn.y);
    }
    context.closePath();
    context.stroke();
    const anchor = canvasPoint(faceLandmarks[10] ?? faceLandmarks[0]);
    context.font = "600 12px system-ui, sans-serif";
    context.fillText(`face · quality ${Math.round(quality * 100)}%`, anchor.x + 8, anchor.y - 8);
    context.restore();
  }

  function publishGesture(gesture, handedness) {
    if (gesture.name === lastGestureCandidate) gestureCandidateFrames += 1;
    else {
      lastGestureCandidate = gesture.name;
      gestureCandidateFrames = 1;
    }
    const now = performance.now();
    const stable = gestureCandidateFrames >= settings.gestureStableFrames;
    const cooledDown = now - lastGestureAt >= settings.gestureCooldownMs;
    if (!stable || gesture.name === "unknown" || gesture.name === "none") return;
    if (gesture.name === lastGestureEmitted && !cooledDown) return;
    lastGestureEmitted = gesture.name;
    lastGestureAt = now;
    state.gesture = {
      name: gesture.name,
      confidence: Number(gesture.confidence.toFixed(3)),
      handedness: handedness || null,
      source: gesture.source ?? "landmark-heuristic",
    };
    emitState();
    if (callbacks.gesture) {
      try {
        callbacks.gesture(Object.freeze({ ...state.gesture, at: Date.now() }));
      } catch {
        // Ignore callback errors.
      }
    }
  }

  function publishFace(faceLandmarks) {
    const present = Boolean(faceLandmarks);
    const quality = present ? faceFrameQuality(faceLandmarks) : 0;
    const descriptor = present && quality >= 0.42 ? createFaceDescriptor(faceLandmarks) : null;
    currentFaceDescriptor = descriptor;
    const previous = state.face;
    state.face = {
      present,
      count: present ? 1 : 0,
      quality: Number(quality.toFixed(3)),
      experimental: true,
    };
    if (previous.present !== present || Math.abs(previous.quality - quality) > 0.08) emitState();
    if (callbacks.face && previous.present !== present) {
      try {
        callbacks.face(Object.freeze({ ...state.face, authorizationFactor: false, at: Date.now() }));
      } catch {
        // Ignore callback errors.
      }
    }
    if (descriptor && faceCollector) {
      const now = performance.now();
      if (now - faceCollector.lastSampleAt >= 90) {
        faceCollector.lastSampleAt = now;
        faceCollector.samples.push(descriptor);
        if (faceCollector.samples.length >= faceCollector.required) {
          const collector = faceCollector;
          faceCollector = null;
          root.clearTimeout(collector.timeout);
          collector.resolve(collector.samples);
        }
      }
    }
    return { quality, descriptor };
  }

  function processFrame(timestamp) {
    if (!cameraStream || destroyed || !video || video.readyState < 2) return;
    prepareOverlay();
    let handSets = [];
    let gestures = [];
    const handTask = gestureRecognizer ?? handLandmarker;
    if (handTask) {
      try {
        const result = gestureRecognizer
          ? gestureRecognizer.recognizeForVideo(video, timestamp)
          : handLandmarker.detectForVideo(video, timestamp);
        handSets = Array.isArray(result?.landmarks) ? result.landmarks : [];
        gestures = handSets.map((landmarks, index) => {
          const handedness = (result?.handedness ?? result?.handednesses)?.[index]?.[0];
          const officialGesture = result?.gestures?.[index]?.[0];
          const gesture = gestureRecognizer
            ? normalizeMediaPipeGesture(officialGesture, landmarks, handedness?.score)
            : { ...classifyGesture(landmarks, handedness?.score), source: "landmark-heuristic" };
          if (index === 0) {
            publishGesture(gesture, handedness?.categoryName ?? handedness?.displayName ?? null);
          }
          return gesture;
        });
        if (!handSets.length) {
          lastGestureCandidate = "none";
          gestureCandidateFrames = 0;
          if (state.gesture.name !== "none") {
            state.gesture = { name: "none", confidence: 0, handedness: null, source: null };
            emitState();
          }
        }
        consecutiveHandErrors = 0;
      } catch (error) {
        consecutiveHandErrors += 1;
        if (consecutiveHandErrors >= 3) {
          const failed = gestureRecognizer ?? handLandmarker;
          gestureRecognizer = null;
          handLandmarker = null;
          state.vision.hand = "failed";
          void closeTask(failed);
          reportError("hand-inference-failed", error, true);
        }
      }
    }

    let faceLandmarks = null;
    let faceQuality = 0;
    if (faceLandmarker) {
      try {
        const result = faceLandmarker.detectForVideo(video, timestamp);
        faceLandmarks = result?.faceLandmarks?.[0] ?? null;
        faceQuality = publishFace(faceLandmarks).quality;
        consecutiveFaceErrors = 0;
      } catch (error) {
        consecutiveFaceErrors += 1;
        if (consecutiveFaceErrors >= 3) {
          const failed = faceLandmarker;
          faceLandmarker = null;
          state.vision.face = "failed";
          void closeTask(failed);
          publishFace(null);
          reportError("face-inference-failed", error, true);
        }
      }
    } else if (state.face.present) {
      publishFace(null);
    }
    drawHands(handSets, gestures);
    drawFace(faceLandmarks, faceQuality);
  }

  function frameLoop(timestamp) {
    if (!cameraStream || destroyed) return;
    const interval = 1000 / settings.inferenceFps;
    if (timestamp - lastInferenceAt >= interval && video.currentTime !== lastVideoTime) {
      lastInferenceAt = timestamp;
      lastVideoTime = video.currentTime;
      processFrame(timestamp);
    }
    animationFrame = root.requestAnimationFrame(frameLoop);
  }

  async function startCamera(constraints = {}) {
    requireActiveController();
    if (cameraStream) return snapshotState();
    if (cameraStartPromise) return cameraStartPromise;
    if (!navigatorRef?.mediaDevices?.getUserMedia) {
      const error = new Error("Camera API is unavailable. Use HTTPS or localhost in a supported browser.");
      reportError("camera-api-unavailable", error, false);
      throw error;
    }

    const token = ++lifecycle;
    state.camera = "requesting";
    emitState();
    cameraStartPromise = (async () => {
      let stream;
      try {
        stream = await navigatorRef.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: 1280 },
            height: { ideal: 720 },
            ...constraints,
          },
          audio: false,
        });
        if (token !== lifecycle || destroyed) {
          for (const track of stream.getTracks()) track.stop();
          throw new Error("Camera start was cancelled.");
        }
        cameraStream = stream;
        video.srcObject = stream;
        await video.play();
        state.camera = "active";
        emitState();
        await initializeVision(token);
        if (token === lifecycle && cameraStream) {
          lastInferenceAt = 0;
          lastVideoTime = -1;
          animationFrame = root.requestAnimationFrame(frameLoop);
        }
        return snapshotState();
      } catch (error) {
        if (stream && stream !== cameraStream) {
          for (const track of stream.getTracks()) track.stop();
        }
        if (token === lifecycle) {
          state.camera = "idle";
          reportError("camera-start-failed", error, true);
        }
        throw error;
      } finally {
        cameraStartPromise = null;
      }
    })();
    return cameraStartPromise;
  }

  async function stopCamera() {
    lifecycle += 1;
    if (animationFrame) root.cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    if (faceCollector) {
      const collector = faceCollector;
      faceCollector = null;
      root.clearTimeout(collector.timeout);
      collector.reject(new Error("Face sampling stopped because the camera was closed."));
    }
    const stream = cameraStream ?? video?.srcObject;
    cameraStream = null;
    if (stream?.getTracks) {
      for (const track of stream.getTracks()) track.stop();
    }
    if (video) {
      try {
        video.pause();
      } catch {
        // Some detached video elements do not implement pause fully.
      }
      video.srcObject = null;
    }
    await disposeVision();
    currentFaceDescriptor = null;
    lastGestureCandidate = "none";
    gestureCandidateFrames = 0;
    state.camera = "idle";
    state.gesture = { name: "none", confidence: 0, handedness: null, source: null };
    state.face = { present: false, count: 0, quality: 0, experimental: true };
    if (context && canvas) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
    emitState();
  }

  function loadProfiles(key) {
    try {
      if (!root.localStorage) throw new Error("localStorage is not available in this context.");
      const parsed = safeJsonParse(root.localStorage.getItem(key), { version: TEMPLATE_VERSION, profiles: {} });
      if (parsed.version !== TEMPLATE_VERSION || !parsed.profiles || typeof parsed.profiles !== "object") {
        return { version: TEMPLATE_VERSION, profiles: {} };
      }
      return parsed;
    } catch (error) {
      reportError("local-storage-unavailable", error, true);
      throw new Error("localStorage is unavailable; biometric templates cannot be saved locally.");
    }
  }

  function saveProfiles(key, profiles) {
    try {
      if (!root.localStorage) throw new Error("localStorage is not available in this context.");
      root.localStorage.setItem(key, JSON.stringify(profiles));
    } catch (error) {
      reportError("local-storage-write-failed", error, true);
      throw new Error("Unable to save the local biometric template.");
    }
  }

  function collectFaceSamples(required, timeoutMs) {
    requireActiveController();
    if (!cameraStream || !faceLandmarker) {
      return Promise.reject(new Error("Start the camera and install the local FaceLandmarker model first."));
    }
    if (faceCollector) return Promise.reject(new Error("Face sampling is already in progress."));
    return new Promise((resolve, reject) => {
      const collector = {
        required,
        samples: [],
        lastSampleAt: 0,
        resolve,
        reject,
        timeout: 0,
      };
      collector.timeout = root.setTimeout(() => {
        if (faceCollector !== collector) return;
        faceCollector = null;
        reject(new Error("Face sampling timed out. Keep one well-lit face centered in the camera."));
      }, timeoutMs);
      faceCollector = collector;
      if (currentFaceDescriptor) {
        collector.samples.push(currentFaceDescriptor);
        collector.lastSampleAt = performance.now();
      }
    });
  }

  async function enrollFace({ label = "owner", samples = 10, timeoutMs = 8000 } = {}) {
    const profileLabel = cleanLabel(label);
    const sampleTarget = clamp(Math.round(Number(samples) || 10), 4, 30);
    const timeout = clamp(Number(timeoutMs) || 8000, 2000, 30000);
    const descriptors = await collectFaceSamples(sampleTarget, timeout);
    const mean = averageVectors(descriptors);
    const variance = vectorVariance(descriptors, mean);
    const database = loadProfiles(FACE_STORAGE_KEY);
    database.profiles[profileLabel] = {
      version: TEMPLATE_VERSION,
      mean,
      variance,
      samples: descriptors.length,
      createdAt: new Date().toISOString(),
      experimental: true,
      authorizationFactor: false,
    };
    saveProfiles(FACE_STORAGE_KEY, database);
    const result = Object.freeze({
      enrolled: true,
      label: profileLabel,
      samples: descriptors.length,
      experimental: true,
      authorizationFactor: false,
    });
    if (callbacks.face) {
      try {
        callbacks.face(result);
      } catch {
        // Enrollment is already committed locally; ignore consumer errors.
      }
    }
    return result;
  }

  async function verifyFace({ label = "owner", samples = 6, timeoutMs = 6000 } = {}) {
    const profileLabel = cleanLabel(label);
    const template = loadProfiles(FACE_STORAGE_KEY).profiles[profileLabel];
    if (!template) throw new Error(`No local face profile named "${profileLabel}" exists.`);
    const sampleTarget = clamp(Math.round(Number(samples) || 6), 3, 20);
    const timeout = clamp(Number(timeoutMs) || 6000, 2000, 30000);
    const descriptors = await collectFaceSamples(sampleTarget, timeout);
    const sample = averageVectors(descriptors);
    const confidence = compareFaceDescriptor(sample, template);
    const result = Object.freeze({
      verified: confidence >= settings.faceMatchThreshold,
      label: profileLabel,
      confidence: Number(confidence.toFixed(3)),
      threshold: settings.faceMatchThreshold,
      experimental: true,
      authorizationFactor: false,
    });
    if (callbacks.face) {
      try {
        callbacks.face(result);
      } catch {
        // Ignore consumer callback errors.
      }
    }
    return result;
  }

  function deleteFaceEnrollment(label = "owner") {
    const profileLabel = cleanLabel(label);
    const database = loadProfiles(FACE_STORAGE_KEY);
    const existed = Object.hasOwn(database.profiles, profileLabel);
    if (existed) {
      delete database.profiles[profileLabel];
      saveProfiles(FACE_STORAGE_KEY, database);
    }
    return existed;
  }

  async function stopVoiceprintCapture() {
    const session = voiceSession;
    if (!session) {
      const changed = state.microphone !== "idle" || state.voiceprint.capturing;
      state.microphone = "idle";
      state.voiceprint = { capturing: false, experimental: true };
      if (changed) emitState();
      return;
    }
    session.cancelled = true;
    voiceSession = null;
    if (session.animationFrame) root.cancelAnimationFrame?.(session.animationFrame);
    session.animationFrame = 0;
    session.reject?.(new Error("Voiceprint capture was cancelled."));
    try {
      session.source?.disconnect();
      session.analyser?.disconnect();
    } catch {
      // Nodes can already be disconnected.
    }
    if (session.stream?.getTracks) {
      for (const track of session.stream.getTracks()) track.stop();
    }
    try {
      await session.audioContext?.close();
    } catch {
      // AudioContext close is best effort.
    }
    state.microphone = "idle";
    state.voiceprint = { capturing: false, experimental: true };
    emitState();
  }

  async function captureVoiceDescriptor(durationMs) {
    requireActiveController();
    if (voiceSession) throw new Error("A voiceprint capture is already running.");
    if (!navigatorRef?.mediaDevices?.getUserMedia) {
      throw new Error("Microphone API is unavailable. Use HTTPS or localhost in a supported browser.");
    }
    const AudioContextClass = root.AudioContext ?? root.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio API is unavailable in this browser.");

    state.microphone = "requesting";
    state.voiceprint = { capturing: true, experimental: true, progress: 0 };
    emitState();
    let stream;
    try {
      stream = await navigatorRef.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      const audioContext = new AudioContextClass({ latencyHint: "interactive" });
      await audioContext.resume();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.15;
      source.connect(analyser);
      const session = { stream, audioContext, source, analyser, cancelled: false, animationFrame: 0 };
      voiceSession = session;
      state.microphone = "active";
      emitState();

      const timeData = new Float32Array(analyser.fftSize);
      const frequencyData = new Float32Array(analyser.frequencyBinCount);
      const frames = [];
      const startAt = performance.now();
      let lastSampleAt = 0;
      const totalDuration = clamp(Number(durationMs) || 3000, 1200, 12000);

      await new Promise((resolve, reject) => {
        session.reject = reject;
        const sample = (now) => {
          if (session.cancelled || voiceSession !== session) {
            reject(new Error("Voiceprint capture was cancelled."));
            return;
          }
          const elapsed = now - startAt;
          if (now - lastSampleAt >= 45) {
            lastSampleAt = now;
            const feature = extractVoiceFrame(analyser, timeData, frequencyData, audioContext.sampleRate);
            if (feature) frames.push(feature);
            state.voiceprint = {
              capturing: true,
              experimental: true,
              progress: Number(clamp(elapsed / totalDuration).toFixed(2)),
            };
            emitState();
          }
          if (elapsed >= totalDuration) {
            session.reject = null;
            session.animationFrame = 0;
            resolve();
            return;
          }
          session.animationFrame = root.requestAnimationFrame(sample);
        };
        session.animationFrame = root.requestAnimationFrame(sample);
      });

      if (frames.length < 8) {
        throw new Error("Not enough voiced audio was detected. Speak continuously in a quiet room and try again.");
      }
      const mean = averageVectors(frames);
      return { mean, variance: vectorVariance(frames, mean), frames: frames.length };
    } finally {
      if (!voiceSession && stream?.getTracks) {
        for (const track of stream.getTracks()) track.stop();
      }
      await stopVoiceprintCapture();
    }
  }

  async function enrollVoiceprint({ label = "owner", durationMs = 3500 } = {}) {
    const profileLabel = cleanLabel(label);
    const descriptor = await captureVoiceDescriptor(durationMs);
    const database = loadProfiles(VOICE_STORAGE_KEY);
    database.profiles[profileLabel] = {
      version: TEMPLATE_VERSION,
      mean: descriptor.mean,
      variance: descriptor.variance,
      frames: descriptor.frames,
      createdAt: new Date().toISOString(),
      experimental: true,
      authorizationFactor: false,
    };
    saveProfiles(VOICE_STORAGE_KEY, database);
    const result = Object.freeze({
      enrolled: true,
      label: profileLabel,
      frames: descriptor.frames,
      experimental: true,
      authorizationFactor: false,
      storage: "localStorage",
    });
    if (callbacks.voiceprint) {
      try {
        callbacks.voiceprint(result);
      } catch {
        // Enrollment is already committed locally; ignore consumer errors.
      }
    }
    return result;
  }

  async function verifyVoiceprint({ label = "owner", durationMs = 3000 } = {}) {
    const profileLabel = cleanLabel(label);
    const template = loadProfiles(VOICE_STORAGE_KEY).profiles[profileLabel];
    if (!template) throw new Error(`No local voice profile named "${profileLabel}" exists.`);
    const descriptor = await captureVoiceDescriptor(durationMs);
    const confidence = compareVoiceDescriptor(descriptor.mean, template);
    const result = Object.freeze({
      verified: confidence >= settings.voiceMatchThreshold,
      label: profileLabel,
      confidence: Number(confidence.toFixed(3)),
      threshold: settings.voiceMatchThreshold,
      experimental: true,
      authorizationFactor: false,
      storage: "localStorage",
    });
    if (callbacks.voiceprint) {
      try {
        callbacks.voiceprint(result);
      } catch {
        // Ignore consumer callback errors.
      }
    }
    return result;
  }

  function deleteVoiceprintEnrollment(label = "owner") {
    const profileLabel = cleanLabel(label);
    const database = loadProfiles(VOICE_STORAGE_KEY);
    const existed = Object.hasOwn(database.profiles, profileLabel);
    if (existed) {
      delete database.profiles[profileLabel];
      saveProfiles(VOICE_STORAGE_KEY, database);
    }
    return existed;
  }

  function listEnrollments() {
    const summarize = (profiles) => Object.entries(profiles).map(([label, profile]) => ({
      label,
      createdAt: profile.createdAt ?? null,
      samples: profile.samples ?? profile.frames ?? 0,
      experimental: true,
      authorizationFactor: false,
    }));
    return Object.freeze({
      face: Object.freeze(summarize(loadProfiles(FACE_STORAGE_KEY).profiles)),
      voice: Object.freeze(summarize(loadProfiles(VOICE_STORAGE_KEY).profiles)),
    });
  }

  function clearBiometricData({ face = true, voice = true } = {}) {
    try {
      if (!root.localStorage) throw new Error("localStorage is not available in this context.");
      if (face) root.localStorage.removeItem(FACE_STORAGE_KEY);
      if (voice) root.localStorage.removeItem(VOICE_STORAGE_KEY);
      return true;
    } catch (error) {
      reportError("local-storage-delete-failed", error, true);
      return false;
    }
  }

  async function stop() {
    await Promise.all([stopCamera(), stopVoiceprintCapture()]);
  }

  async function destroy() {
    if (destroyed) return;
    await stop();
    destroyed = true;
    root.removeEventListener?.("pagehide", handlePageHide);
    documentRef?.removeEventListener?.("visibilitychange", handleVisibilityChange);
  }

  function handlePageHide() {
    void stop();
  }

  function handleVisibilityChange() {
    if (settings.stopOnHidden && documentRef?.visibilityState === "hidden") void stop();
  }

  root.addEventListener?.("pagehide", handlePageHide);
  documentRef?.addEventListener?.("visibilitychange", handleVisibilityChange);
  emitState();

  return Object.freeze({
    start: startCamera,
    stop,
    startCamera,
    stopCamera,
    enrollFace,
    verifyFace,
    deleteFaceEnrollment,
    enrollVoiceprint,
    verifyVoiceprint,
    deleteVoiceprintEnrollment,
    stopVoiceprintCapture,
    listEnrollments,
    clearBiometricData,
    destroy,
    getState: snapshotState,
    getRequirements: () => Object.freeze({
      assets: PERCEPTION_ASSETS,
      assumptions: PERCEPTION_API_ASSUMPTIONS,
      runtimeNetwork: false,
      soleAuthorizationFactor: false,
    }),
  });
}
