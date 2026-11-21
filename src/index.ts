import { IDS, LIVE_CHECK_CACHE_TTL_MS, type AppState } from "./config";
import { findLiveMatchingKickStream } from "./kick-api";
import {
  findActionBarContainer,
  findPlayerContainer,
  mountControlsBar,
  mountKickOverlay,
  mountRestoreBadge,
  removeControlsBar,
  removeRestoreBadge,
  silenceTwitchVideos,
  unmountKickOverlay,
  type PlayerCallbacks,
} from "./player";
import {
  getTwitchChannelFromPathname,
  loadSettings,
  loadWhitelist,
  normalizeChannelInput,
  saveWhitelist,
} from "./storage";
import { injectStyles } from "./styles";
import {
  closeWhitelistModal,
  mountSuggestionBanner,
  openWhitelistModal,
  removeSuggestionBanner,
} from "./ui";

const state: AppState = {
  whitelist: loadWhitelist(),
  settings: loadSettings(),
  liveCheckCache: new Map(),
  inFlightChecks: new Map(),
  disabledChannels: new Set<string>(),
  activeTwitchChannel: null,
  activeKickChannel: null,
  activeContainer: null,
  activeContainerOriginalPosition: null,
  activePlayerTeardown: null,
  mountSeq: 0,
  silencedVideos: new Map(),
  lastHref: location.href,
  syncTimer: null,
  lastSilenceCheck: 0,
  modalKeyHandler: null,
};

const playerCallbacks: PlayerCallbacks = {
  onSwitchToTwitch(twitchChannel: string): void {
    state.disabledChannels.add(twitchChannel);
    unmountKickOverlay(state, { resumeTwitch: true });
    syncPlayer();
  },
  onSwitchToKick(twitchChannel: string): void {
    state.disabledChannels.delete(twitchChannel);
    syncPlayer();
  },
  onOpenWhitelist(): void {
    openWhitelistModal(state, syncPlayer);
  },
};

function maybeSuggestKickForChannel(twitchChannel: string): void {
  if (!state.settings.detectLiveKick) {
    removeSuggestionBanner();
    return;
  }

  const existing = document.getElementById(IDS.suggestionBanner);
  if (existing && existing.dataset.twitchChannel !== twitchChannel) {
    removeSuggestionBanner();
  }

  void findLiveMatchingKickStream(state, twitchChannel).then((match) => {
    if (
      !match ||
      getTwitchChannelFromPathname(location.pathname) !== twitchChannel ||
      state.whitelist[twitchChannel] ||
      !state.settings.detectLiveKick
    ) {
      return;
    }

    const actionBar = findActionBarContainer();
    if (!actionBar) return;

    mountSuggestionBanner(state, actionBar, twitchChannel, match, syncPlayer);
  });
}

function syncPlayer(): void {
  const twitchChannel = getTwitchChannelFromPathname(location.pathname);
  const kickChannel = twitchChannel ? state.whitelist[twitchChannel] : null;

  if (!twitchChannel) {
    removeControlsBar();
    removeRestoreBadge();
    removeSuggestionBanner();
    if (state.activeKickChannel || document.getElementById(IDS.overlay)) {
      unmountKickOverlay(state, { resumeTwitch: false });
    }
    return;
  }

  if (!kickChannel) {
    removeControlsBar();
    removeRestoreBadge();
    if (state.activeKickChannel || document.getElementById(IDS.overlay)) {
      unmountKickOverlay(state, { resumeTwitch: false });
    }
    maybeSuggestKickForChannel(twitchChannel);
    return;
  }

  removeSuggestionBanner();

  const actionBar = findActionBarContainer();

  if (state.disabledChannels.has(twitchChannel)) {
    removeControlsBar();
    if (state.activeKickChannel || document.getElementById(IDS.overlay)) {
      unmountKickOverlay(state, { resumeTwitch: true });
    }
    if (actionBar) {
      mountRestoreBadge(state, actionBar, twitchChannel, kickChannel, playerCallbacks);
    }
    return;
  }

  const container = findPlayerContainer();
  if (container) {
    mountKickOverlay(state, container, twitchChannel, kickChannel);
  }
  if (actionBar) {
    mountControlsBar(state, actionBar, twitchChannel, kickChannel, playerCallbacks);
  }
}

function scheduleSync(delayMs = 150): void {
  if (state.syncTimer !== null) return;
  state.syncTimer = setTimeout(() => {
    state.syncTimer = null;
    syncPlayer();
  }, delayMs);
}

