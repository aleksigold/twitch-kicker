import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockApiResponse {
  status?: number;
  statusText?: string;
  body?: unknown;
  delayMs?: number;
}

interface HarnessOptions {
  initialPath?: string;
  initialWhitelist?: Record<string, string>;
  initialSettings?: Record<string, unknown>;
  kickApiResponses?: Record<string, MockApiResponse>;
  kickChannelResponses?: Record<string, MockApiResponse>;
}

interface Harness {
  twitchVideo: HTMLVideoElement;
  actionBar: HTMLDivElement;
  menuCommands: Record<string, () => void>;
  gmStore: Record<string, unknown>;
  apiRequests: string[];
  destroy: () => void;
}

let activeDestroy: (() => void) | null = null;

async function setupHarness({
  initialPath = '/sick_nerd',
  initialWhitelist = { sick_nerd: 'sick_nerd', some_twitch: 'other_kick' },
  initialSettings,
  kickApiResponses = {},
  kickChannelResponses = {},
}: HarnessOptions = {}): Promise<Harness> {
  vi.resetModules();

  document.head.innerHTML = '';
  document.body.innerHTML = '';
  history.replaceState({}, '', initialPath);

  const playerContainer = document.createElement('div');
  playerContainer.className = 'video-player__container';
  vi.spyOn(playerContainer, 'getBoundingClientRect').mockReturnValue({
    width: 1280,
    height: 720,
    top: 0,
    left: 0,
    bottom: 720,
    right: 1280,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });

  const twitchVideo = document.createElement('video');
  let paused = false;
  Object.defineProperty(twitchVideo, 'paused', {
    configurable: true,
    get: () => paused,
  });
  twitchVideo.pause = vi.fn(() => {
    paused = true;
  });
  twitchVideo.play = vi.fn(() => {
    paused = false;
    twitchVideo.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });

  playerContainer.appendChild(twitchVideo);
  document.body.appendChild(playerContainer);

  // Realistic nested Twitch channel header below the stream (title + nested action pill row)
  const channelInfo = document.createElement('div');
  channelInfo.id = 'live-channel-stream-information';
  const headerRow = document.createElement('div');
  headerRow.style.display = 'flex';
  const titleEl = document.createElement('h1');
  titleEl.textContent = 'Sick_Nerd';

  const actionBar = document.createElement('div');
  actionBar.style.display = 'flex';

  const followWrap1 = document.createElement('div');
  const followWrap2 = document.createElement('div');
  const followBtn = document.createElement('button');
  followBtn.setAttribute('aria-label', 'Unfollow');
  followWrap2.appendChild(followBtn);
  followWrap1.appendChild(followWrap2);

  const subWrap1 = document.createElement('div');
  const subWrap2 = document.createElement('div');
  const subBtn = document.createElement('button');
  subBtn.setAttribute('data-a-target', 'subscribe-button');
  subBtn.textContent = 'Subscribe';
  subWrap2.appendChild(subBtn);
  subWrap1.appendChild(subWrap2);

  actionBar.append(followWrap1, subWrap1);
  headerRow.append(titleEl, actionBar);
  channelInfo.appendChild(headerRow);
  document.body.appendChild(channelInfo);

  const gmStore: Record<string, unknown> = {
    tk_whitelist_v1: initialWhitelist,
    ...(initialSettings ? { tk_settings_v1: initialSettings } : {}),
  };
  const menuCommands: Record<string, () => void> = {};
  const apiRequests: string[] = [];

  vi.stubGlobal('GM_getValue', (key: string, fallback: unknown) =>
    key in gmStore ? gmStore[key] : fallback
  );
  vi.stubGlobal('GM_setValue', (key: string, value: unknown) => {
    gmStore[key] = value;
  });
  vi.stubGlobal('GM_registerMenuCommand', (name: string, fn: () => void) => {
    menuCommands[name] = fn;
    return Object.keys(menuCommands).length;
  });
  vi.stubGlobal('GM_addStyle', (css: string) => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    return style;
  });
  vi.stubGlobal(
    'GM_xmlhttpRequest',
    (details: {
      url: string;
      onload?: (res: { status: number; statusText: string; responseText: string }) => void;
    }) => {
      apiRequests.push(details.url);
      const liveMatch = details.url.match(/\/channels\/([^/]+)\/livestream$/);
      const chanMatch = details.url.match(/\/channels\/([^/]+)$/);
      const mock = liveMatch
        ? kickApiResponses[decodeURIComponent(liveMatch[1])]
        : chanMatch
          ? kickChannelResponses[decodeURIComponent(chanMatch[1])]
          : undefined;

      const respond = (): void => {
        if (!mock) {
          details.onload?.({ status: 404, statusText: 'Not Found', responseText: '{}' });
          return;
        }
        details.onload?.({
          status: mock.status ?? 200,
          statusText: mock.statusText ?? 'OK',
          responseText:
            typeof mock.body === 'string' ? mock.body : JSON.stringify(mock.body ?? { data: null }),
        });
      };

      if (mock?.delayMs) {
        setTimeout(respond, mock.delayMs);
      } else {
        queueMicrotask(respond);
      }
    }
  );
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('prompt', vi.fn(() => null));

  const mod = await import('./index');
  activeDestroy = mod.destroy;

  return { twitchVideo, actionBar, menuCommands, gmStore, apiRequests, destroy: mod.destroy };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  activeDestroy?.();
  activeDestroy = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Twitch Kicker', () => {
  it('replaces Twitch player with Kick iframe on whitelisted channel and mounts controls below stream', async () => {
    const { twitchVideo, actionBar } = await setupHarness({ initialPath: '/sick_nerd' });

    const overlay = document.getElementById('tk-kick-overlay');
    expect(overlay).not.toBeNull();

    const iframe = overlay?.querySelector<HTMLIFrameElement>('iframe');
    expect(iframe?.src).toBe('https://player.kick.com/sick_nerd?autoplay=true&muted=false');
    expect(twitchVideo.muted).toBe(true);
    expect(twitchVideo.paused).toBe(true);
    expect(twitchVideo.classList.contains('tk-twitch-video-hidden')).toBe(true);

    // Controls live in the Twitch action bar below the stream, not inside the video overlay
    const controls = document.getElementById('tk-controls-bar');
    expect(controls?.parentElement).toBe(actionBar);
    expect(overlay?.querySelector('#tk-controls-bar')).toBeNull();

    // Re-enforces pause & mute if Twitch attempts to resume playback
    twitchVideo.muted = false;
    await twitchVideo.play();
    expect(twitchVideo.muted).toBe(true);
    expect(twitchVideo.paused).toBe(true);
  });

  it('supports toggling back to native Twitch player and switching back to Kick', async () => {
    const { twitchVideo, actionBar, menuCommands } = await setupHarness({
      initialPath: '/sick_nerd',
    });

    menuCommands['Toggle Kick / Twitch Player']();
    expect(document.getElementById('tk-kick-overlay')).toBeNull();
    expect(document.getElementById('tk-controls-bar')).toBeNull();
    const restore = document.getElementById('tk-restore-badge');
    expect(restore?.parentElement).toBe(actionBar);
    expect(twitchVideo.classList.contains('tk-twitch-video-hidden')).toBe(false);

    menuCommands['Toggle Kick / Twitch Player']();
    expect(document.getElementById('tk-kick-overlay')).not.toBeNull();
    expect(document.getElementById('tk-controls-bar')?.parentElement).toBe(actionBar);
    expect(document.getElementById('tk-restore-badge')).toBeNull();
  });

  it('handles SPA navigation across reserved routes, mapped channels, and channel subpages', async () => {
    await setupHarness({ initialPath: '/sick_nerd' });

    // Reserved route /directory unmounts overlay
    history.pushState({}, '', '/directory');
    await vi.advanceTimersByTimeAsync(100);
    expect(document.getElementById('tk-kick-overlay')).toBeNull();

    // Different Twitch -> Kick username mapping
    history.pushState({}, '', '/some_twitch');
    await vi.advanceTimersByTimeAsync(100);
    const iframe = document.querySelector<HTMLIFrameElement>('#tk-kick-overlay iframe');
    expect(iframe?.src).toBe('https://player.kick.com/other_kick?autoplay=true&muted=false');

    // Channel subpage (/videos) does not replace VOD player
    history.pushState({}, '', '/some_twitch/videos');
    await vi.advanceTimersByTimeAsync(100);
    expect(document.getElementById('tk-kick-overlay')).toBeNull();
  });

  it('opens whitelist modal and closes cleanly on Escape', async () => {
    const { menuCommands } = await setupHarness({ initialPath: '/sick_nerd' });

    menuCommands['Manage Kick Whitelist']();
    expect(document.getElementById('tk-modal-backdrop')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('tk-modal-backdrop')).toBeNull();
  });

  it('detects live matching Kick stream on non-whitelisted channel and lets user whitelist & switch', async () => {
    const { gmStore, actionBar } = await setupHarness({
      initialPath: '/newstreamer',
      initialWhitelist: { sick_nerd: 'sick_nerd' },
      kickApiResponses: {
        newstreamer: {
          status: 200,
          body: {
            data: {
              id: 4242,
              is_live: true,
              session_title: 'Multistreaming on Kick!',
              viewer_count: 1500,
              categories: [{ name: 'Old School RuneScape' }],
            },
          },
        },
      },
    });

    await vi.advanceTimersByTimeAsync(10);
    const banner = document.getElementById('tk-suggestion-banner');
    expect(banner).not.toBeNull();
    expect(banner?.parentElement).toBe(actionBar);
    expect(banner?.dataset.kickChannel).toBe('newstreamer');

    const buttons = Array.from(banner?.querySelectorAll('button') ?? []);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe('Whitelist & Switch');
    buttons[0].click();

    expect(document.getElementById('tk-suggestion-banner')).toBeNull();
    expect((gmStore.tk_whitelist_v1 as Record<string, string>).newstreamer).toBe('newstreamer');

    const iframe = document.querySelector<HTMLIFrameElement>('#tk-kick-overlay iframe');
    expect(iframe?.src).toBe('https://player.kick.com/newstreamer?autoplay=true&muted=false');
  });

  it('falls back from underscore to hyphenated Kick slug when checking live status', async () => {
    const { apiRequests } = await setupHarness({
      initialPath: '/cool_streamer',
      initialWhitelist: {},
      kickApiResponses: {
        cool_streamer: { status: 200, body: { data: null } },
        'cool-streamer': {
          status: 200,
          body: {
            data: { id: 99, is_live: true, session_title: 'Live with hyphen', viewer_count: 320 },
          },
        },
      },
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(apiRequests).toHaveLength(2);
    expect(document.getElementById('tk-suggestion-banner')?.dataset.kickChannel).toBe(
      'cool-streamer'
    );
  });

  it('does not show suggestion button on offline Kick channels', async () => {
    await setupHarness({
      initialPath: '/offline_channel',
      initialWhitelist: {},
      kickApiResponses: {
        offline_channel: {
          status: 200,
          body: { data: null },
        },
      },
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(document.getElementById('tk-suggestion-banner')).toBeNull();
  });

  it('ignores stale async Kick API response after navigating to a different channel', async () => {
    await setupHarness({
      initialPath: '/slow_channel',
      initialWhitelist: {},
      kickApiResponses: {
        slow_channel: {
          status: 200,
          delayMs: 90,
          body: { data: { id: 123, is_live: true, session_title: 'Delayed response' } },
        },
      },
    });

    history.pushState({}, '', '/directory');
    await vi.advanceTimersByTimeAsync(150);
    expect(document.getElementById('tk-suggestion-banner')).toBeNull();
  });

  it('mounts direct HLS player defaulting to Auto quality and falls back to embed on fatal error', async () => {
    const handlers: Record<string, Array<(event: string, data: unknown) => void>> = {};
    const destroySpy = vi.fn();
    const loadSourceSpy = vi.fn();
    const attachMediaSpy = vi.fn();
    const instances: Array<{ currentLevel: number }> = [];

    class MockHls {
      static isSupported = () => true;
      static Events = {
        MANIFEST_PARSED: 'hlsManifestParsed',
        LEVEL_SWITCHED: 'hlsLevelSwitched',
        ERROR: 'hlsError',
      };
      static ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' };
      currentLevel = -1;
      nextLevel = -1;
      liveSyncPosition = 120;
      levels = [
        { height: 480, frameRate: 30, bitrate: 1_500_000 },
        { height: 720, frameRate: 60, bitrate: 3_500_000 },
        { height: 1080, frameRate: 60, bitrate: 8_000_000 },
      ];

      constructor() {
        instances.push(this);
      }

      on(ev: string, fn: (event: string, data: unknown) => void): void {
        (handlers[ev] ||= []).push(fn);
      }

      loadSource = loadSourceSpy;
      attachMedia = attachMediaSpy;
      recoverMediaError = vi.fn();
      destroy = destroySpy;
    }

    vi.doMock('hls.js', () => ({ default: MockHls, LoadStats: class {} }));

    try {
      const { twitchVideo } = await setupHarness({
        initialPath: '/sick_nerd',
        kickChannelResponses: {
          sick_nerd: {
            status: 200,
            body: {
              playback_url: 'https://example.live-video.net/api/video/v1/master.m3u8',
              livestream: { id: 1, is_live: true },
            },
          },
        },
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(loadSourceSpy).toHaveBeenCalledWith(
        'https://example.live-video.net/api/video/v1/master.m3u8'
      );
      expect(attachMediaSpy).toHaveBeenCalledTimes(1);

      const hlsVideo = document.querySelector<HTMLVideoElement>('#tk-kick-overlay video.tk-hls-video');
      expect(hlsVideo).not.toBeNull();
      // Twitch video is silenced, but our Kick HLS video must NOT be hidden/silenced
      expect(twitchVideo.classList.contains('tk-twitch-video-hidden')).toBe(true);
      expect(hlsVideo?.classList.contains('tk-twitch-video-hidden')).toBe(false);

      // Simulate manifest with 720p60 and 1080p60 rungs
      for (const fn of handlers.hlsManifestParsed ?? []) {
        fn('hlsManifestParsed', {
          levels: [
            { height: 480, frameRate: 30, bitrate: 1_500_000 },
            { height: 720, frameRate: 60, bitrate: 3_500_000 },
            { height: 1080, frameRate: 60, bitrate: 8_000_000 },
          ],
        });
      }

      expect(instances.at(-1)?.currentLevel).toBe(-1);
      const qualitySelect = document.querySelector<HTMLSelectElement>('.tk-hls-quality');
      expect(qualitySelect?.value).toBe('-1');

      // When ABR selects 1080p60, Auto option displays the active resolution
      for (const fn of handlers.hlsLevelSwitched ?? []) {
        fn('hlsLevelSwitched', { level: 2 });
      }
      const labels = Array.from(qualitySelect?.options ?? []).map((o) => o.textContent);
      expect(labels).toEqual(['Auto (1080p60)', '1080p60', '720p60', '480p']);

      // Fatal network error triggers clean teardown and fallback to embed iframe
      for (const fn of handlers.hlsError ?? []) {
        fn('hlsError', { fatal: true, type: 'networkError' });
      }

      expect(destroySpy).toHaveBeenCalledTimes(1);
      const fallbackIframe = document.querySelector<HTMLIFrameElement>('#tk-kick-overlay iframe');
      expect(fallbackIframe?.src).toBe(
        'https://player.kick.com/sick_nerd?autoplay=true&muted=false'
      );
    } finally {
      vi.doUnmock('hls.js');
    }
  });
});
