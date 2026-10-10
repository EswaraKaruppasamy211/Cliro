import { FaceLandmarker, FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GESTURE_HOLD_MS, GestureRecognizer } from './vision/GestureRecognizer';
import type { GestureAction, GestureLabel, GesturePhase, LandmarkPoint } from './vision/GestureRecognizer';
import { getCameraDiagnostics } from './vision/cameraDiagnostics';
import type { CameraDiagnostics } from './vision/cameraDiagnostics';

type CameraState = 'OFF' | 'INITIALIZING' | 'CONNECTED' | 'PERMISSION DENIED' | 'NOT FOUND' | 'BUSY' | 'ACCESS BLOCKED';
type HandTrackingState = 'OFF' | 'INITIALIZING' | 'READY' | 'ERROR';
type FaceTrackingState = 'OFF' | 'INITIALIZING' | 'READY' | 'ERROR';
type AgentMode = 'idle' | 'listening' | 'vision';
type RecognitionLocale = 'auto' | 'en-IN' | 'ta-IN';

export interface HeadRotation {
  yaw: number;
  pitch: number;
  roll: number;
}

interface Props {
  onVoiceCommand: (transcript: string) => void | Promise<unknown>;
  onVoiceActivity: () => void;
  onGestureAction: (action: GestureAction) => string | Promise<string>;
  onHeadRotation: (rotation: HeadRotation | null) => void;
  onAgentMode: (mode: AgentMode) => void;
  onStatusChange: (status: {
    cameraState: CameraState;
    handTrackingState: HandTrackingState;
    voiceEnabled: boolean;
  }) => void;
}

interface SpeechResult {
  isFinal: boolean;
  0: { transcript: string };
}

interface RecognitionEvent extends Event {
  results: ArrayLike<SpeechResult>;
  resultIndex?: number;
}

interface RecognitionErrorEvent extends Event {
  error: string;
}

interface BrowserSpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onspeechstart: ((event: Event) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type RecognitionConstructor = new () => BrowserSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  }
}