function registerMenuCommands(): void {
  if (typeof GM_registerMenuCommand !== "function") return;

  GM_registerMenuCommand("Manage Kick Whitelist", () => {
    openWhitelistModal(state, syncPlayer);
  });

  GM_registerMenuCommand("Add / Remove Current Channel", () => {
    const twitchChannel = getTwitchChannelFromPathname(location.pathname);
    if (!twitchChannel) {
      alert("Navigate to a Twitch channel page first (e.g. twitch.tv/username).");
      return;
    }

    if (state.whitelist[twitchChannel]) {
      const confirmed = confirm(
        `Remove "${twitchChannel}" (Kick: ${state.whitelist[twitchChannel]}) from your Kick whitelist?`,
      );
      if (!confirmed) return;
      const next = { ...state.whitelist };
      delete next[twitchChannel];
      state.whitelist = saveWhitelist(next);
      state.disabledChannels.delete(twitchChannel);
      syncPlayer();
    } else {
      const kickInput = prompt(
        `Enter the Kick username for Twitch channel "${twitchChannel}":`,
        twitchChannel,
      );
      if (kickInput === null) return;
      const kickChannel = normalizeChannelInput(kickInput || twitchChannel);
      if (!kickChannel) return;
      state.whitelist = saveWhitelist({
        ...state.whitelist,
        [twitchChannel]: kickChannel,
      });
      state.disabledChannels.delete(twitchChannel);
      syncPlayer();
    }
  });

  GM_registerMenuCommand("Toggle Kick / Twitch Player", () => {
    const twitchChannel = getTwitchChannelFromPathname(location.pathname);
    if (!twitchChannel || !state.whitelist[twitchChannel]) {
      alert("Current page is not a whitelisted Twitch channel.");
      return;
    }
    if (state.disabledChannels.has(twitchChannel)) {
      state.disabledChannels.delete(twitchChannel);
    } else {
      state.disabledChannels.add(twitchChannel);
    }
    syncPlayer();
  });
}

function notifyNavigation(): void {
  if (location.href !== state.lastHref) {
    state.lastHref = location.href;
    scheduleSync(50);
  }
}

function hookHistoryNavigation(): () => void {
  const origPushState = history.pushState.bind(history);
  history.pushState = function (data: unknown, unused: string, url?: string | URL | null): void {
    origPushState(data, unused, url);
    notifyNavigation();
  };

  const origReplaceState = history.replaceState.bind(history);
  history.replaceState = function (data: unknown, unused: string, url?: string | URL | null): void {
    origReplaceState(data, unused, url);
    notifyNavigation();
  };

  window.addEventListener("popstate", notifyNavigation);

  return () => {
    history.pushState = origPushState;
    history.replaceState = origReplaceState;
    window.removeEventListener("popstate", notifyNavigation);
  };
}

function startObserver(): () => void {
  const observer = new MutationObserver(() => {
    if (location.href !== state.lastHref) {
      state.lastHref = location.href;
      scheduleSync(50);
      return;
    }

    const twitchChannel = getTwitchChannelFromPathname(location.pathname);
    const kickChannel = twitchChannel ? state.whitelist[twitchChannel] : null;

    if (twitchChannel && kickChannel && !state.disabledChannels.has(twitchChannel)) {
      const overlay = document.getElementById(IDS.overlay);
      const controls = document.getElementById(IDS.controlsBar);
      const needsControls =
        state.settings.showBadge &&
        (!controls || !controls.isConnected || controls.dataset.kickChannel !== kickChannel);

      if (
        !overlay ||
        !overlay.isConnected ||
        state.activeKickChannel !== kickChannel ||
        needsControls
      ) {
        scheduleSync(150);
      } else if (state.activeContainer) {
        const now = Date.now();
        if (now - state.lastSilenceCheck >= 500) {
          state.lastSilenceCheck = now;
          silenceTwitchVideos(state, state.activeContainer);
        }
      }
    } else if (twitchChannel && kickChannel && state.disabledChannels.has(twitchChannel)) {
      const restore = document.getElementById(IDS.restoreBadge);
      if (state.settings.showBadge && (!restore || !restore.isConnected)) {
        scheduleSync(150);
      }
    } else if (state.activeKickChannel || document.getElementById(IDS.overlay)) {
      scheduleSync(100);
    } else if (twitchChannel && !kickChannel && state.settings.detectLiveKick) {
      const cached = state.liveCheckCache.get(twitchChannel);
      const hasFreshCache = cached && Date.now() - cached.checkedAt < LIVE_CHECK_CACHE_TTL_MS;
      const banner = document.getElementById(IDS.suggestionBanner);
      if (
        !hasFreshCache ||
        (cached.match &&
          (!banner || !banner.isConnected || banner.dataset.twitchChannel !== twitchChannel))
      ) {
        scheduleSync(250);
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  return () => observer.disconnect();
}

let teardownFns: Array<() => void> = [];

export function destroy(): void {
  if (state.syncTimer !== null) {
    clearTimeout(state.syncTimer);
    state.syncTimer = null;
  }
  for (const fn of teardownFns) fn();
  teardownFns = [];
  closeWhitelistModal(state);
  removeControlsBar();
  removeRestoreBadge();
  removeSuggestionBanner();
  unmountKickOverlay(state, { resumeTwitch: false });
}

function init(): void {
  injectStyles();
  registerMenuCommands();
  teardownFns = [hookHistoryNavigation(), startObserver()];
  syncPlayer();
}

if (document.body) {
  init();
} else {
  window.addEventListener("DOMContentLoaded", init, { once: true });
}
