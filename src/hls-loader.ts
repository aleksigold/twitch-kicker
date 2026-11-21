import type {
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderStats,
} from "hls.js";

function createLoadStats(): LoaderStats {
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  };
}

function parseHeaders(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const line of raw.split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const val = line.slice(sep + 1).trim();
    if (key) map.set(key, val);
  }
  return map;
}

/**
 * Custom hls.js loader backed by GM_xmlhttpRequest so Kick's Amazon IVS
 * playlists and media segments bypass CORS and Twitch's connect-src CSP.
 */
export class GmHlsLoader implements Loader<LoaderContext> {
  context: LoaderContext | null = null;
  stats: LoaderStats = createLoadStats();
  private requestHandle: GMXmlHttpRequestHandle | null = null;
  private responseHeaders = new Map<string, string>();
  private callbacks: LoaderCallbacks<LoaderContext> | null = null;

  destroy(): void {
    this.abort();
    this.context = null;
    this.callbacks = null;
    this.responseHeaders.clear();
  }

  abort(): void {
    if (this.requestHandle && typeof this.requestHandle.abort === "function") {
      this.stats.aborted = true;
      try {
        this.requestHandle.abort();
      } catch {
        // Ignore abort errors on already-completed requests
      }
      this.requestHandle = null;
      if (this.context && this.callbacks?.onAbort) {
        this.callbacks.onAbort(this.stats, this.context, null);
      }
    }
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders.get(name.toLowerCase()) ?? null;
  }

  getCacheAge(): number | null {
    const age = this.getResponseHeader("age");
    if (!age) return null;
    const parsed = Number.parseFloat(age);
    return Number.isFinite(parsed) ? parsed : null;
  }

  load(
    context: LoaderContext,
    config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>,
  ): void {
    this.context = context;
    this.callbacks = callbacks;
    this.responseHeaders.clear();
    this.stats = createLoadStats();
    this.stats.loading.start = performance.now();
    this.stats.loading.first = 0;

    const headers: Record<string, string> = { ...context.headers };
    if (typeof context.rangeStart === "number") {
      const end = typeof context.rangeEnd === "number" ? String(context.rangeEnd - 1) : "";
      headers.Range = `bytes=${context.rangeStart}-${end}`;
    }

    const isBinary = context.responseType === "arraybuffer";
    const timeout = config.loadPolicy?.maxLoadTimeMs || config.timeout || 15000;

    const markFirstByte = (): void => {
      if (this.stats.loading.first === 0) {
        this.stats.loading.first = Math.max(performance.now(), this.stats.loading.start);
      }
    };

    const handle = GM_xmlhttpRequest({
      method: "GET",
      url: context.url,
      headers,
      responseType: isBinary ? "arraybuffer" : "text",
      timeout,
      onreadystatechange: (res) => {
        if (this.stats.aborted) return;
        if ((res.readyState ?? 0) >= 2) {
          markFirstByte();
        }
      },
      onprogress: (res) => {
        if (this.stats.aborted) return;
        markFirstByte();
        if (typeof res.loaded === "number") this.stats.loaded = res.loaded;
        if (typeof res.total === "number" && res.total > 0) this.stats.total = res.total;
      },
      onload: (res) => {
        this.requestHandle = null;
        if (this.stats.aborted) return;

        const now = Math.max(performance.now(), this.stats.loading.start);
        if (this.stats.loading.first === 0) {
          // If the userscript manager didn't fire progress/readystatechange, avoid attributing
          // 100% of total download duration to TTFB (which causes ABR to drop quality).
          this.stats.loading.first =
            this.stats.loading.start + (now - this.stats.loading.start) * 0.2;
        }
        this.stats.loading.end = Math.max(now, this.stats.loading.first);
        this.responseHeaders = parseHeaders(res.responseHeaders);

        if (res.status >= 200 && res.status < 300) {
          const data = isBinary
            ? (res.response as ArrayBuffer)
            : typeof res.response === "string"
              ? res.response
              : res.responseText;

          const size = isBinary
            ? data instanceof ArrayBuffer
              ? data.byteLength
              : 0
            : typeof data === "string"
              ? data.length
              : 0;

          this.stats.loaded = size;
          this.stats.total = size;
          const transferMs = Math.max(1, this.stats.loading.end - this.stats.loading.first);
          this.stats.bwEstimate = (size * 8000) / transferMs;

          callbacks.onSuccess(
            {
              url: res.finalUrl || context.url,
              data,
              code: res.status,
              text: res.statusText,
            },
            this.stats,
            context,
            null,
          );
        } else {
          callbacks.onError(
            { code: res.status, text: res.statusText || `HTTP ${res.status}` },
            context,
            null,
            this.stats,
          );
        }
      },
      onerror: (err) => {
        this.requestHandle = null;
        if (this.stats.aborted) return;
        callbacks.onError(
          { code: 0, text: err instanceof Error ? err.message : "Network error" },
          context,
          null,
          this.stats,
        );
      },
      ontimeout: () => {
        this.requestHandle = null;
        if (this.stats.aborted) return;
        callbacks.onTimeout(this.stats, context, null);
      },
    });

    this.requestHandle = handle ?? null;
  }
}
