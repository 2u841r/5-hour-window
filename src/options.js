import { getSettings } from './settings.js';

const form = document.getElementById('form');
const saved = document.getElementById('saved');
const PROVIDER_IDS = ['claude', 'cursor', 'zai'];

function flash(msg) {
  saved.textContent = msg;
  setTimeout(() => (saved.textContent = ''), 1500);
}

async function load() {
  const s = await getSettings();
  for (const id of PROVIDER_IDS) form[id].checked = s.enabled[id];
  form.claudeOrgId.value = s.claudeOrgId;
  form.zaiApiKey.value = s.zaiApiKey;
  form.intervalMin.value = s.intervalMin;
  form.notifyAt.value = s.notifyAt;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const settings = {
    enabled: Object.fromEntries(PROVIDER_IDS.map((id) => [id, form[id].checked])),
    claudeOrgId: form.claudeOrgId.value.trim(),
    zaiApiKey: form.zaiApiKey.value.trim(),
    intervalMin: Math.max(1, Number(form.intervalMin.value) || 15),
    notifyAt: Math.min(100, Math.max(0, Number(form.notifyAt.value) || 0)),
  };
  await chrome.storage.local.set({ settings });
  flash('Saved');
});

document.getElementById('clear').addEventListener('click', async () => {
  await chrome.storage.local.set({ history: [] });
  flash('History cleared');
});

load();
