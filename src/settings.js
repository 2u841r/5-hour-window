export const DEFAULTS = {
  enabled: { claude: true, cursor: true, zai: true },
  intervalMin: 15,
  notifyAt: 80,
  claudeOrgId: '',
  zaiApiKey: '',
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return {
    ...DEFAULTS,
    ...settings,
    enabled: { ...DEFAULTS.enabled, ...settings?.enabled },
  };
}
