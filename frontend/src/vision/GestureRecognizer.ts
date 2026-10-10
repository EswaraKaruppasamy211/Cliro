export interface LandmarkPoint {
  x: number;
  y: number;
  z?: number;
}

export type GestureLabel =
  | 'NO_HAND'
  | 'OPEN_PALM'
  | 'CLOSED_FIST'
  | 'TURN_RIGHT'
  | 'TURN_LEFT'
  | 'THUMBS_UP'
  | 'THUMBS_DOWN'
  | 'POINT'
  | 'POINT_RIGHT'
  | 'POINT_LEFT'
  | 'V_SIGN'
  | 'PINCH'
  | 'PARTIAL'
  | 'UNKNOWN';

export type GestureAction =
  | 'CLOSE_CHROME_TAB'
  | 'NEXT_CHROME_TAB'
  | 'PREVIOUS_CHROME_TAB'
  | 'TOGGLE_VOICE_LISTENING'
  | 'TOGGLE_VOICE_OUTPUT'
  | 'SCROLL_UP'
  | 'SCROLL_DOWN'
  | 'SELECT'
  | 'APPROVE'
  | 'CANCEL'
  | 'NONE';

export type GesturePhase =
  | 'NO_HAND'
  | 'OPEN'
  | 'CANDIDATE_CLOSED'
  | 'CLOSED_CONFIRMED'
  | 'ACTION_TRIGGERED'
  | 'COOLDOWN'
  | 'WAITING_FOR_OPEN'
  | 'PARTIAL'
  | 'UNKNOWN';

export interface GestureClassification {
  gesture: GestureLabel;
  action: GestureAction;
  confidence: number | null;
  extendedFingers: number;
  curledFingers: number;
}

export interface GestureState extends GestureClassification {
  phase: GesturePhase;
  stabilityMs: number;
  cooldownRemainingMs: number;
  triggerUiAction: boolean;
}

const MIN_LANDMARK_CONFIDENCE = 0.8;
const MIN_CLASSIFICATION_CONFIDENCE = 0.8;
const MIN_STABLE_FRAMES = 4;
export const GESTURE_HOLD_MS = 650;
const NEUTRAL_RESET_MS = 350;
const ACTION_COOLDOWN_MS = 1_200;
const MAX_TRACKING_GAP_MS = 500;

const fingerChains = [
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20]
] as const;

type FingerState = 'extended' | 'curled' | 'uncertain';

function distance(first: LandmarkPoint, second: LandmarkPoint): number {
  return Math.hypot(
    first.x - second.x,
    first.y - second.y,
    (first.z || 0) - (second.z || 0)
  );
}

function jointAngle(first: LandmarkPoint, vertex: LandmarkPoint, last: LandmarkPoint): number {
  const firstVector = {
    x: first.x - vertex.x,
    y: first.y - vertex.y,
    z: (first.z || 0) - (vertex.z || 0)
  };
  const lastVector = {
    x: last.x - vertex.x,
    y: last.y - vertex.y,
    z: (last.z || 0) - (vertex.z || 0)
  };
  const magnitude = Math.hypot(firstVector.x, firstVector.y, firstVector.z) *
    Math.hypot(lastVector.x, lastVector.y, lastVector.z);
  if (!Number.isFinite(magnitude) || magnitude < 1e-6) return Number.NaN;
  const cosine = (
    firstVector.x * lastVector.x +
    firstVector.y * lastVector.y +
    firstVector.z * lastVector.z
  ) / magnitude;
  return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
}

function classifyFinger(points: LandmarkPoint[], chain: readonly [number, number, number, number]): FingerState {
  const [mcp, pip, dip, tip] = chain.map(index => points[index]);
  const pipAngle = jointAngle(mcp, pip, dip);
  const dipAngle = jointAngle(pip, dip, tip);
  if (!Number.isFinite(pipAngle) || !Number.isFinite(dipAngle)) return 'uncertain';
  if (pipAngle >= 150 && dipAngle >= 145) return 'extended';
  if (pipAngle <= 132 || dipAngle <= 125) return 'curled';
  return 'uncertain';
}

function classifyThumb(points: LandmarkPoint[], palmScale: number): FingerState {
  const thumbTipToIndexBase = distance(points[4], points[5]) / palmScale;
  const thumbTipToWrist = distance(points[4], points[0]) / palmScale;
  if (!Number.isFinite(thumbTipToIndexBase) || !Number.isFinite(thumbTipToWrist)) return 'uncertain';
  if (thumbTipToIndexBase >= 0.62 && thumbTipToWrist >= 0.72) return 'extended';
  if (thumbTipToIndexBase <= 0.48 && thumbTipToWrist <= 1.05) return 'curled';
  return 'uncertain';
}

