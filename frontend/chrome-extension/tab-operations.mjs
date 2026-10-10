export const chromeTabActions = Object.freeze([
  'closeCurrentChromeTab',
  'nextChromeTab',
  'previousChromeTab'
]);

const protectedHosts = new Set([
  'chrome.google.com',
  'chromewebstore.google.com'
]);

export function isEligibleChromeTab(tab) {
  if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) return false;
  if (typeof tab.url !== 'string') return false;
  try {
    const url = new URL(tab.url);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      !protectedHosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function unavailable(message) {
  return { type: 'ACTION_UNAVAILABLE', message, verified: false };
}

function failed(message) {
  return { type: 'ACTION_FAILED', message, verified: false };
}

async function getFocusedWindow(chromeApi) {
  const focused = await chromeApi.windows.getLastFocused({ populate: false });
  return focused?.id !== undefined && focused.type === 'normal' ? focused : null;
}

export async function getChromeBridgeStatus(chromeApi) {
  try {
    const focused = await getFocusedWindow(chromeApi);
    if (!focused) {
      return { connected: true, chromeWindowAvailable: false, eligibleTabCount: 0 };
    }
    const tabs = await chromeApi.tabs.query({ windowId: focused.id });
    return {
      connected: true,
      chromeWindowAvailable: true,
      eligibleTabCount: tabs.filter(isEligibleChromeTab).length
    };
  } catch {
    return { connected: false, chromeWindowAvailable: false, eligibleTabCount: 0 };
  }
}

export async function runChromeTabAction(action, chromeApi) {
  if (!chromeTabActions.includes(action)) return unavailable('Unsupported Chrome tab action.');

  let focusedWindow;
  let tabs;
  try {
    focusedWindow = await getFocusedWindow(chromeApi);
    if (!focusedWindow) return unavailable('No normal Chrome window is available.');
    tabs = await chromeApi.tabs.query({ windowId: focusedWindow.id });
  } catch (error) {
    return unavailable(`Chrome tab access is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const activeTab = tabs.find(tab => tab.active === true && isEligibleChromeTab(tab));
  if (!activeTab) return unavailable('The active Chrome tab is protected or no eligible tab is available.');

  if (action === 'closeCurrentChromeTab') {
    try {
      await chromeApi.tabs.remove(activeTab.id);
      try {
        await chromeApi.tabs.get(activeTab.id);
        return failed('Chrome reported the active tab still open after the close request.');
      } catch {
        return {
          type: 'ACTION_SUCCESS',
          message: 'Chrome closed the active tab and confirmed it is no longer open.',
          verified: true
        };
      }
    } catch (error) {
      return failed(`Chrome could not close the active tab: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const eligibleTabs = tabs.filter(isEligibleChromeTab).sort((first, second) => first.index - second.index);
  if (eligibleTabs.length < 2) return unavailable('At least two eligible Chrome tabs are required to switch tabs.');
  const currentIndex = eligibleTabs.findIndex(tab => tab.id === activeTab.id);
  if (currentIndex < 0) return unavailable('The active Chrome tab is not eligible for tab switching.');
  const offset = action === 'nextChromeTab' ? 1 : -1;
  const target = eligibleTabs[(currentIndex + offset + eligibleTabs.length) % eligibleTabs.length];

  try {
    await chromeApi.tabs.update(target.id, { active: true });
    const activeTabs = await chromeApi.tabs.query({ windowId: focusedWindow.id, active: true });
    if (activeTabs.length !== 1 || activeTabs[0].id !== target.id || target.id === activeTab.id) {
      return failed('Chrome did not confirm that the requested adjacent tab became active.');
    }
    return {
      type: 'ACTION_SUCCESS',
      message: action === 'nextChromeTab'
        ? 'Chrome activated the next eligible tab and confirmed its active tab ID changed.'
        : 'Chrome activated the previous eligible tab and confirmed its active tab ID changed.',
      verified: true
    };
  } catch (error) {
    return failed(`Chrome could not activate the requested tab: ${error instanceof Error ? error.message : String(error)}`);
  }
}
