import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, IDS, type AppState } from "./config";

const mockHlsState = {
  supported: false,
};

vi.mock("hls.js", () => ({
  default: {
    isSupported: () => mockHlsState.supported,
  },
}));

const mountHlsPlayerMock = vi.fn<(...args: unknown[]) => () => void>();
vi.mock("./hls-player", () => ({
  mountHlsPlayer: (...args: unknown[]) => mountHlsPlayerMock(...args),
}));

const fetchKickPlaybackUrlMock = vi.fn<(...args: unknown[]) => Promise<string | null>>();
vi.mock("./kick-api", () => ({
  fetchKickPlaybackUrl: (...args: unknown[]) => fetchKickPlaybackUrlMock(...args),
}));

import {
  findActionBarContainer,
  findPlayerContainer,
  mountControlsBar,
  mountKickOverlay,
  mountRestoreBadge,
  restoreTwitchVideos,
  silenceTwitchVideos,
  unmountKickOverlay,
  type PlayerCallbacks,
} from "./player";

function createState(): AppState {
  return {
    whitelist: {},
    settings: { ...DEFAULT_SETTINGS },
    liveCheckCache: new Map(),
    inFlightChecks: new Map(),
    disabledChannels: new Set(),
    activeTwitchChannel: null,
    activeKickChannel: null,
    activeContainer: null,
    activeContainerOriginalPosition: null,
    activePlayerTeardown: null,
    mountSeq: 0,
    silencedVideos: new Map(),
    lastHref: "https://www.twitch.tv/",
    syncTimer: null,
    lastSilenceCheck: 0,
    modalKeyHandler: null,
  };
}