function gestureAction(gesture: GestureLabel): GestureAction {
  switch (gesture) {
    case 'OPEN_PALM': return 'TOGGLE_VOICE_LISTENING';
    case 'CLOSED_FIST': return 'CLOSE_CHROME_TAB';
    case 'TURN_RIGHT': return 'NEXT_CHROME_TAB';
    case 'TURN_LEFT': return 'PREVIOUS_CHROME_TAB';
    case 'THUMBS_UP': return 'APPROVE';
    case 'THUMBS_DOWN': return 'CANCEL';
    case 'POINT': return 'SELECT';
    case 'POINT_RIGHT': return 'NEXT_CHROME_TAB';
    case 'POINT_LEFT': return 'PREVIOUS_CHROME_TAB';
    case 'V_SIGN': return 'TOGGLE_VOICE_OUTPUT';
    case 'PINCH': return 'SELECT';
    default: return 'NONE';
  }
}

export function classifyHandLandmarks(
  points: LandmarkPoint[],
  landmarkConfidence: number | null
): GestureClassification {
  const empty = (gesture: GestureLabel, confidence = landmarkConfidence): GestureClassification => ({
    gesture,
    action: gestureAction(gesture),
    confidence,
    extendedFingers: 0,
    curledFingers: 0
  });
  if (landmarkConfidence === null || landmarkConfidence < MIN_LANDMARK_CONFIDENCE || points.length < 21) {
    return empty('UNKNOWN');
  }
  if (points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return empty('UNKNOWN');
  }

  const palmScale = distance(points[0], points[9]);
  if (!Number.isFinite(palmScale) || palmScale < 0.015) return empty('UNKNOWN');

  const fingerStates = fingerChains.map(chain => classifyFinger(points, chain));
  const thumbState = classifyThumb(points, palmScale);
  const extendedFingers = fingerStates.filter(state => state === 'extended').length;
  const curledFingers = fingerStates.filter(state => state === 'curled').length;
  const evidenceCount = [...fingerStates, thumbState].filter(state => state !== 'uncertain').length;
  const confidence = landmarkConfidence;
  const classifyAs = (gesture: GestureLabel, action = gestureAction(gesture)): GestureClassification => ({
    gesture,
    action,
    confidence,
    extendedFingers,
    curledFingers
  });

  if (confidence < MIN_CLASSIFICATION_CONFIDENCE || evidenceCount < 3) {
    return classifyAs('UNKNOWN');
  }

  const thumbIndexDistance = distance(points[4], points[8]) / palmScale;
  if (curledFingers <= 2 && Number.isFinite(thumbIndexDistance) && thumbIndexDistance < 0.32) {
    return classifyAs('PINCH');
  }

  if (extendedFingers === 4 && thumbState === 'extended') {
    const palmAngle = Math.atan2(points[17].y - points[5].y, points[17].x - points[5].x);
    if (palmAngle > 0.35 && palmAngle < 1.2) return classifyAs('TURN_RIGHT');
    if (palmAngle < -0.35 && palmAngle > -1.2) return classifyAs('TURN_LEFT');
    return classifyAs('OPEN_PALM');
  }
  if (curledFingers === 4 && thumbState === 'curled') return classifyAs('CLOSED_FIST');

  if (curledFingers === 4 && thumbState === 'extended') {
    const thumbVertical = points[4].y - points[2].y;
    if (thumbVertical < -palmScale * 0.2) return classifyAs('THUMBS_UP');
    if (thumbVertical > palmScale * 0.2) return classifyAs('THUMBS_DOWN');
  }

  if (fingerStates[0] === 'extended' && fingerStates.slice(1).every(state => state === 'curled')) {
    const indexHorizontal = points[8].x - points[5].x;
    const indexVertical = points[8].y - points[5].y;
    if (Math.abs(indexHorizontal) > palmScale * 0.55 &&
        Math.abs(indexHorizontal) > Math.abs(indexVertical) * 1.2) {
      return classifyAs(indexHorizontal > 0 ? 'POINT_RIGHT' : 'POINT_LEFT');
    }
    return classifyAs('POINT');
  }

  if (fingerStates[0] === 'extended' && fingerStates[1] === 'extended' &&
      fingerStates[2] === 'curled' && fingerStates[3] === 'curled') {
    return classifyAs('V_SIGN');
  }

  if (fingerStates.every(state => state === 'uncertain')) return classifyAs('UNKNOWN');
  return classifyAs('PARTIAL');
}

