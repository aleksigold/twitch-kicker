export type Whitelist = Record<string, string>;

export interface Settings {
  autoplay: boolean;
  muted: boolean;
  showBadge: boolean;
  detectLiveKick: boolean;
  preferDirectHls: boolean;
  volume: number;
}

export interface KickLiveMatch {
  kickChannel: string;
  title: string | null;
  viewerCount: number | null;
  category: string | null;
}

export interface LiveCheckCacheEntry {
  checkedAt: number;
  match: KickLiveMatch | null;
}

export interface SilencedVideoEntry {
  onPlay: () => void;
  onVolumeChange: () => void;
  prevMuted: boolean;
}

export interface AppState {
  whitelist: Whitelist;
  settings: Settings;
  liveCheckCache: Map<string, LiveCheckCacheEntry>;
  inFlightChecks: Map<string, Promise<KickLiveMatch | null>>;
  disabledChannels: Set<string>;
  activeTwitchChannel: string | null;
  activeKickChannel: string | null;
  activeContainer: HTMLElement | null;
  activeContainerOriginalPosition: string | null;
  activePlayerTeardown: (() => void) | null;
  mountSeq: number;
  silencedVideos: Map<HTMLVideoElement, SilencedVideoEntry>;
  lastHref: string;
  syncTimer: ReturnType<typeof setTimeout> | null;
  lastSilenceCheck: number;
  modalKeyHandler: ((e: KeyboardEvent) => void) | null;
}

/**
 * Default whitelist mapping Twitch channel logins to Kick channel slugs.
 * Format: { '<twitch_username>': '<kick_username>' }
 * You can edit this directly OR manage the list anytime via the Tampermonkey
 * menu ("Manage Kick Whitelist") or the in-player settings button.
 */
export const DEFAULT_WHITELIST: Whitelist = {
  // Example entry (uncomment or add your own):
  // sick_nerd: 'sick_nerd',
};

export const DEFAULT_SETTINGS: Settings = {
  autoplay: true,
  muted: false,
  showBadge: true,
  detectLiveKick: true,
  preferDirectHls: true,
  volume: 1,
};

export const STORAGE_KEYS = {
  whitelist: "tk_whitelist_v1",
  settings: "tk_settings_v1",
} as const;

export const LIVE_CHECK_CACHE_TTL_MS = 2 * 60 * 1000;
export const LIVE_CHECK_TIMEOUT_MS = 6000;

export const RESERVED_ROUTES = new Set<string>([
  "directory",
  "videos",
  "clip",
  "clips",
  "settings",
  "subscriptions",
  "inventory",
  "drops",
  "wallet",
  "following",
  "downloads",
  "turbo",
  "p",
  "search",
  "moderator",
  "u",
  "popout",
  "embed",
  "login",
  "signup",
  "activate",
  "friends",
  "messages",
  "payments",
  "prime",
  "products",
  "redeem",
  "store",
  "team",
  "teams",
  "user",
  "bits",
  "broadcast",
  "creatorcamp",
  "dashboard",
  "jobs",
  "legal",
  "security",
  "subs",
  "tickets",
  "annual-recap",
  "recap",
]);

export const IDS = {
  overlay: "tk-kick-overlay",
  controlsBar: "tk-controls-bar",
  restoreBadge: "tk-restore-badge",
  suggestionBanner: "tk-suggestion-banner",
  modalBackdrop: "tk-modal-backdrop",
} as const;
