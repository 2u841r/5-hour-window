// Each provider returns a normalized snapshot:
// { ok, plan?, meters: [{ id, label, percent, resetsAt, weekly?, detail? }], extra?, error?, needsAuth? }
// percent is 0..100, resetsAt is epoch ms (or null).

class AuthError extends Error {}

async function getJson(url, init = {}) {
  const res = await fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    ...init,
    headers: { accept: 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = JSON.parse(text);
      const detail = body.msg || body.message || body.error?.message || body.error;
      if (typeof detail === 'string') msg += `: ${detail}`;
    } catch {}
    throw res.status === 401 || res.status === 403 ? new AuthError(msg) : new Error(msg);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Response was not JSON (blocked or logged out?)');
  }
}

const toMs = (v) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v) || null);
const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));

// ---------- Claude ----------

async function resolveClaudeOrg(settings) {
  if (settings.claudeOrgId) return settings.claudeOrgId;
  const cookie = await chrome.cookies.get({ url: 'https://claude.ai', name: 'lastActiveOrg' });
  if (cookie?.value) return cookie.value;
  const orgs = await getJson('https://claude.ai/api/organizations');
  const org = orgs.find((o) => (o.capabilities || []).includes('chat')) || orgs[0];
  if (!org) throw new AuthError('No organization found');
  return org.uuid;
}

const CLAUDE_SCOPED = {
  seven_day_opus: 'Weekly (Opus)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_oauth_apps: 'Weekly (OAuth apps)',
  seven_day_cowork: 'Weekly (Cowork)',
};

async function fetchClaude(settings) {
  const org = await resolveClaudeOrg(settings);
  const d = await getJson(`https://claude.ai/api/organizations/${org}/usage`, {
    headers: { 'anthropic-client-platform': 'web_claude_ai' },
  });
  const meters = [];
  if (d.five_hour) {
    meters.push({
      id: 'five_hour',
      label: 'Session (5h)',
      percent: clamp(d.five_hour.utilization),
      resetsAt: toMs(d.five_hour.resets_at),
    });
  }
  if (d.seven_day) {
    meters.push({
      id: 'seven_day',
      label: 'Weekly',
      percent: clamp(d.seven_day.utilization),
      resetsAt: toMs(d.seven_day.resets_at),
      weekly: true,
    });
  }
  for (const [key, label] of Object.entries(CLAUDE_SCOPED)) {
    if (d[key]?.utilization != null) {
      meters.push({
        id: key,
        label,
        percent: clamp(d[key].utilization),
        resetsAt: toMs(d[key].resets_at),
        weekly: true,
      });
    }
  }
  const extra = {};
  if (d.seven_day_breakdown?.rows?.length) {
    extra.breakdown = d.seven_day_breakdown.rows
      .filter((r) => r.percent > 0)
      .map((r) => `${r.display_name} ${r.percent}%`)
      .join(', ');
  }
  if (d.extra_usage?.is_enabled) {
    const div = 10 ** (d.extra_usage.decimal_places ?? 2);
    extra.note = `Extra credits: ${(d.extra_usage.used_credits / div).toFixed(2)} / ${(d.extra_usage.monthly_limit / div).toFixed(2)} ${d.extra_usage.currency}`;
  }
  return { ok: true, meters, extra };
}

// ---------- Cursor ----------

