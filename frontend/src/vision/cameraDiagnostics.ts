export type CameraPermissionState = PermissionState | 'unsupported' | 'unknown';

export interface CameraDiagnostics {
  supported: boolean;
  permissionState: CameraPermissionState;
  deviceCount: number;
  cameraConnected: boolean;
  streamActive: boolean;
  handTrackingReady: boolean;
  error?: string;
}

export async function getCameraDiagnostics(
  stream: MediaStream | null = null,
  handTrackingReady = false,
  error?: string
): Promise<CameraDiagnostics> {
  const supported = Boolean(navigator.mediaDevices?.getUserMedia);
  let permissionState: CameraPermissionState = 'unknown';
  let deviceCount = 0;
  const diagnosticErrors: string[] = error ? [error] : [];

  if (navigator.permissions?.query) {
    try {
      const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
      permissionState = status.state;
    } catch (diagnosticError) {
      permissionState = 'unsupported';
      diagnosticErrors.push(`Permission state unavailable: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`);
    }
  } else {
    permissionState = 'unsupported';
  }

  if (navigator.mediaDevices?.enumerateDevices) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      deviceCount = devices.filter(device => device.kind === 'videoinput').length;
    } catch (diagnosticError) {
      diagnosticErrors.push(`Video device enumeration failed: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`);
    }
  }

  const streamActive = Boolean(stream?.getVideoTracks().some(track => track.readyState === 'live'));
  return {
    supported,
    permissionState,
    deviceCount,
    cameraConnected: streamActive,
    streamActive,
    handTrackingReady,
    ...(diagnosticErrors.length ? { error: diagnosticErrors.join(' ') } : {})
  };
}
