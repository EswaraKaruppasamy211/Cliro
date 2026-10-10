export type ChromeTabOperation = 'closeCurrentChromeTab' | 'nextChromeTab' | 'previousChromeTab';
export type ChromeTabResultType = 'ACTION_SUCCESS' | 'ACTION_FAILED' | 'ACTION_UNAVAILABLE';

export interface ChromeTabResult {
  type: ChromeTabResultType;
  message: string;
  verified: boolean;
}

export interface ChromeBridgeStatus {
  connected: boolean;
  chromeWindowAvailable: boolean;
  eligibleTabCount: number;
}

type ChromeBridgeAction = ChromeTabOperation | 'getStatus';

const PAGE_CHANNEL = 'cliro.chrome.bridge.page';
const EXTENSION_CHANNEL = 'cliro.chrome.bridge.extension';

function isChromeTabResult(value: unknown): value is ChromeTabResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<ChromeTabResult>;
  return ['ACTION_SUCCESS', 'ACTION_FAILED', 'ACTION_UNAVAILABLE'].includes(result.type || '') &&
    typeof result.message === 'string' &&
    typeof result.verified === 'boolean';
}

function requestExtension(action: ChromeBridgeAction, timeoutMs = 2_500): Promise<unknown> {
  if (typeof window === 'undefined' || !window.crypto?.randomUUID) {
    return Promise.reject(new Error('The local Chrome bridge requires a supported browser context.'));
  }
  const requestId = window.crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('Chrome extension bridge did not respond.'));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      if (
        event.source !== window ||
        event.origin !== window.location.origin ||
        !message ||
        typeof message !== 'object' ||
        message.channel !== EXTENSION_CHANNEL ||
        message.requestId !== requestId
      ) return;
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      resolve(message.result);
    };
    window.addEventListener('message', onMessage);
    window.postMessage({ channel: PAGE_CHANNEL, requestId, action }, window.location.origin);
  });
}

export async function requestChromeBridgeStatus(): Promise<ChromeBridgeStatus> {
  try {
    const result = await requestExtension('getStatus');
    if (
      result && typeof result === 'object' &&
      'connected' in result && result.connected === true &&
      'chromeWindowAvailable' in result && typeof result.chromeWindowAvailable === 'boolean' &&
      'eligibleTabCount' in result && typeof result.eligibleTabCount === 'number'
    ) {
      return {
        connected: true,
        chromeWindowAvailable: result.chromeWindowAvailable,
        eligibleTabCount: result.eligibleTabCount
      };
    }
    return { connected: false, chromeWindowAvailable: false, eligibleTabCount: 0 };
  } catch {
    return { connected: false, chromeWindowAvailable: false, eligibleTabCount: 0 };
  }
}

export async function requestChromeTabOperation(action: ChromeTabOperation): Promise<ChromeTabResult> {
  try {
    const result = await requestExtension(action);
    return isChromeTabResult(result)
      ? result
      : { type: 'ACTION_UNAVAILABLE', message: 'The Chrome extension returned an invalid response.', verified: false };
  } catch (error) {
    return {
      type: 'ACTION_UNAVAILABLE',
      message: error instanceof Error ? error.message : String(error),
      verified: false
    };
  }
}
