chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await chrome.storage.local.set({ sites: {} });
  }
});

// Receives messages from content scripts when the popup is closed.
// Persists pick results so the popup can restore state when reopened.
chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  handleMessage(msg).catch(console.error);
  return false;
});

async function handleMessage(msg) {
  const { setupState } = await chrome.storage.local.get('setupState');
  if (!setupState) return;

  if (msg.type === 'ELEMENT_PICKED') {
    await chrome.storage.local.set({
      setupState: { ...setupState, step: 'EDITING_PROMPT', selector: msg.selector },
    });
  }

  if (msg.type === 'PLACEHOLDER_PICKED') {
    await chrome.storage.local.set({
      setupState: {
        ...setupState,
        step: 'EDITING_PROMPT',
        latestPlaceholder: { name: msg.name, selector: msg.selector, text: msg.text },
      },
    });
  }

  if (msg.type === 'CANCEL_PICK') {
    if (msg.mode === 'placeholder') {
      await chrome.storage.local.set({ setupState: { ...setupState, step: 'EDITING_PROMPT' } });
    } else {
      await chrome.storage.local.remove('setupState');
    }
  }
}
