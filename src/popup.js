import { PROVIDERS } from './providers.js';
import { getSettings } from './settings.js';
import { fmtDate, fmtIn, fmtAgo, level } from './format.js';

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) n.append(k);
  return n;
}

// Usage over the current window, drawn from stored history points.
function sparkline(points) {
  if (points.length < 2) return null;
  const W = 260, H = 28;
  const t0 = points[0].t, t1 = points.at(-1).t || t0 + 1;
  const xy = points.map((p) => [
    ((p.t - t0) / (t1 - t0 || 1)) * W,
    H - (p.v / 100) * (H - 2) - 1,
  ]);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'spark');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M' + xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L'));
  svg.append(path);
  return svg;
}

function meterRow(id, m, history) {
  const pct = Math.round(m.percent * 10) / 10;
  const reset = m.resetsAt
    ? `resets in ${fmtIn(m.resetsAt)} (${fmtDate(m.resetsAt)})`
    : '';
  let spark = null;
  if (m.weekly) {
    const since = m.resetsAt ? m.resetsAt - 7 * 864e5 : 0;
    const pts = history
      .filter((p) => p.t >= since && p[id]?.[m.id] != null)
      .map((p) => ({ t: p.t, v: p[id][m.id] }));
    spark = sparkline(pts);
  }
  return el(
    'div',
    { class: 'meter' },
    el('div', { class: 'meter-head' }, el('span', {}, m.label), el('strong', {}, `${pct}%`)),
    el(
      'div',
      { class: 'bar' },
      el('div', { class: `fill ${level(m.percent)}`, style: `width:${Math.min(100, m.percent)}%` }),
    ),
    el('div', { class: 'meta' }, [reset, m.detail].filter(Boolean).join(' / ')),
    spark,
  );
}

function card(id, snap, history) {
  const p = PROVIDERS[id];
  const head = el(
    'div',
    { class: 'card-head' },
    el('span', { class: 'grip', title: 'Drag to reorder', 'aria-hidden': 'true' }, '\u283F'),
    el('a', { href: p.home, target: '_blank' }, p.name),
    snap?.plan ? el('span', { class: 'plan' }, snap.plan) : null,
  );
  const body = [];
  if (!snap) {
    body.push(el('div', { class: 'meta' }, 'Loading...'));
  } else {
    if (!snap.ok) {
      body.push(
        el(
          'div',
          { class: 'error' },
          snap.needsAuth
            ? el(
                'span',
                {},
                `Not logged in (${snap.error}). `,
                el('a', { href: p.home, target: '_blank' }, `Open ${p.name}`),
                id === 'zai' ? ' once while logged in, or set an API key in Settings.' : '',
              )
            : `Error: ${snap.error}`,
        ),
      );
    }
    for (const m of snap.meters || []) body.push(meterRow(id, m, history));
    if (snap.extra?.breakdown) body.push(el('div', { class: 'meta' }, `This week: ${snap.extra.breakdown}`));
    if (snap.extra?.note) body.push(el('div', { class: 'meta' }, snap.extra.note));
  }
  return el('section', { class: `card${snap && !snap.ok ? ' stale' : ''}`, 'data-id': id }, head, body);
}

// Saved under its own key so reordering does not trigger a settings refresh.
function sortByOrder(ids, order = []) {
  const pos = (id) => (order.includes(id) ? order.indexOf(id) : order.length + ids.indexOf(id));
  return [...ids].sort((a, b) => pos(a) - pos(b));
}

let dragging = null;
let pendingRender = false;

async function render() {
  if (dragging) {
    pendingRender = true;
    return;
  }
  const settings = await getSettings();
  const { snapshots = {}, history = [], lastRun, order } = await chrome.storage.local.get([
    'snapshots',
    'history',
    'lastRun',
    'order',
  ]);
  const ids = sortByOrder(
    Object.keys(PROVIDERS).filter((id) => settings.enabled[id]),
    order,
  );
  list.replaceChildren(...ids.map((id) => card(id, snapshots[id], history)));
  if (!ids.length) list.append(el('p', { class: 'meta' }, 'No providers enabled. Open Settings.'));
  $('#status').textContent = lastRun ? `Updated ${fmtAgo(lastRun)}` : '';
}

// ---------- drag to reorder ----------
// Cards only become draggable while the grip is held, so text and links
// inside a card still behave normally.
const list = $('#list');

list.addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.grip') && e.target.closest('.card');
  if (card) card.draggable = true;
});

list.addEventListener('dragstart', (e) => {
  const card = e.target.closest?.('.card');
  if (!card?.draggable) return;
  dragging = card;
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', card.dataset.id);
});

list.addEventListener('dragover', (e) => {
  if (!dragging) return;
  e.preventDefault();
  const over = e.target.closest('.card');
  if (!over || over === dragging) return;
  const { top, height } = over.getBoundingClientRect();
  const after = e.clientY > top + height / 2;
  over[after ? 'after' : 'before'](dragging);
});

list.addEventListener('drop', (e) => e.preventDefault());

list.addEventListener('dragend', async () => {
  if (!dragging) return;
  dragging.classList.remove('dragging');
  dragging.draggable = false;
  dragging = null;
  const visible = [...list.querySelectorAll('.card')].map((c) => c.dataset.id);
  const { order = [] } = await chrome.storage.local.get('order');
  // Keep positions of disabled providers by appending them after visible ones.
  const next = [...visible, ...order.filter((id) => !visible.includes(id))];
  await chrome.storage.local.set({ order: next });
  if (pendingRender) {
    pendingRender = false;
    render();
  }
});

// Release draggable if the grip is pressed but no drag starts.
document.addEventListener('pointerup', () => {
  if (!dragging) list.querySelectorAll('.card[draggable="true"]').forEach((c) => (c.draggable = false));
});

$('#refresh').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = '...';
  await chrome.runtime.sendMessage({ type: 'refresh' });
  e.target.disabled = false;
  e.target.textContent = 'Refresh';
});
$('#settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && (c.snapshots || c.settings)) render();
});

render();
// Stale data on open: refresh in the background.
chrome.storage.local.get('lastRun').then(({ lastRun }) => {
  if (!lastRun || Date.now() - lastRun > 60_000) chrome.runtime.sendMessage({ type: 'refresh' });
});
