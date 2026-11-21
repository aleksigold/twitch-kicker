import {
  DEFAULT_SETTINGS,
  DEFAULT_WHITELIST,
  RESERVED_ROUTES,
  STORAGE_KEYS,
  type Settings,
  type Whitelist,
} from './config';

function storageGet<T>(key: string, fallback: T): T {
  try {
    if (typeof GM_getValue === 'function') {
      const val = GM_getValue<T | undefined>(key, undefined);
      return val === undefined ? fallback : val;
    }
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function storageSet(key: string, value: unknown): void {
  try {
    if (typeof GM_setValue === 'function') {
      GM_setValue(key, value);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch (err) {
    console.error('[Twitch Kicker] Failed to save setting:', err);
  }
}

export function normalizeChannelInput(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let value = raw.trim().toLowerCase();
  // Allow pasting full Twitch or Kick URLs
  value = value.replace(/^https?:\/\/(www\.)?(twitch\.tv|kick\.com)\//i, '');
  value = value.replace(/^@/, '');
  value = value.split(/[/?#]/)[0] || '';
  return value.replace(/[^a-z0-9_-]/g, '');
}

export function normalizeWhitelist(obj: unknown): Whitelist {
  const out: Whitelist = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const twitchName = normalizeChannelInput(k);
    const kickName = normalizeChannelInput(typeof v === 'string' && v.trim() ? v : k);
    if (twitchName && kickName) {
      out[twitchName] = kickName;
    }
  }
  return out;
}

export function loadWhitelist(): Whitelist {
  const saved = storageGet<Whitelist | null>(STORAGE_KEYS.whitelist, null);
  if (saved === null) {
    const initial = normalizeWhitelist(DEFAULT_WHITELIST);
    storageSet(STORAGE_KEYS.whitelist, initial);
    return initial;
  }
  return normalizeWhitelist(saved);
}

export function saveWhitelist(whitelist: Whitelist): Whitelist {
  const clean = normalizeWhitelist(whitelist);
  storageSet(STORAGE_KEYS.whitelist, clean);
  return clean;
}

export function loadSettings(): Settings {
  const saved = storageGet<Partial<Settings> | null>(STORAGE_KEYS.settings, null);
  return {
    ...DEFAULT_SETTINGS,
    ...(saved && typeof saved === 'object' ? saved : {}),
  };
}

export function saveSettings(settings: Partial<Settings>): Settings {
  const rawVolume = typeof settings.volume === 'number' ? settings.volume : DEFAULT_SETTINGS.volume;
  const volume = Number.isFinite(rawVolume) ? Math.min(1, Math.max(0, rawVolume)) : 1;
  const clean: Settings = {
    autoplay: Boolean(settings.autoplay),
    muted: Boolean(settings.muted),
    showBadge: Boolean(settings.showBadge),
    detectLiveKick: settings.detectLiveKick !== false,
    preferDirectHls: settings.preferDirectHls !== false,
    volume,
  };
  storageSet(STORAGE_KEYS.settings, clean);
  return clean;
}

export function getTwitchChannelFromPathname(pathname: string): string | null {
  if (typeof pathname !== 'string') return null;
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return null;
  const candidate = segments[0].toLowerCase();
  if (RESERVED_ROUTES.has(candidate)) return null;
  if (!/^[a-z0-9_]{1,25}$/.test(candidate)) return null;
  return candidate;
}

export function buildKickEmbedUrl(kickChannel: string, settings: Settings): string {
  const params = new URLSearchParams({
    autoplay: String(Boolean(settings.autoplay)),
    muted: String(Boolean(settings.muted)),
  });
  return `https://player.kick.com/${encodeURIComponent(kickChannel)}?${params.toString()}`;
}
