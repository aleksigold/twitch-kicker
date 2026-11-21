import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, LIVE_CHECK_CACHE_TTL_MS, type AppState } from './config';
import { fetchKickPlaybackUrl, findLiveMatchingKickStream } from './kick-api';

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
    lastHref: 'https://www.twitch.tv/',
    syncTimer: null,
    lastSilenceCheck: 0,
    modalKeyHandler: null,
  };
}

describe('kick-api', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('findLiveMatchingKickStream', () => {
    it('returns null when GM_xmlhttpRequest is unavailable', async () => {
      vi.stubGlobal('GM_xmlhttpRequest', undefined);
      const state = createState();

      const result = await findLiveMatchingKickStream(state, 'streamer');
      expect(result).toBeNull();
      expect(state.liveCheckCache.get('streamer')?.match).toBeNull();
    });

    it('parses livestream from root.data with category object and caches result', async () => {
      const gmXhr = vi.fn((details: GMXmlHttpRequestDetails) => {
        details.onload?.({
          status: 200,
          statusText: 'OK',
          responseText: JSON.stringify({
            data: {
              id: 101,
              session_title: '  Live Now  ',
              viewer_count: 550,
              category: { name: '  Just Chatting  ' },
            },
          }),
        });
      });
      vi.stubGlobal('GM_xmlhttpRequest', gmXhr);
      const state = createState();

      const first = await findLiveMatchingKickStream(state, 'streamer');
      expect(first).toEqual({
        kickChannel: 'streamer',
        title: 'Live Now',
        viewerCount: 550,
        category: 'Just Chatting',
      });
      expect(gmXhr).toHaveBeenCalledTimes(1);

      // Fresh cache hit does not trigger another request
      vi.advanceTimersByTime(LIVE_CHECK_CACHE_TTL_MS - 1000);
      const cached = await findLiveMatchingKickStream(state, 'streamer');
      expect(cached).toEqual(first);
      expect(gmXhr).toHaveBeenCalledTimes(1);

      // Expired cache triggers a fresh request
      vi.advanceTimersByTime(2000);
      await findLiveMatchingKickStream(state, 'streamer');
      expect(gmXhr).toHaveBeenCalledTimes(2);
    });

    it('parses root.livestream payload with categories array and handles blank optional fields', async () => {
      vi.stubGlobal('GM_xmlhttpRequest', (details: GMXmlHttpRequestDetails) => {
        details.onload?.({
          status: 200,
          statusText: 'OK',
          responseText: JSON.stringify({
            livestream: {
              is_live: true,
              session_title: '   ',
              viewer_count: 'not-a-number',
              categories: [{ name: '   ' }],
            },
          }),
        });
      });
      const state = createState();

      const match = await findLiveMatchingKickStream(state, 'alpha');
      expect(match).toEqual({
        kickChannel: 'alpha',
        title: null,
        viewerCount: null,
        category: null,
      });
    });

    it('deduplicates concurrent in-flight requests for the same channel', async () => {
      let pendingOnload: ((res: GMXmlHttpRequestResponse) => void) | undefined;
      const gmXhr = vi.fn((details: GMXmlHttpRequestDetails) => {
        pendingOnload = details.onload;
      });
      vi.stubGlobal('GM_xmlhttpRequest', gmXhr);
      const state = createState();

      const p1 = findLiveMatchingKickStream(state, 'same');
      const p2 = findLiveMatchingKickStream(state, 'same');
      expect(p1).toBe(p2);
      expect(gmXhr).toHaveBeenCalledTimes(1);

      pendingOnload?.({
        status: 200,
        statusText: 'OK',
        responseText: JSON.stringify({ data: { id: 1, is_live: true } }),
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toEqual(r2);
      expect(r1?.kickChannel).toBe('same');
      expect(state.inFlightChecks.has('same')).toBe(false);
    });

    it('returns null when is_live is false, payload is malformed, or request fails/times out/throws', async () => {
      const state = createState();

      // is_live: false even with numeric id
      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) =>
        d.onload?.({
          status: 200,
          statusText: 'OK',
          responseText: JSON.stringify({ data: { id: 10, is_live: false } }),
        })
      );
      expect(await findLiveMatchingKickStream(state, 'c1')).toBeNull();

      // Invalid JSON
      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) =>
        d.onload?.({ status: 200, statusText: 'OK', responseText: 'not json' })
      );
      expect(await findLiveMatchingKickStream(state, 'c2')).toBeNull();

      // Non-object JSON
      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) =>
        d.onload?.({ status: 200, statusText: 'OK', responseText: 'null' })
      );
      expect(await findLiveMatchingKickStream(state, 'c3')).toBeNull();

      // HTTP 500
      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) =>
        d.onload?.({ status: 500, statusText: 'Error', responseText: '{}' })
      );
      expect(await findLiveMatchingKickStream(state, 'c4')).toBeNull();

      // onerror
      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) => d.onerror?.(new Error('net')));
      expect(await findLiveMatchingKickStream(state, 'c5')).toBeNull();

      // ontimeout
      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) => d.ontimeout?.());
      expect(await findLiveMatchingKickStream(state, 'c6')).toBeNull();

      // synchronous throw
      vi.stubGlobal('GM_xmlhttpRequest', () => {
        throw new Error('boom');
      });
      expect(await findLiveMatchingKickStream(state, 'c7')).toBeNull();
    });

    it('stops after first live underscore candidate without querying hyphenated slug', async () => {
      const urls: string[] = [];
      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) => {
        urls.push(d.url);
        d.onload?.({
          status: 200,
          statusText: 'OK',
          responseText: JSON.stringify({ data: { id: 5, is_live: true } }),
        });
      });
      const state = createState();

      const result = await findLiveMatchingKickStream(state, 'my_channel');
      expect(result?.kickChannel).toBe('my_channel');
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain('/my_channel/livestream');
    });

    it('falls back from underscore slug to hyphenated slug when first candidate is offline', async () => {
      const urls: string[] = [];
      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) => {
        urls.push(d.url);
        if (d.url.includes('/cool_streamer/')) {
          d.onload?.({
            status: 200,
            statusText: 'OK',
            responseText: JSON.stringify({ data: null }),
          });
        } else {
          d.onload?.({
            status: 200,
            statusText: 'OK',
            responseText: JSON.stringify({
              data: { id: 99, is_live: true, session_title: 'Live with hyphen', viewer_count: 320 },
            }),
          });
        }
      });
      const state = createState();

      const result = await findLiveMatchingKickStream(state, 'cool_streamer');
      expect(urls).toHaveLength(2);
      expect(result).toEqual({
        kickChannel: 'cool-streamer',
        title: 'Live with hyphen',
        viewerCount: 320,
        category: null,
      });
    });
  });

  describe('fetchKickPlaybackUrl', () => {
    it('returns null when GM_xmlhttpRequest is unavailable', async () => {
      vi.stubGlobal('GM_xmlhttpRequest', undefined);
      expect(await fetchKickPlaybackUrl('streamer')).toBeNull();
    });

    it('returns unescaped playback_url when livestream is live', async () => {
      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) => {
        expect(d.url).toBe('https://kick.com/api/v2/channels/my%20chan');
        d.onload?.({
          status: 200,
          statusText: 'OK',
          responseText: JSON.stringify({
            playback_url: '  https:\\/\\/fa723fc1b171.us-west-2.playback.live-video.net\\/master.m3u8  ',
            livestream: { id: 1, is_live: true },
          }),
        });
      });

      const url = await fetchKickPlaybackUrl('my chan');
      expect(url).toBe('https://fa723fc1b171.us-west-2.playback.live-video.net/master.m3u8');
    });

    it('rejects offline, non-http URLs, malformed payloads, and network errors', async () => {
      // Offline livestream
      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) =>
        d.onload?.({
          status: 200,
          statusText: 'OK',
          responseText: JSON.stringify({
            playback_url: 'https://example.com/live.m3u8',
            livestream: { is_live: false },
          }),
        })
      );
      expect(await fetchKickPlaybackUrl('a')).toBeNull();

      // Missing livestream object
      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) =>
        d.onload?.({
          status: 200,
          statusText: 'OK',
          responseText: JSON.stringify({
            playback_url: 'https://example.com/live.m3u8',
            livestream: null,
          }),
        })
      );
      expect(await fetchKickPlaybackUrl('a')).toBeNull();

      // Non-http(s) playback_url
      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) =>
        d.onload?.({
          status: 200,
          statusText: 'OK',
          responseText: JSON.stringify({
            playback_url: 'javascript:alert(1)',
            livestream: { is_live: true },
          }),
        })
      );
      expect(await fetchKickPlaybackUrl('a')).toBeNull();

      // Empty playback_url
      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) =>
        d.onload?.({
          status: 200,
          statusText: 'OK',
          responseText: JSON.stringify({
            playback_url: '   ',
            livestream: { is_live: true },
          }),
        })
      );
      expect(await fetchKickPlaybackUrl('a')).toBeNull();

      // Non-object / invalid JSON
      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) =>
        d.onload?.({ status: 200, statusText: 'OK', responseText: '123' })
      );
      expect(await fetchKickPlaybackUrl('a')).toBeNull();

      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) =>
        d.onload?.({ status: 200, statusText: 'OK', responseText: '{invalid' })
      );
      expect(await fetchKickPlaybackUrl('a')).toBeNull();

      // Non-2xx status
      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) =>
        d.onload?.({ status: 403, statusText: 'Forbidden', responseText: '{}' })
      );
      expect(await fetchKickPlaybackUrl('a')).toBeNull();

      // onerror
      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) => d.onerror?.('fail'));
      expect(await fetchKickPlaybackUrl('a')).toBeNull();

      // ontimeout
      vi.stubGlobal('GM_xmlhttpRequest', (d: GMXmlHttpRequestDetails) => d.ontimeout?.());
      expect(await fetchKickPlaybackUrl('a')).toBeNull();

      // throw
      vi.stubGlobal('GM_xmlhttpRequest', () => {
        throw new Error('crash');
      });
      expect(await fetchKickPlaybackUrl('a')).toBeNull();
    });
  });
});