const cursorPost = (path) =>
  getJson(`https://cursor.com/api/dashboard/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

async function fetchCursor() {
  const [planRes, sandRes] = await Promise.allSettled([
    cursorPost('get-current-period-usage'),
    cursorPost('get-sand-usage-status'),
  ]);
  if (planRes.status === 'rejected' && sandRes.status === 'rejected') throw planRes.reason;

  const meters = [];
  const extra = {};
  let plan = '';

  if (planRes.status === 'fulfilled') {
    const d = planRes.value;
    const u = d.planUsage || {};
    const resetsAt = toMs(Number(d.billingCycleEnd));
    // Labels match cursor.com/dashboard.
    if (u.autoPercentUsed != null) {
      meters.push({ id: 'plan_auto', label: 'Cursor Models (monthly)', percent: clamp(u.autoPercentUsed), resetsAt });
    }
    if (u.apiPercentUsed != null) {
      meters.push({ id: 'plan_api', label: 'Other Models (monthly)', percent: clamp(u.apiPercentUsed), resetsAt });
    }
    if (u.totalSpend != null) {
      extra.note = `Spend: ${usd(u.totalSpend)} used, ${usd(u.limit)} included${u.bonusSpend ? ` + ${usd(u.bonusSpend)} bonus` : ''}`;
    }
  }

  if (sandRes.status === 'fulfilled') {
    const d = sandRes.value;
    plan = [d.cursorPlanName, d.grokPlanLabel].filter(Boolean).join(' / ');
    if (d.hasNonZeroIncludedLimit !== false) {
      meters.push({
        id: 'period',
        label: `${d.grokPlanLabel || 'Grok'} (weekly)`,
        percent: clamp(d.usagePercent),
        resetsAt: toMs(d.nextResetTimestampUtc),
        weekly: true,
        detail: d.hasAvailableUsage === false ? 'No usage available' : null,
      });
    }
  }

  return { ok: true, plan, meters, extra };
}

// ---------- Z.ai ----------

const ZAI_UNITS = { 1: 'second', 2: 'minute', 3: 'hour', 4: 'day', 5: 'month', 6: 'week' };

function zaiWindow(unit, number) {
  const u = ZAI_UNITS[unit];
  if (!u) return '';
  if (u === 'hour') return `${number}h`;
  if (u === 'month' && number === 1) return 'monthly';
  if (u === 'week' && number === 1) return 'weekly';
  return `${number} ${u}${number > 1 ? 's' : ''}`;
}

const looksLikeJwt = (v) => /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v || '');

// Auth candidates in priority order: manual API key, dashboard session token
// captured by the z.ai content script, JWT-looking cookie, plain cookies.
async function zaiAuthCandidates(settings) {
  const out = [];
  if (settings.zaiApiKey) out.push(settings.zaiApiKey.trim());
  const { zaiToken } = await chrome.storage.local.get('zaiToken');
  if (zaiToken) out.push(`Bearer ${zaiToken}`);
  const cookies = await chrome.cookies.getAll({ domain: 'z.ai' });
  for (const c of cookies) {
    if (/token/i.test(c.name) && looksLikeJwt(c.value)) out.push(`Bearer ${c.value}`);
  }
  out.push(null);
  return [...new Set(out)];
}

async function zaiRequest(auth) {
  const headers = { 'accept-language': 'en-US,en' };
  if (auth) headers.authorization = auth;
  const d = await getJson('https://api.z.ai/api/monitor/usage/quota/limit', { headers });
  if (d.success === false || (d.code && d.code !== 200)) {
    const msg = d.msg || `code ${d.code}`;
    if (d.code === 401 || d.code === 1001 || /auth|token|login/i.test(msg)) throw new AuthError(msg);
    throw new Error(msg);
  }
  return d;
}

async function fetchZai(settings) {
  let d, lastErr;
  for (const auth of await zaiAuthCandidates(settings)) {
    try {
      d = await zaiRequest(auth);
      break;
    } catch (e) {
      lastErr = e;
      if (!(e instanceof AuthError)) throw e;
    }
  }
  if (!d) throw lastErr;
  const meters = (d.data?.limits || []).map((l) => {
    const win = zaiWindow(l.unit, l.number);
    const isTokens = l.type === 'TOKENS_LIMIT';
    const base = isTokens ? 'Tokens' : l.type === 'TIME_LIMIT' ? 'Tool calls' : l.type;
    return {
      id: `${l.type}_${l.unit}_${l.number}`,
      label: win ? `${base} (${win})` : base,
      percent: clamp(l.percentage),
      resetsAt: toMs(l.nextResetTime),
      weekly: ZAI_UNITS[l.unit] === 'week' || (ZAI_UNITS[l.unit] === 'day' && l.number === 7),
      detail: l.usage != null ? `${l.currentValue ?? 0} / ${l.usage} used` : null,
    };
  });
  return { ok: true, plan: d.data?.level, meters };
}

// ---------- registry ----------

export const PROVIDERS = {
  claude: { name: 'Claude', home: 'https://claude.ai/settings/usage', run: fetchClaude },
  cursor: { name: 'Cursor', home: 'https://cursor.com/dashboard', run: fetchCursor },
  zai: { name: 'Z.ai', home: 'https://z.ai/manage-apikey/subscription', run: fetchZai },
};

// Origin/Referer each API expects, applied via DNR to extension-initiated requests.
export const ORIGINS = {
  'claude.ai': 'https://claude.ai',
  'cursor.com': 'https://cursor.com',
  'api.z.ai': 'https://z.ai',
};

export async function runProvider(id, settings) {
  try {
    return { ...(await PROVIDERS[id].run(settings)), fetchedAt: Date.now() };
  } catch (e) {
    return {
      ok: false,
      needsAuth: e instanceof AuthError,
      error: e.message || String(e),
      fetchedAt: Date.now(),
    };
  }
}
