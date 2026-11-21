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

  const channelInfo = document.createElement('div');
  channelInfo.id = 'live-channel-stream-information';
  const actionBar = document.createElement('div');
  actionBar.style.display = 'flex';

  const followBtn = document.createElement('button');
  followBtn.setAttribute('aria-label', 'Unfollow');
  const subBtn = document.createElement('button');
  subBtn.setAttribute('data-a-target', 'subscribe-button');
  subBtn.textContent = 'Subscribe';

  actionBar.append(followBtn, subBtn);
  channelInfo.appendChild(actionBar);
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
      const mock = liveMatch ? kickApiResponses[decodeURIComponent(liveMatch[1])] : undefined;

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

describe('Twitch Kicker integration', () => {
  it('mounts Kick player & controls on whitelisted channel and toggles via in-page controls', async () => {
    const { twitchVideo, actionBar } = await setupHarness({ initialPath: '/sick_nerd' });

    const iframe = document.querySelector<HTMLIFrameElement>('#tk-kick-overlay iframe');
    expect(iframe?.src).toBe('https://player.kick.com/sick_nerd?autoplay=true&muted=false');
    expect(twitchVideo.muted).toBe(true);
    expect(twitchVideo.classList.contains('tk-twitch-video-hidden')).toBe(true);

    const controls = document.getElementById('tk-controls-bar')!;
    expect(controls.parentElement).toBe(actionBar);

    const buttons = Array.from(controls.querySelectorAll('button'));
    buttons.find((b) => b.textContent === 'Whitelist')!.click();
    expect(document.getElementById('tk-modal-backdrop')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    // Switch back to Twitch, then back to Kick
    buttons.find((b) => b.textContent === 'Twitch')!.click();
    expect(document.getElementById('tk-kick-overlay')).toBeNull();
    expect(twitchVideo.classList.contains('tk-twitch-video-hidden')).toBe(false);

    const restoreBtn = document.querySelector<HTMLButtonElement>('#tk-restore-badge button')!;
    restoreBtn.click();
    expect(document.getElementById('tk-kick-overlay')).not.toBeNull();
    expect(document.getElementById('tk-restore-badge')).toBeNull();
  });

  it('syncs on SPA navigation (pushState, replaceState, popstate) across routes and subpages', async () => {
    await setupHarness({ initialPath: '/sick_nerd' });

    history.pushState({}, '', '/directory');
    await vi.advanceTimersByTimeAsync(100);
    expect(document.getElementById('tk-kick-overlay')).toBeNull();

    history.replaceState({}, '', '/some_twitch');
    await vi.advanceTimersByTimeAsync(100);
    expect(document.querySelector<HTMLIFrameElement>('#tk-kick-overlay iframe')?.src).toBe(
      'https://player.kick.com/other_kick?autoplay=true&muted=false'
    );

    history.pushState({}, '', '/some_twitch/videos');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await vi.advanceTimersByTimeAsync(100);
    expect(document.getElementById('tk-kick-overlay')).toBeNull();
  });

  it('wires Tampermonkey menu commands for whitelist management, add/remove, and toggle', async () => {
    const { menuCommands, gmStore } = await setupHarness({
      initialPath: '/directory',
      initialWhitelist: { sick_nerd: 'sick_nerd' },
    });

    const alertMock = vi.mocked(globalThis.alert);
    const confirmMock = vi.mocked(globalThis.confirm);
    const promptMock = vi.mocked(globalThis.prompt);

    menuCommands['Manage Kick Whitelist']();
    expect(document.getElementById('tk-modal-backdrop')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    // Non-channel route alerts
    menuCommands['Add / Remove Current Channel']();
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining('Navigate to a Twitch channel'));
    menuCommands['Toggle Kick / Twitch Player']();
    expect(alertMock).toHaveBeenCalledWith('Current page is not a whitelisted Twitch channel.');

    // Add non-whitelisted channel via prompt
    history.pushState({}, '', '/new_chan');
    await vi.advanceTimersByTimeAsync(100);

    promptMock.mockReturnValueOnce(null);
    menuCommands['Add / Remove Current Channel']();
    expect((gmStore.tk_whitelist_v1 as Record<string, string>).new_chan).toBeUndefined();

    promptMock.mockReturnValueOnce('custom-kick');
    menuCommands['Add / Remove Current Channel']();
    expect((gmStore.tk_whitelist_v1 as Record<string, string>).new_chan).toBe('custom-kick');
    expect(document.querySelector<HTMLIFrameElement>('#tk-kick-overlay iframe')?.src).toBe(
      'https://player.kick.com/custom-kick?autoplay=true&muted=false'
    );

    // Toggle off and back on via menu command
    menuCommands['Toggle Kick / Twitch Player']();
    expect(document.getElementById('tk-kick-overlay')).toBeNull();
    menuCommands['Toggle Kick / Twitch Player']();
    expect(document.getElementById('tk-kick-overlay')).not.toBeNull();

    // Remove channel via confirm
    confirmMock.mockReturnValueOnce(false);
    menuCommands['Add / Remove Current Channel']();
    expect((gmStore.tk_whitelist_v1 as Record<string, string>).new_chan).toBe('custom-kick');

    confirmMock.mockReturnValueOnce(true);
    menuCommands['Add / Remove Current Channel']();
    expect((gmStore.tk_whitelist_v1 as Record<string, string>).new_chan).toBeUndefined();
    expect(document.getElementById('tk-kick-overlay')).toBeNull();
  });

  it('suggests whitelisting live Kick streams, ignores stale responses, and respects detectLiveKick', async () => {
    const { gmStore, actionBar, apiRequests } = await setupHarness({
      initialPath: '/slow_channel',
      initialWhitelist: {},
      kickApiResponses: {
        slow_channel: {
          status: 200,
          delayMs: 90,
          body: { data: { id: 1, is_live: true, session_title: 'Delayed' } },
        },
        newstreamer: {
          status: 200,
          body: { data: { id: 2, is_live: true, session_title: 'Live!' } },
        },
      },
    });

    // Navigating away before delayed response arrives ignores it
    history.pushState({}, '', '/directory');
    await vi.advanceTimersByTimeAsync(150);
    expect(document.getElementById('tk-suggestion-banner')).toBeNull();

    // Live channel shows suggestion banner and Whitelist & Switch mounts player
    history.pushState({}, '', '/newstreamer');
    await vi.advanceTimersByTimeAsync(100);
    const banner = document.getElementById('tk-suggestion-banner')!;
    expect(banner.parentElement).toBe(actionBar);
    banner.querySelector('button')!.click();

    expect(document.getElementById('tk-suggestion-banner')).toBeNull();
    expect((gmStore.tk_whitelist_v1 as Record<string, string>).newstreamer).toBe('newstreamer');
    expect(document.querySelector<HTMLIFrameElement>('#tk-kick-overlay iframe')?.src).toContain(
      '/newstreamer?'
    );

    // Offline channel produces no banner
    history.pushState({}, '', '/offline_chan');
    await vi.advanceTimersByTimeAsync(100);
    expect(document.getElementById('tk-suggestion-banner')).toBeNull();

    // detectLiveKick=false suppresses livestream lookups
    const beforeCount = apiRequests.length;
    const h2 = await setupHarness({
      initialPath: '/another_chan',
      initialWhitelist: {},
      initialSettings: { detectLiveKick: false },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(h2.apiRequests).toHaveLength(0);
    expect(beforeCount).toBeGreaterThan(0);
  });

  it('recovers UI via MutationObserver and cleans up pending timers on destroy', async () => {
    const { destroy } = await setupHarness({
      initialPath: '/sick_nerd',
      initialWhitelist: { sick_nerd: 'sick_nerd' },
      kickApiResponses: {
        live_one: { status: 200, body: { data: { id: 1, is_live: true } } },
        live_two: { status: 200, body: { data: { id: 2, is_live: true } } },
      },
    });

    // Overlay removed by Twitch -> re-mounted by observer
    document.getElementById('tk-kick-overlay')?.remove();
    await vi.advanceTimersByTimeAsync(200);
    expect(document.getElementById('tk-kick-overlay')).not.toBeNull();

    // Newly injected Twitch <video> re-silenced after throttle window
    await vi.advanceTimersByTimeAsync(600);
    const lateVideo = document.createElement('video');
    lateVideo.muted = false;
    lateVideo.pause = vi.fn();
    document.querySelector('.video-player__container')!.appendChild(lateVideo);
    await vi.advanceTimersByTimeAsync(50);
    expect(lateVideo.muted).toBe(true);

    // Restore badge removed while disabled -> re-mounted by observer
    Array.from(document.querySelectorAll<HTMLButtonElement>('#tk-controls-bar button'))
      .find((b) => b.textContent === 'Twitch')!
      .click();
    document.getElementById('tk-restore-badge')?.remove();
    await vi.advanceTimersByTimeAsync(200);
    expect(document.getElementById('tk-restore-badge')).not.toBeNull();

    // Suggestion banner cleared on channel switch and mounted once action bar appears
    history.pushState({}, '', '/live_one');
    await vi.advanceTimersByTimeAsync(100);
    expect(document.getElementById('tk-suggestion-banner')?.dataset.twitchChannel).toBe('live_one');

    const infoEl = document.getElementById('live-channel-stream-information')!;
    infoEl.remove();
    history.pushState({}, '', '/live_two');
    await vi.advanceTimersByTimeAsync(100);
    expect(document.getElementById('tk-suggestion-banner')).toBeNull();

    document.body.appendChild(infoEl);
    await vi.advanceTimersByTimeAsync(300);
    expect(document.getElementById('tk-suggestion-banner')?.dataset.twitchChannel).toBe('live_two');

    // destroy() clears pending scheduled sync timer
    history.pushState({}, '', '/directory');
    destroy();
    await vi.advanceTimersByTimeAsync(200);
    expect(document.getElementById('tk-suggestion-banner')).toBeNull();
  });
});
