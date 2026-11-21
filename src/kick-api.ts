import {
  LIVE_CHECK_CACHE_TTL_MS,
  LIVE_CHECK_TIMEOUT_MS,
  type AppState,
  type KickLiveMatch,
} from "./config";

function getCandidateKickSlugs(twitchChannel: string): string[] {
  const candidates = [twitchChannel];
  if (twitchChannel.includes("_")) {
    const hyphenated = twitchChannel.replace(/_/g, "-");
    if (hyphenated !== twitchChannel) {
      candidates.push(hyphenated);
    }
  }
  return candidates;
}

function parseKickLivestreamPayload(rawText: string, kickChannel: string): KickLiveMatch | null {
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (!parsed || typeof parsed !== "object") return null;

    const root = parsed as Record<string, unknown>;
    const streamObj =
      (root.data && typeof root.data === "object"
        ? (root.data as Record<string, unknown>)
        : null) ||
      (root.livestream && typeof root.livestream === "object"
        ? (root.livestream as Record<string, unknown>)
        : null);

    if (!streamObj) return null;

    const isLive =
      streamObj.is_live === true ||
      (streamObj.is_live !== false && typeof streamObj.id === "number");
    if (!isLive) return null;

    const title =
      typeof streamObj.session_title === "string" ? streamObj.session_title.trim() : null;
    const viewerCount = typeof streamObj.viewer_count === "number" ? streamObj.viewer_count : null;

    let category: string | null = null;
    if (streamObj.category && typeof streamObj.category === "object") {
      const catName = (streamObj.category as Record<string, unknown>).name;
      if (typeof catName === "string" && catName.trim()) category = catName.trim();
    } else if (Array.isArray(streamObj.categories) && streamObj.categories.length > 0) {
      const first = streamObj.categories[0];
      if (first && typeof first === "object") {
        const catName = (first as Record<string, unknown>).name;
        if (typeof catName === "string" && catName.trim()) category = catName.trim();
      }
    }

    return {
      kickChannel,
      title: title || null,
      viewerCount,
      category,
    };
  } catch {
    return null;
  }
}

function fetchKickLivestream(kickChannel: string): Promise<KickLiveMatch | null> {
  if (typeof GM_xmlhttpRequest !== "function") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      GM_xmlhttpRequest({
        method: "GET",
        url: `https://kick.com/api/v2/channels/${encodeURIComponent(kickChannel)}/livestream`,
        headers: {
          Accept: "application/json",
        },
        timeout: LIVE_CHECK_TIMEOUT_MS,
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) {
            resolve(parseKickLivestreamPayload(response.responseText, kickChannel));
          } else {
            resolve(null);
          }
        },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    } catch {
      resolve(null);
    }
  });
}

export function findLiveMatchingKickStream(
  state: AppState,
  twitchChannel: string,
): Promise<KickLiveMatch | null> {
  const cached = state.liveCheckCache.get(twitchChannel);
  if (cached && Date.now() - cached.checkedAt < LIVE_CHECK_CACHE_TTL_MS) {
    return Promise.resolve(cached.match);
  }

  const inFlight = state.inFlightChecks.get(twitchChannel);
  if (inFlight) return inFlight;

  const promise = (async (): Promise<KickLiveMatch | null> => {
    const candidates = getCandidateKickSlugs(twitchChannel);
    let match: KickLiveMatch | null = null;

    for (const slug of candidates) {
      const result = await fetchKickLivestream(slug);
      if (result) {
        match = result;
        break;
      }
    }

    state.liveCheckCache.set(twitchChannel, {
      checkedAt: Date.now(),
      match,
    });
    return match;
  })().finally(() => {
    state.inFlightChecks.delete(twitchChannel);
  });

  state.inFlightChecks.set(twitchChannel, promise);
  return promise;
}

function parsePlaybackUrl(rawText: string): string | null {
  try {
    const parsed: unknown = JSON.parse(rawText);
    if (!parsed || typeof parsed !== "object") return null;

    const root = parsed as Record<string, unknown>;
    const livestream = root.livestream;
    if (!livestream || typeof livestream !== "object") return null;

    const streamObj = livestream as Record<string, unknown>;
    if (streamObj.is_live === false) return null;

    const rawUrl = root.playback_url;
    if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;

    const normalized = rawUrl.trim().replace(/\\\//g, "/");
    return /^https?:\/\//i.test(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

export function fetchKickPlaybackUrl(kickChannel: string): Promise<string | null> {
  if (typeof GM_xmlhttpRequest !== "function") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      GM_xmlhttpRequest({
        method: "GET",
        url: `https://kick.com/api/v2/channels/${encodeURIComponent(kickChannel)}`,
        headers: {
          Accept: "application/json",
        },
        timeout: LIVE_CHECK_TIMEOUT_MS,
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) {
            resolve(parsePlaybackUrl(response.responseText));
          } else {
            resolve(null);
          }
        },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null),
      });
    } catch {
      resolve(null);
    }
  });
}
