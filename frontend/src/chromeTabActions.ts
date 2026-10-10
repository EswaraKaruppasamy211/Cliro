import { requestChromeBridgeStatus, requestChromeTabOperation } from './chromeBridge';
import type { ChromeBridgeStatus, ChromeTabOperation, ChromeTabResult } from './chromeBridge';
import type { GestureAction } from './vision/GestureRecognizer';

export interface ChromeTabActionServices {
  authorize(action: ChromeTabOperation): Promise<{ authorizationId: string }>;
  complete(
    authorizationId: string,
    action: ChromeTabOperation,
    result: ChromeTabResult
  ): Promise<ChromeTabResult>;
  execute?(action: ChromeTabOperation): Promise<ChromeTabResult>;
  getStatus?(): Promise<ChromeBridgeStatus>;
}

function unavailable(message: string): ChromeTabResult {
  return { type: 'ACTION_UNAVAILABLE', message, verified: false };
}

export function createChromeTabActions(services: ChromeTabActionServices) {
  const perform = async (action: ChromeTabOperation): Promise<ChromeTabResult> => {
    let authorizationId: string;
    try {
      ({ authorizationId } = await services.authorize(action));
    } catch (error) {
      return unavailable(`Chrome action permission check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!authorizationId) return unavailable('The backend did not authorize this Chrome tab action.');

    const result = await (services.execute || requestChromeTabOperation)(action);
    try {
      return await services.complete(authorizationId, action, result);
    } catch (error) {
      return {
        type: 'ACTION_FAILED',
        message: result.verified
          ? `The extension verified the tab operation, but CLIRO could not confirm it with the backend: ${error instanceof Error ? error.message : String(error)}`
          : `Chrome operation was not verified, and CLIRO could not record the result: ${error instanceof Error ? error.message : String(error)}`,
        verified: false
      };
    }
  };

  return {
    closeCurrentChromeTab: () => perform('closeCurrentChromeTab'),
    nextChromeTab: () => perform('nextChromeTab'),
    previousChromeTab: () => perform('previousChromeTab'),
    getChromeBridgeStatus: () => (services.getStatus || requestChromeBridgeStatus)()
  };
}

let actions = createChromeTabActions({
  async authorize() {
    throw new Error('Chrome action authorization has not been configured.');
  },
  async complete(_authorizationId, _action, result) {
    return result;
  }
});

export function configureChromeTabActions(services: ChromeTabActionServices): void {
  actions = createChromeTabActions(services);
}

export function closeCurrentChromeTab(): Promise<ChromeTabResult> {
  return actions.closeCurrentChromeTab();
}

export function nextChromeTab(): Promise<ChromeTabResult> {
  return actions.nextChromeTab();
}

export function previousChromeTab(): Promise<ChromeTabResult> {
  return actions.previousChromeTab();
}

export function getChromeBridgeStatus(): Promise<ChromeBridgeStatus> {
  return actions.getChromeBridgeStatus();
}

export function runChromeTabGesture(
  action: GestureAction,
  targetActions = actions
): Promise<ChromeTabResult> | null {
  if (action === 'CLOSE_CHROME_TAB') return targetActions.closeCurrentChromeTab();
  if (action === 'NEXT_CHROME_TAB') return targetActions.nextChromeTab();
  if (action === 'PREVIOUS_CHROME_TAB') return targetActions.previousChromeTab();
  return null;
}
