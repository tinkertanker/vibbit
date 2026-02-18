// Background service worker for bit:vibe extension
// Handles toolbar icon clicks to show/hide the panel

const MAKECODE_HOSTS = [
  'makecode.microbit.org',
  'arcade.makecode.com',
  'maker.makecode.com'
];

function isMakeCodeUrl(url) {
  try {
    const parsed = new URL(url);
    return MAKECODE_HOSTS.some(host => parsed.hostname === host);
  } catch {
    return false;
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  // Restrict to MakeCode hosts only
  if (!tab.url || !isMakeCodeUrl(tab.url)) {
    return;
  }

  // Check FAB / panel state on the page
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const panel = document.getElementById('bitvibe-panel');
      const fab = document.getElementById('bitvibe-fab');
      return {
        fabExists: fab !== null,
        panelExists: panel !== null,
        panelVisible: panel ? panel.style.display !== 'none' : false,
        guardSet: !!window.__bitvibeStrict
      };
    }
  });

  const { fabExists, panelExists, panelVisible, guardSet } = results[0]?.result || {};

  if (panelExists && panelVisible) {
    // Panel is open – close it, show FAB
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const panel = document.getElementById('bitvibe-panel');
        const fab = document.getElementById('bitvibe-fab');
        if (panel) { panel.style.transform = 'scale(0)'; panel.style.opacity = '0'; panel.style.display = 'none'; }
        if (fab) fab.style.display = 'flex';
      }
    });
  } else if (panelExists || fabExists) {
    // FAB visible or panel hidden – open the panel, hide FAB
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const panel = document.getElementById('bitvibe-panel');
        const fab = document.getElementById('bitvibe-fab');
        if (panel) { panel.style.transform = 'scale(1)'; panel.style.opacity = '1'; panel.style.display = 'flex'; }
        if (fab) fab.style.display = 'none';
      }
    });
  } else if (guardSet) {
    // Guard set but DOM removed – reset and re-inject
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { window.__bitvibeStrict = 0; }
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content-script.js']
    });
    // Panel starts hidden; open it since user explicitly clicked the icon
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const panel = document.getElementById('bitvibe-panel');
        const fab = document.getElementById('bitvibe-fab');
        if (panel) { panel.style.transform = 'scale(1)'; panel.style.opacity = '1'; panel.style.display = 'flex'; }
        if (fab) fab.style.display = 'none';
      }
    });
  } else {
    // First time – inject the content script
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content-script.js']
    });
    // Panel starts hidden; open it since user explicitly clicked the icon
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const panel = document.getElementById('bitvibe-panel');
        const fab = document.getElementById('bitvibe-fab');
        if (panel) { panel.style.transform = 'scale(1)'; panel.style.opacity = '1'; panel.style.display = 'flex'; }
        if (fab) fab.style.display = 'none';
      }
    });
  }
});
