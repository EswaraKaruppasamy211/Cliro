const PAGE_CHANNEL = 'cliro.chrome.bridge.page';
const EXTENSION_CHANNEL = 'cliro.chrome.bridge.extension';
const validActions = new Set([
  'getStatus',
  'closeCurrentChromeTab',
  'nextChromeTab',
  'previousChromeTab'
]);

window.addEventListener('message', event => {
  const message = event.data;
  if (
    event.source !== window ||
    event.origin !== window.location.origin ||
    !message ||
    typeof message !== 'object' ||
    message.channel !== PAGE_CHANNEL ||
    !validActions.has(message.action) ||
    typeof message.requestId !== 'string' ||
    !/^[a-zA-Z0-9-]{8,64}$/.test(message.requestId)
  ) return;

  chrome.runtime.sendMessage({
    requestId: message.requestId,
    action: message.action
  }).then(response => {
    window.postMessage({
      channel: EXTENSION_CHANNEL,
      requestId: message.requestId,
      result: response?.result || {
        type: 'ACTION_UNAVAILABLE',
        message: 'The Chrome extension did not return an operation result.',
        verified: false
      }
    }, window.location.origin);
  }).catch(() => {
    window.postMessage({
      channel: EXTENSION_CHANNEL,
      requestId: message.requestId,
      result: {
        type: 'ACTION_UNAVAILABLE',
        message: 'The local Chrome extension bridge is unavailable.',
        verified: false
      }
    }, window.location.origin);
  });
});
