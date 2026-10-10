export function actionStateFor(type: string, verified?: boolean): 'executing' | 'success' | 'failed' {
  if (type === 'ACTION_EXECUTING') return 'executing';
  const isVerifiedSuccess = verified === true && (
    type === 'ACTION_SUCCESS' ||
    type === 'APPLICATION_OPENED' ||
    type === 'APPLICATION_ALREADY_RUNNING'
  );
  if (isVerifiedSuccess) return 'success';
  return 'failed';
}

export function actionLabelFor(type: string, message: string): string {
  switch (type) {
    case 'APPLICATION_OPENED': return 'APPLICATION OPEN';
    case 'APPLICATION_ALREADY_RUNNING': return 'APPLICATION ALREADY RUNNING';
    case 'APPLICATION_NOT_FOUND': return 'APPLICATION NOT FOUND';
    case 'APPLICATION_FAILED': return 'APPLICATION FAILED';
    case 'FOLDER_NOT_FOUND': return 'FOLDER NOT FOUND';
    case 'ACTION_SUCCESS': return 'ACTION COMPLETED';
    case 'ACTION_UNVERIFIED': return 'ACTION NOT VERIFIED';
    case 'ACTION_PARTIAL': return 'ACTION PARTIALLY COMPLETED';
    case 'ACTION_UNAVAILABLE': return 'ACTION UNAVAILABLE';
    case 'UNSUPPORTED_ACTION': return 'UNSUPPORTED ACTION';
    case 'APPLICATION_NOT_READY': return 'APPLICATION NOT READY';
    case 'WINDOW_NOT_FOUND': return 'WINDOW NOT FOUND';
    case 'ACTION_APPROVAL_REQUIRED': return 'APPROVAL REQUIRED';
    case 'ACTION_FAILED': return 'ACTION FAILED';
    default: return message.toUpperCase();
  }
}

export function isStructuredActionSuccess(payload: unknown): payload is { type: string; verified: true; message?: string } {
  if (!payload || typeof payload !== 'object' || !('type' in payload) || typeof (payload as { type?: unknown }).type !== 'string') {
    return false;
  }

  const type = (payload as { type: string }).type;
  const verified = (payload as { verified?: unknown }).verified;
  return verified === true && (
    type === 'ACTION_SUCCESS' ||
    type === 'APPLICATION_OPENED' ||
    type === 'APPLICATION_ALREADY_RUNNING'
  );
}