function emptyState(gesture: GestureLabel, phase: GesturePhase, remaining = 0): GestureState {
  return {
    gesture,
    action: 'NONE',
    confidence: null,
    extendedFingers: 0,
    curledFingers: 0,
    phase,
    stabilityMs: 0,
    cooldownRemainingMs: remaining,
    triggerUiAction: false
  };
}

function phaseForGesture(gesture: GestureLabel): GesturePhase {
  if (gesture === 'OPEN_PALM') return 'OPEN';
  if (gesture === 'CLOSED_FIST') return 'CLOSED_CONFIRMED';
  if (gesture === 'PARTIAL') return 'PARTIAL';
  if (gesture === 'UNKNOWN') return 'UNKNOWN';
  return 'CANDIDATE_CLOSED';
}

export class GestureRecognizer {
  private candidate: GestureLabel | null = null;
  private candidateStartedAt = 0;
  private candidateFrames = 0;
  private lastCandidateFrameAt = 0;
  private latchedGesture: GestureLabel | null = null;
  private lastActionAt = Number.NEGATIVE_INFINITY;
  private neutralStartedAt: number | null = null;
  private neutralFrames = 0;

  update(hands: LandmarkPoint[][], confidence: number | null, now: number): GestureState {
    const cooldownRemainingMs = Math.max(0, ACTION_COOLDOWN_MS - (now - this.lastActionAt));
    if (hands.length !== 1) {
      this.resetCandidate();
      this.updateNeutral(now);
      return emptyState(hands.length === 0 ? 'NO_HAND' : 'UNKNOWN',
        cooldownRemainingMs > 0 ? 'COOLDOWN' : this.latchedGesture ? 'WAITING_FOR_OPEN' : 'NO_HAND',
        cooldownRemainingMs);
    }

    if (this.candidate !== null &&
        (now < this.lastCandidateFrameAt || now - this.lastCandidateFrameAt > MAX_TRACKING_GAP_MS)) {
      this.resetCandidate();
    }
    const classification = classifyHandLandmarks(hands[0], confidence);
    const { gesture, action } = classification;
    if (gesture === 'UNKNOWN' || gesture === 'PARTIAL' || action === 'NONE') {
      this.resetCandidate();
      this.updateNeutral(now);
      return {
        ...classification,
        phase: cooldownRemainingMs > 0 ? 'COOLDOWN' : this.latchedGesture ? 'WAITING_FOR_OPEN' : phaseForGesture(gesture),
        stabilityMs: 0,
        cooldownRemainingMs,
        triggerUiAction: false
      };
    }

    this.neutralStartedAt = null;
    this.neutralFrames = 0;
    if (this.candidate !== gesture) {
      this.candidate = gesture;
      this.candidateStartedAt = now;
      this.candidateFrames = 1;
    } else {
      this.candidateFrames += 1;
    }
    this.lastCandidateFrameAt = now;
    const stabilityMs = this.candidateFrames >= MIN_STABLE_FRAMES
      ? Math.max(0, now - this.candidateStartedAt)
      : 0;
    if (cooldownRemainingMs > 0) {
      return { ...classification, phase: 'COOLDOWN', stabilityMs, cooldownRemainingMs, triggerUiAction: false };
    }
    if (this.latchedGesture !== null) {
      return { ...classification, phase: 'WAITING_FOR_OPEN', stabilityMs, cooldownRemainingMs: 0, triggerUiAction: false };
    }

    if (this.candidateFrames < MIN_STABLE_FRAMES || stabilityMs < GESTURE_HOLD_MS) {
      return {
        ...classification,
        phase: phaseForGesture(gesture),
        stabilityMs,
        cooldownRemainingMs: 0,
        triggerUiAction: false
      };
    }

    this.lastActionAt = now;
    this.latchedGesture = gesture;
    return {
      ...classification,
      phase: 'ACTION_TRIGGERED',
      stabilityMs,
      cooldownRemainingMs: ACTION_COOLDOWN_MS,
      triggerUiAction: true
    };
  }

  reset(): void {
    this.resetCandidate();
    this.latchedGesture = null;
    this.lastActionAt = Number.NEGATIVE_INFINITY;
    this.neutralStartedAt = null;
    this.neutralFrames = 0;
  }

  private resetCandidate(): void {
    this.candidate = null;
    this.candidateStartedAt = 0;
    this.candidateFrames = 0;
    this.lastCandidateFrameAt = 0;
  }

  private updateNeutral(now: number): void {
    this.neutralStartedAt ??= now;
    this.neutralFrames += 1;
    if (this.neutralFrames >= MIN_STABLE_FRAMES &&
        now - this.neutralStartedAt >= NEUTRAL_RESET_MS) {
      this.latchedGesture = null;
    }
  }
}
