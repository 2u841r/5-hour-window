import { PROVIDERS, ORIGINS, runProvider } from './providers.js';
import { getSettings } from './settings.js';

const HISTORY_DAYS = 14;
const ALARM = 'refresh';

// Requests from the service worker carry a chrome-extension:// Origin, which
// some APIs reject as CSRF. Rewrite Origin/Referer for non-tab requests only.
async function installHeaderRules() {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const rules = Object.entries(ORIGINS).map(([domain, origin], i) => ({
    id: i + 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'origin', operation: 'set', value: origin },
        { header: 'referer', operation: 'set', value: `${origin}/` },
      ],
    },
    condition: {
      requestDomains: [domain],
      tabIds: [chrome.tabs.TAB_ID_NONE],
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  }));
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: rules,
  });
}

async function scheduleAlarm() {
  const { intervalMin } = await getSettings();
  await chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, intervalMin) });
}

function badgeColor(p) {
  if (p >= 90) return '#d9534f';
  if (p >= 70) return '#e0a030';
  return '#3a8f5c';
}

async function updateBadge(snapshots) {
  // Highest weekly meter across providers; fall back to highest of anything.
  let best = null;
  for (const snap of Object.values(snapshots)) {
    if (!snap?.ok) continue;
    for (const m of snap.meters) {
      const score = (m.weekly ? 1000 : 0) + m.percent;
      if (!best || score > best.score) best = { score, percent: m.percent };
    }
  }
  if (!best) {
    const anyError = Object.values(snapshots).some((s) => s && !s.ok);
    await chrome.action.setBadgeText({ text: anyError ? '!' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#888' });
    return;
  }
  await chrome.action.setBadgeText({ text: `${Math.round(best.percent)}` });
  await chrome.action.setBadgeBackgroundColor({ color: badgeColor(best.percent) });
}

async function maybeNotify(id, snap, notifyAt) {
  if (!snap.ok || !notifyAt) return;
  const { notified = {} } = await chrome.storage.local.get('notified');
  let changed = false;
  for (const m of snap.meters) {
    // One notification per meter per reset window.
    const key = `${id}.${m.id}.${m.resetsAt ?? ''}`;
    if (m.percent >= notifyAt && !notified[key]) {
      notified[key] = Date.now();
      changed = true;
      chrome.notifications.create(key, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/128.png'),
        title: `${PROVIDERS[id].name}: ${m.label} at ${Math.round(m.percent)}%`,
        message: 'You crossed your usage alert threshold.',
      });
    }
  }
  if (changed) {
    const cutoff = Date.now() - 30 * 864e5;
    for (const k of Object.keys(notified)) if (notified[k] < cutoff) delete notified[k];
    await chrome.storage.local.set({ notified });
  }
}

let inflight = null;

async function refreshAll() {
  if (inflight) return inflight;
  inflight = (async () => {
    const settings = await getSettings();
    const ids = Object.keys(PROVIDERS).filter((id) => settings.enabled[id]);
    const results = await Promise.all(ids.map((id) => runProvider(id, settings)));

    const { snapshots: prev = {}, history = [] } = await chrome.storage.local.get([
      'snapshots',
      'history',
    ]);
    const snapshots = {};
    const point = { t: Date.now() };
    ids.forEach((id, i) => {
      const snap = results[i];
      // Keep last good data visible on transient failure.
      snapshots[id] = snap.ok ? snap : { ...prev[id], ...snap, meters: prev[id]?.meters || [] };
      if (snap.ok) {
        point[id] = Object.fromEntries(snap.meters.map((m) => [m.id, m.percent]));
      }
    });

    const cutoff = Date.now() - HISTORY_DAYS * 864e5;
    const nextHistory = history.filter((p) => p.t >= cutoff);
    if (Object.keys(point).length > 1) nextHistory.push(point);

    await chrome.storage.local.set({ snapshots, history: nextHistory, lastRun: Date.now() });
    await updateBadge(snapshots);
    for (const id of ids) await maybeNotify(id, results[ids.indexOf(id)], settings.notifyAt);
    return snapshots;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function init() {
  await installHeaderRules();
  await scheduleAlarm();
  await refreshAll();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== ALARM) return;
  // Session rules can be dropped when the worker restarts after an update.
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  if (!rules.length) await installHeaderRules();
  refreshAll();
});

chrome.notifications.onClicked.addListener((key) => {
  const id = key.split('.')[0];
  if (PROVIDERS[id]) chrome.tabs.create({ url: PROVIDERS[id].home });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    scheduleAlarm();
    refreshAll();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === 'zaiToken' && sender.url?.startsWith('https://z.ai/')) {
    chrome.storage.local.get('zaiToken').then(({ zaiToken }) => {
      if (zaiToken === msg.token) return;
      chrome.storage.local.set({ zaiToken: msg.token }).then(refreshAll);
    });
    return;
  }
  if (msg?.type === 'refresh') {
    installHeaderRules()
      .then(refreshAll)
      .then(reply, (e) => reply({ error: String(e) }));
    return true;
  }
});
