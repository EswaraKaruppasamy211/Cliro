export type ActivityStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'REQUIRES_APPROVAL';

export interface ActivityEvent {
  stage: string;
  status: ActivityStatus;
  message: string;
  at: string;
  requestId?: string;
  projectId?: string;
  actionId?: string;
  provider?: string;
  timestamp?: string;
  verification?: boolean | null;
}

export function mergeActivityEvent(previous: ActivityEvent[], event: ActivityEvent, limit = 10): ActivityEvent[] {
  const index = previous.findIndex(item => item.stage === event.stage && item.requestId === event.requestId);
  const updated = index < 0
    ? [...previous, event]
    : previous.map((item, itemIndex) => itemIndex === index ? event : item);
  return updated.slice(-limit);
}

export function activityMarkFor(status: ActivityStatus): string {
  switch (status) {
    case 'RUNNING': return '◌';
    case 'COMPLETED': return '✓';
    case 'FAILED': return '×';
    case 'QUEUED': return '○';
    case 'REQUIRES_APPROVAL': return '⚠';
  }
}
