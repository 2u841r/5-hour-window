// Content script on z.ai: the dashboard keeps its session JWT in localStorage
// and sends it as a Bearer header, so cookies alone do not authenticate the
// quota API. Hand the token to the extension (stays in chrome.storage.local).
(() => {
  const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;

  function findToken() {
    const hits = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const val = localStorage.getItem(key) || '';
      const m = val.match(JWT);
      if (m) hits.push({ key, token: m[0] });
    }
    // Only the open-platform token is accepted by api.z.ai; the website
    // token ("z-ai-website-token") gets 401.
    const rank = (k) => (/open-platform-token/i.test(k) ? 2 : /token/i.test(k) && !/website/i.test(k) ? 1 : 0);
    hits.sort((a, b) => rank(b.key) - rank(a.key));
    return hits[0]?.token || null;
  }

  function send() {
    const token = findToken();
    if (token) chrome.runtime.sendMessage({ type: 'zaiToken', token }).catch(() => {});
  }

  send();
  // Catch logins that happen after page load.
  setTimeout(send, 5000);
})();