export default function VisionVoiceControls({ onVoiceCommand, onVoiceActivity, onGestureAction, onHeadRotation, onAgentMode, onStatusChange }: Props) {
  const onVoiceCommandRef = useRef(onVoiceCommand);
  const onVoiceActivityRef = useRef(onVoiceActivity);
  const onGestureActionRef = useRef(onGestureAction);
  const onHeadRotationRef = useRef(onHeadRotation);
  const toggleVoiceRef = useRef<() => void>(() => undefined);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<HandLandmarker | null>(null);
  const faceLandmarkerRef = useRef<FaceLandmarker | null>(null);
  const frameTimerRef = useRef<number | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const gestureRecognizerRef = useRef(new GestureRecognizer());
  const activeRef = useRef(false);
  const mountedRef = useRef(true);
  const voiceEnabledRef = useRef(false);
  const recognitionLocaleRef = useRef<RecognitionLocale>('auto');
  const lastVideoTimeRef = useRef(-1);
  const smoothedHeadRotationRef = useRef<HeadRotation>({ yaw: 0, pitch: 0, roll: 0 });

  const [cameraState, setCameraState] = useState<CameraState>('OFF');
  const [handTrackingState, setHandTrackingState] = useState<HandTrackingState>('OFF');
  const [faceTrackingState, setFaceTrackingState] = useState<FaceTrackingState>('OFF');
  const [cameraDiagnostics, setCameraDiagnostics] = useState<CameraDiagnostics | null>(null);
  const [handCount, setHandCount] = useState(0);
  const [landmarksDetected, setLandmarksDetected] = useState(false);
  const [gesture, setGesture] = useState<GestureLabel>('NO_HAND');
  const [gestureCandidate, setGestureCandidate] = useState<GestureLabel>('NO_HAND');
  const [gestureAction, setGestureAction] = useState<GestureAction>('NONE');
  const [gesturePhase, setGesturePhase] = useState<GesturePhase>('NO_HAND');
  const [gestureConfidence, setGestureConfidence] = useState<number | null>(null);
  const [extendedFingers, setExtendedFingers] = useState(0);
  const [curledFingers, setCurledFingers] = useState(0);
  const [gestureStabilityMs, setGestureStabilityMs] = useState(0);
  const [cooldownRemainingMs, setCooldownRemainingMs] = useState(0);
  const [lastGestureAction, setLastGestureAction] = useState('NONE');
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [recognitionLocale, setRecognitionLocale] = useState<RecognitionLocale>('auto');
  const [visionError, setVisionError] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const [lastVoiceInput, setLastVoiceInput] = useState('');

  useEffect(() => {
    onVoiceCommandRef.current = onVoiceCommand;
    onVoiceActivityRef.current = onVoiceActivity;
    onGestureActionRef.current = onGestureAction;
    onHeadRotationRef.current = onHeadRotation;
  }, [onVoiceCommand, onVoiceActivity, onGestureAction, onHeadRotation]);

  useEffect(() => {
    onStatusChange({ cameraState, handTrackingState, voiceEnabled });
  }, [cameraState, handTrackingState, voiceEnabled, onStatusChange]);

  const disableVision = useCallback(() => {
    activeRef.current = false;
    if (frameTimerRef.current !== null) {
      window.clearTimeout(frameTimerRef.current);
      frameTimerRef.current = null;
    }
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
    faceLandmarkerRef.current?.close();
    faceLandmarkerRef.current = null;
    smoothedHeadRotationRef.current = { yaw: 0, pitch: 0, roll: 0 };
    onHeadRotationRef.current(null);
    streamRef.current?.getTracks().forEach(track => {
      track.onended = null;
      track.stop();
    });
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    gestureRecognizerRef.current.reset();
    setHandCount(0);
    setLandmarksDetected(false);
    setGesture('NO_HAND');
    setGestureCandidate('NO_HAND');
    setGestureAction('NONE');
    setGesturePhase('NO_HAND');
    setGestureConfidence(null);
    setExtendedFingers(0);
    setCurledFingers(0);
    setGestureStabilityMs(0);
    setCooldownRemainingMs(0);
    setCameraState('OFF');
    setHandTrackingState('OFF');
    setFaceTrackingState('OFF');
    setCameraDiagnostics(null);
    setVisionError('');
    onAgentMode(voiceEnabledRef.current ? 'listening' : 'idle');
  }, [onAgentMode]);

  const startVision = useCallback(async () => {
    if (activeRef.current) return;
    setVisionError('');
    setCameraState('INITIALIZING');
    setHandTrackingState('OFF');
    setFaceTrackingState('OFF');
    smoothedHeadRotationRef.current = { yaw: 0, pitch: 0, roll: 0 };
    onHeadRotationRef.current(null);
    setCameraDiagnostics(null);
    setHandCount(0);
    setLandmarksDetected(false);
    setGesture('NO_HAND');
    setGestureCandidate('NO_HAND');
    setGestureAction('NONE');
    setGesturePhase('NO_HAND');
    setGestureConfidence(null);
    setExtendedFingers(0);
    setCurledFingers(0);
    setGestureStabilityMs(0);
    gestureRecognizerRef.current.reset();
    lastVideoTimeRef.current = -1;
    activeRef.current = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      activeRef.current = false;
      setCameraState('ACCESS BLOCKED');
      setVisionError('Camera access is blocked in this browser context. Open CLIRO at localhost or HTTPS and allow camera access.');
      return;
    }
    if (!window.isSecureContext) {
      activeRef.current = false;
      setCameraState('ACCESS BLOCKED');
      setVisionError('Camera access is blocked because this page is not in a secure context. Use http://localhost or HTTPS.');
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      activeRef.current = false;
      const message = error instanceof Error ? error.message : String(error);
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setCameraState('PERMISSION DENIED');
        setVisionError('Camera permission denied. Allow camera access for localhost in your browser site permissions, then click ENABLE VISION again.');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setCameraState('NOT FOUND');
        setVisionError('CAMERA NOT FOUND. Connect or enable a camera, then click ENABLE VISION again.');
      } else if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
        setCameraState('BUSY');
        setVisionError('CAMERA BUSY. Close other applications using the camera, then click ENABLE VISION again.');
      } else if (name === 'SecurityError') {
        setCameraState('ACCESS BLOCKED');
        setVisionError('CAMERA ACCESS BLOCKED by browser or system policy. Allow camera access for localhost in browser and Windows privacy settings.');
      } else {
        setCameraState('ACCESS BLOCKED');
        setVisionError(`CAMERA ACCESS BLOCKED: ${message}. Check browser site permissions and Windows camera privacy settings.`);
      }
      const failedDiagnostics = await getCameraDiagnostics(null, false, message);
      if (mountedRef.current) setCameraDiagnostics(failedDiagnostics);
      return;
    }

    if (!mountedRef.current || !activeRef.current) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    streamRef.current = stream;
    setCameraState('CONNECTED');
    setHandTrackingState('INITIALIZING');
    setVisionError('');
    onAgentMode('vision');
    setCameraDiagnostics(await getCameraDiagnostics(stream));
    if (!mountedRef.current || !activeRef.current) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    stream.getVideoTracks().forEach(track => {
      track.onended = () => {
        activeRef.current = false;
        if (frameTimerRef.current !== null) window.clearTimeout(frameTimerRef.current);
        frameTimerRef.current = null;
        landmarkerRef.current?.close();
        landmarkerRef.current = null;
        faceLandmarkerRef.current?.close();
        faceLandmarkerRef.current = null;
        onHeadRotationRef.current(null);
        if (mountedRef.current) {
          setCameraState('ACCESS BLOCKED');
          setHandTrackingState('ERROR');
          setFaceTrackingState('ERROR');
          setCameraDiagnostics(current => current
            ? { ...current, cameraConnected: false, streamActive: false, handTrackingReady: false, error: 'The camera stream stopped.' }
            : current);
          setVisionError('The camera stream stopped. Check camera access and click ENABLE VISION to reconnect.');
        }
      };
    });

    try {
      const video = videoRef.current;
      if (!video) throw new Error('Camera preview element is missing.');
      video.srcObject = stream;
      await video.play();

      const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      if (!activeRef.current) return;
      const landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: '/models/hand_landmarker.task',
          delegate: 'CPU'
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.7,
        minHandPresenceConfidence: 0.7,
        minTrackingConfidence: 0.7
      });
      if (!activeRef.current) {
        landmarker.close();
        return;
      }
      landmarkerRef.current = landmarker;
      setHandTrackingState('READY');
      setFaceTrackingState('INITIALIZING');
      try {
        const faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: '/models/face_landmarker.task',
            delegate: 'CPU'
          },
          runningMode: 'VIDEO',
          numFaces: 1,
          minFaceDetectionConfidence: 0.6,
          minFacePresenceConfidence: 0.6,
          minTrackingConfidence: 0.6
        });
        if (!activeRef.current) {
          faceLandmarker.close();
          return;
        }
        faceLandmarkerRef.current = faceLandmarker;
        setFaceTrackingState('READY');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFaceTrackingState('ERROR');
        setVisionError(`CAMERA CONNECTED · FACE TRACKING UNAVAILABLE. Check the local Face Landmarker model and WASM assets. ${message}`);
      }
      const trackingDiagnostics = await getCameraDiagnostics(stream, true);
      if (activeRef.current && mountedRef.current) setCameraDiagnostics(trackingDiagnostics);

      const processFrame = () => {
        if (!activeRef.current || !videoRef.current || !landmarkerRef.current) return;
        const currentVideo = videoRef.current;
        if (currentVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && currentVideo.currentTime !== lastVideoTimeRef.current) {
          lastVideoTimeRef.current = currentVideo.currentTime;
          try {
            const timestamp = performance.now();
            const result = landmarkerRef.current.detectForVideo(currentVideo, timestamp);
            if (faceLandmarkerRef.current) {
              try {
                const faceResult = faceLandmarkerRef.current.detectForVideo(currentVideo, timestamp);
                const face = faceResult.faceLandmarks[0];
                let targetRotation: HeadRotation = { yaw: 0, pitch: 0, roll: 0 };
                if (face && face.length > 263) {
                  const eyeMidpoint = (face[33].x + face[263].x) / 2;
                  const eyeWidth = Math.max(Math.abs(face[263].x - face[33].x), 0.001);
                  const faceHeight = Math.max(Math.abs(face[152].y - face[10].y), 0.001);
                  const noseOffset = (face[1].x - eyeMidpoint) / eyeWidth;
                  const verticalOffset = (face[1].y - (face[33].y + face[263].y) / 2) / faceHeight;
                  const eyeLineRoll = Math.atan2(
                    (face[263].y - face[33].y) * currentVideo.videoHeight,
                    (face[263].x - face[33].x) * currentVideo.videoWidth
                  ) * 180 / Math.PI;
                  targetRotation = {
                    yaw: Math.max(-28, Math.min(28, noseOffset * 58)),
                    pitch: Math.max(-18, Math.min(18, (verticalOffset - 0.28) * 58)),
                    roll: Math.max(-22, Math.min(22, eyeLineRoll))
                  };
                }
                const smoothed = smoothedHeadRotationRef.current;
                smoothed.yaw += (targetRotation.yaw - smoothed.yaw) * 0.38;
                smoothed.pitch += (targetRotation.pitch - smoothed.pitch) * 0.38;
                smoothed.roll += (targetRotation.roll - smoothed.roll) * 0.38;
                onHeadRotationRef.current({ ...smoothed });
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                faceLandmarkerRef.current.close();
                faceLandmarkerRef.current = null;
                setFaceTrackingState('ERROR');
                onHeadRotationRef.current(null);
                setVisionError(`CAMERA CONNECTED · FACE TRACKING STOPPED. ${message}`);
              }
            }
            const hands = result.landmarks as LandmarkPoint[][];
            const confidence = hands.length === 1
              ? result.handedness[0]?.[0]?.score ?? null
              : null;
            const state = gestureRecognizerRef.current.update(hands, confidence, performance.now());
            const stableGesture = state.stabilityMs >= GESTURE_HOLD_MS &&
              state.confidence !== null && state.confidence >= 0.8;
            setHandCount(hands.length);
            setLandmarksDetected(hands.length > 0 && hands.every(hand => hand.length >= 21));
            setGestureCandidate(state.gesture);
            setGesture(stableGesture || state.gesture === 'PARTIAL' || state.gesture === 'UNKNOWN' || state.gesture === 'NO_HAND'
              ? state.gesture
              : 'UNKNOWN');
            setGestureAction(stableGesture ? state.action : 'NONE');
            setGesturePhase(state.phase);
            setGestureConfidence(state.confidence);
            setExtendedFingers(state.extendedFingers);
            setCurledFingers(state.curledFingers);
            setGestureStabilityMs(state.stabilityMs);
            setCooldownRemainingMs(state.cooldownRemainingMs);
            if (state.triggerUiAction) {
              setLastGestureAction(`GESTURE CONFIRMED · ACTION ${state.action.replaceAll('_', ' ')}`);
              void Promise.resolve()
                .then(() => {
                  if (state.action === 'TOGGLE_VOICE_LISTENING') {
                    toggleVoiceRef.current();
                    return 'VOICE LISTENING TOGGLED';
                  }
                  return onGestureActionRef.current(state.action);
                })
                .then(result => new Promise<string>(resolve => {
                  window.requestAnimationFrame(() => resolve(result));
                }))
                .then(result => setLastGestureAction(result === 'NONE' ? 'NONE' : `ACTION COMPLETED · ${result}`))
                .catch(error => {
                  const message = error instanceof Error ? error.message : String(error);
                  setLastGestureAction(`ACTION FAILED · ${message}`);
                });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setHandTrackingState('ERROR');
            landmarkerRef.current?.close();
            landmarkerRef.current = null;
            faceLandmarkerRef.current?.close();
            faceLandmarkerRef.current = null;
            setFaceTrackingState('ERROR');
            onHeadRotationRef.current(null);
            setCameraDiagnostics(current => current
              ? { ...current, handTrackingReady: false, error: message }
              : current);
            setVisionError(`CAMERA CONNECTED · HAND TRACKING UNAVAILABLE. Check the local Hand Landmarker model and WASM assets. ${message}`);
            return;
          }
        }
        frameTimerRef.current = window.setTimeout(processFrame, 100);
      };
      processFrame();
    } catch (error) {
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
      faceLandmarkerRef.current?.close();
      faceLandmarkerRef.current = null;
      setHandTrackingState('ERROR');
      setFaceTrackingState('ERROR');
      onHeadRotationRef.current(null);
      setVisionError(`CAMERA CONNECTED · HAND TRACKING UNAVAILABLE. Check the local Hand Landmarker model and WASM assets. ${error instanceof Error ? error.message : String(error)}`);
      setCameraDiagnostics(await getCameraDiagnostics(stream, false, error instanceof Error ? error.message : String(error)));
    }
  }, [onAgentMode]);

  const disableVoice = useCallback(() => {
    voiceEnabledRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setVoiceEnabled(false);
    onAgentMode(activeRef.current ? 'vision' : 'idle');
  }, [onAgentMode]);

  const enableVoice = useCallback(() => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setVoiceError('Speech recognition is not supported by this browser.');
      return;
    }
    setVoiceError('');
    const recognition = new Recognition();
    const processedFinalResults = new Set<number>();
    recognition.lang = recognitionLocaleRef.current === 'auto'
      ? navigator.language || 'en-US'
      : recognitionLocaleRef.current;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onspeechstart = () => onVoiceActivityRef.current();
    recognition.onresult = event => {
      const startIndex = Math.max(0, event.resultIndex || 0);
      for (let index = startIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result?.[0]?.transcript) continue;
        if (!result.isFinal) {
          onVoiceActivityRef.current();
          continue;
        }
        if (!processedFinalResults.has(index)) {
          processedFinalResults.add(index);
          const transcript = result[0].transcript.trim();
          if (transcript) {
            setLastVoiceInput(transcript);
            void Promise.resolve(onVoiceCommandRef.current(transcript)).finally(() => {
              if (voiceEnabledRef.current) onAgentMode('listening');
            });
          }
        }
      }
    };
    recognition.onerror = event => {
      if (event.error === 'no-speech' || event.error === 'aborted') {
        setVoiceError('');
        return;
      }
      const message = event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'Microphone permission was denied or browser speech service is unavailable.'
        : `Speech recognition error: ${event.error}`;
      setVoiceError(message);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        voiceEnabledRef.current = false;
        recognitionRef.current = null;
        setVoiceEnabled(false);
        onAgentMode(activeRef.current ? 'vision' : 'idle');
      }
    };
    recognition.onend = () => {
      if (voiceEnabledRef.current && recognitionRef.current === recognition) {
        window.setTimeout(() => {
          if (voiceEnabledRef.current && recognitionRef.current === recognition) {
            try {
              recognition.lang = recognitionLocaleRef.current === 'auto'
                ? navigator.language || 'en-US'
                : recognitionLocaleRef.current;
              recognition.start();
            } catch {
              setVoiceError('Speech recognition could not resume. Disable and enable Voice to retry.');
            }
          }
        }, 300);
      }
    };
    recognitionRef.current = recognition;
    voiceEnabledRef.current = true;
    setVoiceEnabled(true);
    onAgentMode('listening');
    try {
      recognition.start();
    } catch (error) {
      voiceEnabledRef.current = false;
      recognitionRef.current = null;
      setVoiceEnabled(false);
      setVoiceError(`Voice could not be enabled: ${error instanceof Error ? error.message : String(error)}`);
      onAgentMode(activeRef.current ? 'vision' : 'idle');
    }
  }, [onAgentMode]);

  const changeRecognitionLocale = (locale: RecognitionLocale) => {
    recognitionLocaleRef.current = locale;
    setRecognitionLocale(locale);
    const recognition = recognitionRef.current;
    if (recognition && voiceEnabledRef.current) {
      recognition.lang = locale === 'auto' ? navigator.language || 'en-US' : locale;
      recognition.stop();
    }
  };

  useEffect(() => {
    toggleVoiceRef.current = () => {
      if (voiceEnabledRef.current) disableVoice();
      else enableVoice();
    };
  }, [disableVoice, enableVoice]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRef.current = false;
      voiceEnabledRef.current = false;
      if (frameTimerRef.current !== null) window.clearTimeout(frameTimerRef.current);
      recognitionRef.current?.abort();
      landmarkerRef.current?.close();
      faceLandmarkerRef.current?.close();
      faceLandmarkerRef.current = null;
      onHeadRotationRef.current(null);
      streamRef.current?.getTracks().forEach(track => {
        track.onended = null;
        track.stop();
      });
    };
  }, []);

  const visionEnabled = cameraState === 'CONNECTED';
  const cameraButtonBusy = cameraState === 'INITIALIZING';

  return (
    <section className="vision-voice-panel" aria-label="Vision and voice controls">
      <div className="vision-voice-controls">
        <div className="vision-voice-status">
            <span className={`vision-status-dot ${visionEnabled ? 'active' : ''}`} />
          <span>CAMERA {cameraState}</span>
          {cameraState === 'CONNECTED' && (
            <>
              <span className="vision-camera-state">HAND TRACKING {handTrackingState}</span>
              <span className="vision-camera-state">FACE TRACKING {faceTrackingState}</span>
            </>
          )}
            {handTrackingState === 'READY' && <span className="vision-gesture-state">GESTURE {gesture.replaceAll('_', ' ')}</span>}
        </div>
        <div className="vision-voice-buttons">
          <button
            type="button"
            className={`vision-control-button ${visionEnabled ? 'enabled' : ''}`}
            onClick={visionEnabled || cameraButtonBusy ? disableVision : startVision}
          >
            {cameraButtonBusy ? 'CANCEL VISION' : visionEnabled ? 'DISABLE VISION' : 'ENABLE VISION'}
          </button>
          <button type="button" className={`vision-control-button ${voiceEnabled ? 'enabled' : ''}`} onClick={voiceEnabled ? disableVoice : enableVoice}>
            {voiceEnabled ? 'DISABLE VOICE' : 'ENABLE VOICE'}
          </button>
          <label className="voice-language-select">
            <span>VOICE LANGUAGE</span>
            <select
              aria-label="Voice recognition language"
              value={recognitionLocale}
              onChange={event => changeRecognitionLocale(event.target.value as RecognitionLocale)}
            >
              <option value="auto">Automatic</option>
              <option value="en-IN">English (India)</option>
              <option value="ta-IN">Tamil (India)</option>
            </select>
          </label>
        </div>
        <details className="hand-control-guide">
          <summary>HAND CONTROL · 80% CONFIDENCE · HOLD 650 MS</summary>
          <ul>
            <li>Open palm — toggle the existing voice-listening control.</li>
            <li>Closed fist — close the active eligible Chrome tab after permission check and verification.</li>
            <li>Turn palm or point right / left — activate the next / previous eligible Chrome tab.</li>
            <li>Thumbs up / down — approve / cancel the visible permission request only.</li>
            <li>V-sign — toggle local voice output for typed responses.</li>
            <li>Point up or pinch — focus the current CLIRO view.</li>
            <li>Pause with no hand or a neutral partial pose to re-arm after a gesture.</li>
          </ul>
        </details>
      </div>
      <div className={`vision-preview ${visionEnabled ? '' : 'camera-preview-hidden'}`}>
          <video ref={videoRef} muted playsInline aria-label="Local camera preview" />
          <div className="vision-privacy-label">VISION ACTIVE · FACE AND HAND TRACKING ARE LOCAL · FRAMES NOT UPLOADED OR STORED</div>
          {gestureStabilityMs > 0 && !['NO_HAND', 'PARTIAL', 'UNKNOWN'].includes(gestureCandidate) && (
            <div className="gesture-hold-track" aria-label="Gesture hold progress">
              <div style={{ width: `${Math.min(100, Math.round(gestureStabilityMs / GESTURE_HOLD_MS * 100))}%` }} />
            </div>
          )}
      </div>
      {cameraState === 'OFF' && <p className="vision-privacy-off">VISION OFF · Camera and tracking are stopped.</p>}
      {cameraState !== 'OFF' && (
        <details className="vision-diagnostics">
          <summary>VISION DIAGNOSTICS</summary>
          <div>CAMERA: {cameraDiagnostics?.cameraConnected ? 'CONNECTED' : cameraState}</div>
          <div>PERMISSION: {cameraDiagnostics?.permissionState.toUpperCase() || 'UNKNOWN'}</div>
          <div>VIDEO INPUTS: {cameraDiagnostics?.deviceCount ?? 'UNKNOWN'}</div>
          <div>HAND TRACKING: {handTrackingState}</div>
          <div>FACE TRACKING: {faceTrackingState}</div>
          <div>HANDS: {handCount}</div>
          <div>LANDMARKS: {landmarksDetected ? 'DETECTED' : 'NOT DETECTED'}</div>
          <div>GESTURE: {gesture.replaceAll('_', ' ')}</div>
          <div>CANDIDATE: {gestureCandidate.replaceAll('_', ' ')}</div>
          <div>ACTION: {gestureAction.replaceAll('_', ' ')}</div>
          <div>STATE: {gesturePhase.replaceAll('_', ' ')}</div>
          <div>CONFIDENCE: {gestureConfidence === null ? '—' : `${Math.round(gestureConfidence * 100)}%`}</div>
          <div>FINGERS: {extendedFingers} extended / {curledFingers} curled</div>
          <div>STABILITY: {gestureStabilityMs} ms</div>
          <div>LAST UI ACTION: {lastGestureAction}</div>
          <div>COOLDOWN: {cooldownRemainingMs} ms</div>
          <div>GESTURE SCOPE: CLIRO UI ONLY</div>
          {cameraDiagnostics?.error && <div>DIAGNOSTIC ERROR: {cameraDiagnostics.error}</div>}
        </details>
      )}
      {voiceEnabled && <p className="voice-privacy-note">VOICE ACTIVE · The browser speech service may process audio; CLIRO receives recognized text only.</p>}
      {lastVoiceInput && <p className="vision-voice-last-input">VOICE INPUT · “{lastVoiceInput}”</p>}
      {visionError && <p className="vision-voice-error" role="alert">{visionError}</p>}
      {voiceError && <p className="vision-voice-error" role="alert">{voiceError}</p>}
    </section>
  );
}
