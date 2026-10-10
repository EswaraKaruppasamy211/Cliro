import { getChromeBridgeStatus, runChromeTabAction } from './tab-operations.mjs';

const allowedActions = new Set([
  'getStatus',
  'closeCurrentChromeTab',
  'nextChromeTab',
  'previousChromeTab'
]);

function isCliroPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(parsed.hostname) &&
      parsed.port === '5173';
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    sender.id !== chrome.runtime.id ||
    !sender.tab ||
    !isCliroPage(sender.tab.url || '') ||
    !message ||
    typeof message !== 'object' ||
    !allowedActions.has(message.action) ||
    typeof message.requestId !== 'string' ||
    !/^[a-zA-Z0-9-]{8,64}$/.test(message.requestId)
  ) {
    return false;
  }

  const operation = message.action === 'getStatus'
    ? getChromeBridgeStatus(chrome)
    : runChromeTabAction(message.action, chrome);

  operation.then(result => {
    sendResponse({ requestId: message.requestId, result });
  }).catch(error => {
    sendResponse({
      requestId: message.requestId,
      result: {
        type: 'ACTION_FAILED',
        message: error instanceof Error ? error.message : String(error),
        verified: false
      }
    });
  });
  return true;
});
