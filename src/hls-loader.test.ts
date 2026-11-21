import type { LoaderCallbacks, LoaderConfiguration, LoaderContext } from 'hls.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GmHlsLoader } from './hls-loader';

function makeContext(overrides: Partial<LoaderContext> = {}): LoaderContext {
  return {
    url: 'https://cdn.live-video.net/master.m3u8',
    responseType: 'text',
    ...overrides,
  } as LoaderContext;
}

function makeConfig(overrides: Partial<LoaderConfiguration> = {}): LoaderConfiguration {
  return {
    maxRetry: 0,
    timeout: 8000,
    retryDelay: 0,
    maxRetryDelay: 0,
    ...overrides,
  } as LoaderConfiguration;
}

function makeCallbacks(): LoaderCallbacks<LoaderContext> {
  return {
    onSuccess: vi.fn(),
    onError: vi.fn(),
    onTimeout: vi.fn(),
    onAbort: vi.fn(),
  };
}

describe('GmHlsLoader', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads text playlists, parses response headers, and computes stats & cache age', () => {
    let captured: GMXmlHttpRequestDetails | undefined;
    vi.stubGlobal('GM_xmlhttpRequest', (details: GMXmlHttpRequestDetails) => {
      captured = details;
      return { abort: vi.fn() };
    });

    const nowSpy = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(100) // loading.start
      .mockReturnValueOnce(120) // readystatechange -> loading.first
      .mockReturnValueOnce(170); // onload -> loading.end

    const loader = new GmHlsLoader();
    const ctx = makeContext({ headers: { 'X-Test': '1' } });
    const callbacks = makeCallbacks();

    loader.load(ctx, makeConfig({ loadPolicy: { maxLoadTimeMs: 5000 } as never }), callbacks);

    expect(captured).toBeDefined();
    expect(captured?.method).toBe('GET');
    expect(captured?.responseType).toBe('text');
    expect(captured?.timeout).toBe(5000);
    expect(captured?.headers).toEqual({ 'X-Test': '1' });

    // readyState < 2 does not mark first byte
    captured?.onreadystatechange?.({ status: 0, statusText: '', responseText: '', readyState: 1 });
    expect(loader.stats.loading.first).toBe(0);

    // readyState >= 2 marks first byte
    captured?.onreadystatechange?.({ status: 200, statusText: 'OK', responseText: '', readyState: 2 });
    expect(loader.stats.loading.first).toBe(120);

    captured?.onprogress?.({
      status: 200,
      statusText: 'OK',
      responseText: '',
      loaded: 50,
      total: 100,
    });
    expect(loader.stats.loaded).toBe(50);
    expect(loader.stats.total).toBe(100);

    const body = '#EXTM3U\n#EXT-X-VERSION:3\n';
    captured?.onload?.({
      status: 200,
      statusText: 'OK',
      responseText: body,
      response: body,
      finalUrl: 'https://cdn.live-video.net/redirected.m3u8',
      responseHeaders: 'Content-Type: application/vnd.apple.mpegurl\r\nAge: 12.5\r\nInvalidHeaderLine\r\n',
    });

    expect(nowSpy).toHaveBeenCalledTimes(3);
    expect(loader.getResponseHeader('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(loader.getResponseHeader('CONTENT-TYPE')).toBe('application/vnd.apple.mpegurl');
    expect(loader.getResponseHeader('x-missing')).toBeNull();
    expect(loader.getCacheAge()).toBe(12.5);

    expect(loader.stats.loaded).toBe(body.length);
    expect(loader.stats.total).toBe(body.length);
    expect(loader.stats.loading.end).toBe(170);
    expect(loader.stats.bwEstimate).toBeCloseTo((body.length * 8000) / 50);

    expect(callbacks.onSuccess).toHaveBeenCalledWith(
      {
        url: 'https://cdn.live-video.net/redirected.m3u8',
        data: body,
        code: 200,
        text: 'OK',
      },
      loader.stats,
      ctx,
      null
    );
  });

  it('loads binary arraybuffer segments with Range headers and estimates TTFB when progress is skipped', () => {
    let captured: GMXmlHttpRequestDetails | undefined;
    vi.stubGlobal('GM_xmlhttpRequest', (details: GMXmlHttpRequestDetails) => {
      captured = details;
    });

    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(1000) // loading.start
      .mockReturnValueOnce(1100); // onload without readystatechange/progress

    const loader = new GmHlsLoader();
    const ctx = makeContext({
      url: 'https://cdn.live-video.net/seg0.ts',
      responseType: 'arraybuffer',
      rangeStart: 100,
      rangeEnd: 500,
    });
    const callbacks = makeCallbacks();

    loader.load(ctx, makeConfig({ timeout: 0 }), callbacks);

    expect(captured?.responseType).toBe('arraybuffer');
    expect(captured?.timeout).toBe(15000);
    expect(captured?.headers).toEqual({ Range: 'bytes=100-499' });

    const buf = new ArrayBuffer(400);
    captured?.onload?.({
      status: 206,
      statusText: 'Partial Content',
      responseText: '',
      response: buf,
      responseHeaders: 'Age: invalid',
    });

    expect(loader.stats.loading.first).toBe(1020);
    expect(loader.stats.loading.end).toBe(1100);
    expect(loader.stats.loaded).toBe(400);
    expect(loader.getCacheAge()).toBeNull();
    expect(callbacks.onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ url: ctx.url, data: buf, code: 206 }),
      loader.stats,
      ctx,
      null
    );
  });

  it('supports open-ended Range headers and non-ArrayBuffer/responseText fallbacks', () => {
    let captured: GMXmlHttpRequestDetails | undefined;
    vi.stubGlobal('GM_xmlhttpRequest', (details: GMXmlHttpRequestDetails) => {
      captured = details;
    });

    const loader = new GmHlsLoader();
    const callbacks = makeCallbacks();

    // Open-ended range + non-ArrayBuffer binary payload
    loader.load(
      makeContext({ responseType: 'arraybuffer', rangeStart: 64 }),
      makeConfig(),
      callbacks
    );
    expect(captured?.headers).toEqual({ Range: 'bytes=64-' });
    captured?.onload?.({ status: 200, statusText: 'OK', responseText: '', response: null });
    expect(loader.stats.loaded).toBe(0);

    // Text payload where response is undefined so it falls back to responseText
    loader.load(makeContext({ responseType: 'text' }), makeConfig(), callbacks);
    captured?.onload?.({ status: 200, statusText: 'OK', responseText: 'playlist-body' });
    expect(callbacks.onSuccess).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: 'playlist-body' }),
      loader.stats,
      expect.anything(),
      null
    );
  });

  it('reports HTTP errors, network errors, and timeouts to callbacks', () => {
    let captured: GMXmlHttpRequestDetails | undefined;
    vi.stubGlobal('GM_xmlhttpRequest', (details: GMXmlHttpRequestDetails) => {
      captured = details;
    });

    const loader = new GmHlsLoader();
    const ctx = makeContext();
    const callbacks = makeCallbacks();

    // Non-2xx status without statusText
    loader.load(ctx, makeConfig(), callbacks);
    captured?.onload?.({ status: 503, statusText: '', responseText: '' });
    expect(callbacks.onError).toHaveBeenCalledWith(
      { code: 503, text: 'HTTP 503' },
      ctx,
      null,
      loader.stats
    );

    // Network Error instance
    loader.load(ctx, makeConfig(), callbacks);
    captured?.onerror?.(new Error('DNS failed'));
    expect(callbacks.onError).toHaveBeenLastCalledWith(
      { code: 0, text: 'DNS failed' },
      ctx,
      null,
      loader.stats
    );

    // Non-Error rejection
    loader.load(ctx, makeConfig(), callbacks);
    captured?.onerror?.('unknown');
    expect(callbacks.onError).toHaveBeenLastCalledWith(
      { code: 0, text: 'Network error' },
      ctx,
      null,
      loader.stats
    );

    // Timeout
    loader.load(ctx, makeConfig(), callbacks);
    captured?.ontimeout?.();
    expect(callbacks.onTimeout).toHaveBeenCalledWith(loader.stats, ctx, null);
  });

  it('aborts in-flight requests cleanly, ignores late callbacks, and cleans up on destroy', () => {
    let captured: GMXmlHttpRequestDetails | undefined;
    const abortSpy = vi.fn(() => {
      throw new Error('already finished');
    });
    vi.stubGlobal('GM_xmlhttpRequest', (details: GMXmlHttpRequestDetails) => {
      captured = details;
      return { abort: abortSpy };
    });

    const loader = new GmHlsLoader();
    const ctx = makeContext();
    const callbacks = makeCallbacks();

    loader.load(ctx, makeConfig(), callbacks);
    loader.abort();

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(loader.stats.aborted).toBe(true);
    expect(callbacks.onAbort).toHaveBeenCalledWith(loader.stats, ctx, null);

    // Calling abort again is a no-op
    loader.abort();
    expect(abortSpy).toHaveBeenCalledTimes(1);

    // Late callbacks after abort are ignored
    captured?.onreadystatechange?.({ status: 200, statusText: 'OK', responseText: '', readyState: 2 });
    captured?.onprogress?.({ status: 200, statusText: 'OK', responseText: '', loaded: 10, total: 20 });
    captured?.onload?.({ status: 200, statusText: 'OK', responseText: 'late' });
    captured?.onerror?.(new Error('late'));
    captured?.ontimeout?.();

    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onTimeout).not.toHaveBeenCalled();

    // Load again, succeed to populate headers, then destroy clears state
    loader.load(ctx, makeConfig(), callbacks);
    captured?.onload?.({
      status: 200,
      statusText: 'OK',
      responseText: 'ok',
      responseHeaders: 'Age: 5',
    });
    expect(loader.getCacheAge()).toBe(5);

    loader.destroy();
    expect(loader.context).toBeNull();
    expect(loader.getCacheAge()).toBeNull();
    expect(loader.getResponseHeader('age')).toBeNull();
  });
});
