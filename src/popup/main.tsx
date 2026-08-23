import { createRoot } from 'react-dom/client';
import { readCount } from '../background/counter';
import { getSettings, saveSettings } from '../shared/settings';
import { readSyncError } from '../shared/sync-error';
import { App, type PopupApi } from './App';
import { pageHost } from './host';

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

const api: PopupApi = {
  getSettings: () => getSettings(chrome.storage.local),
  saveSettings: (patch) => saveSettings(chrome.storage.local, patch),
  getActiveHost: async () => pageHost((await activeTab())?.url ?? ''),
  getBlockedCount: async () => {
    const id = (await activeTab())?.id;
    return id === undefined ? 0 : readCount(id, chrome.storage.session);
  },
  getSyncError: () => readSyncError(chrome.storage.session),
};

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(<App api={api} />);
}