function mockRect(el: HTMLElement, width: number, height: number): void {
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    width,
    height,
    top: 0,
    left: 0,
    bottom: height,
    right: width,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

describe("player", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mockHlsState.supported = false;
    mountHlsPlayerMock.mockReset();
    fetchKickPlaybackUrlMock.mockReset();
    vi.stubGlobal("GM_setValue", vi.fn<() => void>());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("findPlayerContainer", () => {
    it("returns null when no containers exist or containers are too small", () => {
      expect(findPlayerContainer()).toBeNull();

      const small = document.createElement("div");
      small.className = "video-player__container";
      mockRect(small, 80, 60);
      document.body.appendChild(small);

      const smallOffline = document.createElement("div");
      smallOffline.className = "channel-root__player";
      mockRect(smallOffline, 150, 100);
      document.body.appendChild(smallOffline);

      expect(findPlayerContainer()).toBeNull();
    });

    it("falls back to .channel-root__player when offline on Twitch", () => {
      const offline = document.createElement("div");
      offline.className = "channel-root__player";
      mockRect(offline, 640, 360);
      document.body.appendChild(offline);

      expect(findPlayerContainer()).toBe(offline);
    });

    it("prefers video player container over offline fallback", () => {
      const offline = document.createElement("div");
      offline.className = "channel-root__player";
      mockRect(offline, 800, 450);

      const player = document.createElement("div");
      player.className = "video-player";
      mockRect(player, 1280, 720);

      document.body.append(offline, player);
      expect(findPlayerContainer()).toBe(player);
    });
  });

  describe("findActionBarContainer", () => {
    it("returns null when no action buttons are present", () => {
      expect(findActionBarContainer()).toBeNull();
    });

    it("uses lowest common ancestor when 2+ action buttons exist without an h1", () => {
      const info = document.createElement("div");
      info.setAttribute("data-a-target", "channel-info-content");
      const row = document.createElement("div");
      const follow = document.createElement("button");
      follow.setAttribute("data-a-target", "follow-button");
      const gift = document.createElement("button");
      gift.setAttribute("data-a-target", "gift-button");
      row.append(follow, gift);
      info.appendChild(row);
      document.body.appendChild(info);

      expect(findActionBarContainer()).toBe(row);
    });

    it("handles single-button fallback by finding enclosing row flex container without h1", () => {
      const info = document.createElement("div");
      info.id = "live-channel-stream-information";
      const header = document.createElement("div");
      const h1 = document.createElement("h1");
      h1.textContent = "Channel";

      const flexRow = document.createElement("div");
      flexRow.style.display = "flex";
      const wrapper = document.createElement("div");
      const follow = document.createElement("button");
      follow.setAttribute("data-a-target", "follow-button");
      wrapper.appendChild(follow);
      const spacer = document.createElement("div");
      flexRow.append(wrapper, spacer);

      header.append(h1, flexRow);
      info.appendChild(header);
      document.body.appendChild(info);

      expect(findActionBarContainer()).toBe(flexRow);
    });

    it("falls back to button direct parentElement when no flex row ancestor exists before h1", () => {
      const container = document.createElement("div");
      const h1 = document.createElement("h1");
      const directParent = document.createElement("div");
      const follow = document.createElement("button");
      follow.setAttribute("aria-label", "Follow streamer");
      directParent.appendChild(follow);
      container.append(h1, directParent);
      document.body.appendChild(container);

      expect(findActionBarContainer()).toBe(directParent);
    });
  });

  describe("silenceTwitchVideos / restoreTwitchVideos", () => {
    it("silences Twitch videos, ignores videos inside Kick overlay, enforces mute on volumechange, and restores cleanly", () => {
      const state = createState();
      state.activeKickChannel = "kick_chan";

      const container = document.createElement("div");
      const twitchVideo = document.createElement("video");
      let paused = false;
      Object.defineProperty(twitchVideo, "paused", { configurable: true, get: () => paused });
      twitchVideo.muted = false;
      const pauseSpy = vi.fn<() => void>(() => {
        paused = true;
      });
      const playSpy = vi.fn<() => Promise<void>>(() => {
        paused = false;
        return Promise.resolve();
      });
      twitchVideo.pause = pauseSpy;
      twitchVideo.play = playSpy;

      const overlay = document.createElement("div");
      overlay.id = IDS.overlay;
      const kickVideo = document.createElement("video");
      kickVideo.muted = false;
      overlay.appendChild(kickVideo);

      const persistent = document.createElement("div");
      persistent.className = "persistent-player";
      const persistentVideo = document.createElement("video");
      persistentVideo.muted = false;
      persistentVideo.pause = vi.fn<() => void>();
      persistent.appendChild(persistentVideo);

      container.append(twitchVideo, overlay);
      document.body.append(container, persistent);

      silenceTwitchVideos(state, container);

      expect(twitchVideo.muted).toBe(true);
      expect(pauseSpy).toHaveBeenCalledTimes(1);
      expect(twitchVideo.classList.contains("tk-twitch-video-hidden")).toBe(true);
      expect(persistentVideo.muted).toBe(true);
      expect(persistentVideo.classList.contains("tk-twitch-video-hidden")).toBe(true);
      expect(kickVideo.muted).toBe(false);
      expect(kickVideo.classList.contains("tk-twitch-video-hidden")).toBe(false);

      // volumechange and play events re-enforce mute & pause while Kick is active
      twitchVideo.muted = false;
      twitchVideo.dispatchEvent(new Event("volumechange"));
      expect(twitchVideo.muted).toBe(true);

      twitchVideo.muted = false;
      paused = false;
      twitchVideo.dispatchEvent(new Event("play"));
      expect(twitchVideo.muted).toBe(true);
      expect(twitchVideo.paused).toBe(true);

      // Restoring with resumePlayback restores previous muted state and calls play()
      restoreTwitchVideos(state, { resumePlayback: true });
      expect(twitchVideo.classList.contains("tk-twitch-video-hidden")).toBe(false);
      expect(twitchVideo.muted).toBe(false);
      expect(playSpy).toHaveBeenCalledTimes(1);
      expect(state.silencedVideos.size).toBe(0);
    });
  });

  describe("mountControlsBar / mountRestoreBadge", () => {
    it("respects showBadge=false, is idempotent, and invokes callbacks on button clicks", () => {
      const state = createState();
      const actionBar = document.createElement("div");
      document.body.appendChild(actionBar);
      const callbacks: PlayerCallbacks = {
        onSwitchToTwitch: vi.fn<(channel: string) => void>(),
        onSwitchToKick: vi.fn<(channel: string) => void>(),
        onOpenWhitelist: vi.fn<() => void>(),
      };

      mountControlsBar(state, actionBar, "tw", "ki", callbacks);
      const bar = document.getElementById(IDS.controlsBar)!;
      expect(bar).not.toBeNull();
      const link = bar.querySelector<HTMLAnchorElement>("a")!;
      expect(link.href).toBe("https://kick.com/ki");
      expect(link.target).toBe("_blank");

      // Idempotent call keeps same element reference
      mountControlsBar(state, actionBar, "tw", "ki", callbacks);
      expect(document.getElementById(IDS.controlsBar)).toBe(bar);

      const [twitchBtn, whitelistBtn] = Array.from(bar.querySelectorAll("button"));
      twitchBtn.click();
      whitelistBtn.click();
      expect(callbacks.onSwitchToTwitch).toHaveBeenCalledWith("tw");
      expect(callbacks.onOpenWhitelist).toHaveBeenCalledTimes(1);

      // showBadge = false removes controls bar
      state.settings.showBadge = false;
      mountControlsBar(state, actionBar, "tw", "ki", callbacks);
      expect(document.getElementById(IDS.controlsBar)).toBeNull();

      // Restore badge behaves similarly
      mountRestoreBadge(state, actionBar, "tw", "ki", callbacks);
      expect(document.getElementById(IDS.restoreBadge)).toBeNull();

      state.settings.showBadge = true;
      mountRestoreBadge(state, actionBar, "tw", "ki", callbacks);
      const badge = document.getElementById(IDS.restoreBadge)!;
      expect(badge).not.toBeNull();

      mountRestoreBadge(state, actionBar, "tw", "ki", callbacks);
      expect(document.getElementById(IDS.restoreBadge)).toBe(badge);

      const [switchBtn, badgeWhitelistBtn] = Array.from(badge.querySelectorAll("button"));
      switchBtn.click();
      badgeWhitelistBtn.click();
      expect(callbacks.onSwitchToKick).toHaveBeenCalledWith("tw");
      expect(callbacks.onOpenWhitelist).toHaveBeenCalledTimes(2);
    });
  });

  describe("mountKickOverlay / unmountKickOverlay", () => {
    it("sets position relative on static containers, restores original position on unmount, and is idempotent", () => {
      const state = createState();
      const container = document.createElement("div");
      container.style.position = "static";
      document.body.appendChild(container);

      mountKickOverlay(state, container, "tw", "ki");
      const overlay = document.getElementById(IDS.overlay)!;
      expect(overlay.dataset.mode).toBe("embed");
      expect(container.style.position).toBe("relative");

      // Re-mounting with identical params keeps existing overlay node
      mountKickOverlay(state, container, "tw", "ki");
      expect(document.getElementById(IDS.overlay)).toBe(overlay);

      unmountKickOverlay(state);
      expect(document.getElementById(IDS.overlay)).toBeNull();
      expect(container.style.position).toBe("static");
    });

    it("mounts HLS player, persists volume changes, and handles null playbackUrl or stale async responses", async () => {
      mockHlsState.supported = true;
      const state = createState();
      const container = document.createElement("div");
      container.style.position = "relative";
      document.body.appendChild(container);

      // Case 1: playbackUrl is null -> falls back to embed iframe
      fetchKickPlaybackUrlMock.mockResolvedValueOnce(null);
      mountKickOverlay(state, container, "tw", "ki_offline");
      expect(document.querySelector(".tk-hls-loading")?.textContent).toContain("ki_offline");

      await Promise.resolve();
      await Promise.resolve();
      expect(document.querySelector<HTMLIFrameElement>(`#${IDS.overlay} iframe`)?.src).toContain(
        "https://player.kick.com/ki_offline",
      );

      // Case 2: playbackUrl resolves -> mounts HLS player and wires volume/fallback callbacks
      const teardownSpy = vi.fn<() => void>();
      let capturedCallbacks: {
        onVolumeChange: (v: number) => void;
        onFallbackToEmbed: () => void;
      } | null = null;
      mountHlsPlayerMock.mockImplementationOnce((_ov, _url, _ch, _settings, cbs) => {
        capturedCallbacks = cbs as {
          onVolumeChange: (v: number) => void;
          onFallbackToEmbed: () => void;
        };
        return teardownSpy;
      });
      fetchKickPlaybackUrlMock.mockResolvedValueOnce("https://cdn.example/live.m3u8");

      mountKickOverlay(state, container, "tw2", "ki_live");
      await Promise.resolve();
      await Promise.resolve();

      expect(mountHlsPlayerMock).toHaveBeenCalledTimes(1);
      capturedCallbacks!.onVolumeChange(0.45);
      expect(state.settings.volume).toBe(0.45);

      capturedCallbacks!.onFallbackToEmbed();
      expect(state.activePlayerTeardown).toBeNull();
      expect(document.querySelector(`#${IDS.overlay} iframe`)).not.toBeNull();

      // Case 2b: unmounting while HLS player is active invokes teardown
      const activeTeardown = vi.fn<() => void>();
      mountHlsPlayerMock.mockReturnValueOnce(activeTeardown);
      fetchKickPlaybackUrlMock.mockResolvedValueOnce("https://cdn.example/live2.m3u8");
      mountKickOverlay(state, container, "tw2b", "ki_live2");
      await Promise.resolve();
      await Promise.resolve();
      unmountKickOverlay(state);
      expect(activeTeardown).toHaveBeenCalledTimes(1);
      expect(state.activePlayerTeardown).toBeNull();

      // Case 3: stale fetchKickPlaybackUrl resolution after unmount is ignored
      let resolveStale!: (val: string | null) => void;
      fetchKickPlaybackUrlMock.mockImplementationOnce(
        () =>
          new Promise<string | null>((r) => {
            resolveStale = r;
          }),
      );
      mountKickOverlay(state, container, "tw3", "ki_stale");
      unmountKickOverlay(state);
      resolveStale("https://cdn.example/stale.m3u8");
      await Promise.resolve();
      await Promise.resolve();

      expect(mountHlsPlayerMock).toHaveBeenCalledTimes(2);
      expect(document.getElementById(IDS.overlay)).toBeNull();
    });
  });
});
