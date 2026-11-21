import Hls from 'hls.js';
import { IDS, type AppState } from './config';
import { mountHlsPlayer } from './hls-player';
import { fetchKickPlaybackUrl } from './kick-api';
import { buildKickEmbedUrl, saveSettings } from './storage';

export interface PlayerCallbacks {
  onSwitchToTwitch: (twitchChannel: string) => void;
  onSwitchToKick: (twitchChannel: string) => void;
  onOpenWhitelist: () => void;
}

export function findPlayerContainer(): HTMLElement | null {
  const selectors = [
    '[data-a-target="video-player"] .video-player__container',
    '.video-player__container',
    '[data-a-target="video-player"]',
    '.video-player',
  ];

  for (const selector of selectors) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 100 && rect.height > 80) {
        return el;
      }
    }
  }

  // Fallback when streamer is offline on Twitch but live on Kick
  const offlineContainer = document.querySelector<HTMLElement>('.channel-root__player');
  if (offlineContainer) {
    const rect = offlineContainer.getBoundingClientRect();
    if (rect.width > 200 && rect.height > 120) {
      return offlineContainer;
    }
  }

  return null;
}

function findLowestCommonAncestor(a: HTMLElement, b: HTMLElement): HTMLElement | null {
  const ancestors = new Set<HTMLElement>();
  let cur: HTMLElement | null = a;
  while (cur) {
    ancestors.add(cur);
    cur = cur.parentElement;
  }
  cur = b;
  while (cur) {
    if (ancestors.has(cur)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

/**
 * Finds the Twitch action button row below the stream (inline next to
 * Follow/Unfollow, Notifications, Bits, Gift a Sub, Subscribe).
 */
export function findActionBarContainer(): HTMLElement | null {
  const infoScope =
    document.querySelector<HTMLElement>('#live-channel-stream-information') ??
    document.querySelector<HTMLElement>('[data-a-target="channel-info-content"]') ??
    document;

  const anchorSelectors = [
    '[data-a-target="follow-button"]',
    '[data-a-target="unfollow-button"]',
    '[data-a-target="notifications-toggle"]',
    '[data-a-target="gift-button"]',
    '[data-a-target="subscribe-button"]',
    'button[aria-label^="Follow" i]',
    'button[aria-label^="Unfollow" i]',
    'button[aria-label*="Gift a Sub" i]',
    'button[aria-label*="Subscribe" i]',
  ];

  const foundButtons: HTMLElement[] = [];
  for (const selector of anchorSelectors) {
    const el = infoScope.querySelector<HTMLElement>(selector);
    if (el && !foundButtons.includes(el)) {
      foundButtons.push(el);
    }
  }

  // When 2+ action buttons exist, their lowest common ancestor is the exact button row
  if (foundButtons.length >= 2) {
    const lca = findLowestCommonAncestor(foundButtons[0], foundButtons[foundButtons.length - 1]);
    if (lca && !lca.querySelector('h1')) {
      return lca;
    }
  }

  // Single-button fallback (e.g., unmonetized channel with only Follow)
  if (foundButtons.length === 1) {
    let candidate = foundButtons[0].parentElement;
    for (let depth = 0; depth < 6 && candidate; depth++) {
      if (candidate.querySelector('h1')) break;
      const style = getComputedStyle(candidate);
      const isRowFlex =
        (style.display === 'flex' || style.display === 'inline-flex') &&
        style.flexDirection !== 'column';
      if (isRowFlex && candidate.children.length >= 2) {
        return candidate;
      }
      candidate = candidate.parentElement;
    }
    if (foundButtons[0].parentElement) {
      return foundButtons[0].parentElement;
    }
  }

  // Wait until Twitch finishes rendering the action buttons instead of mounting above the header
  return null;
}

export function silenceTwitchVideos(state: AppState, container: HTMLElement | null): void {
  const videos = new Set<HTMLVideoElement>();

  if (container) {
    container.querySelectorAll<HTMLVideoElement>('video').forEach((v) => videos.add(v));
  }
  document
    .querySelectorAll<HTMLVideoElement>('.video-player video, .persistent-player video')
    .forEach((v) => videos.add(v));

  for (const video of videos) {
    // Never silence our own direct Kick HLS <video> element
    if (video.closest(`#${IDS.overlay}`)) continue;

    if (!state.silencedVideos.has(video)) {
      const prevMuted = video.muted;
      const onPlay = (): void => {
        if (state.activeKickChannel) {
          if (!video.muted) video.muted = true;
          if (!video.paused) video.pause();
        }
      };
      const onVolumeChange = (): void => {
        if (state.activeKickChannel && !video.muted) {
          video.muted = true;
        }
      };

      video.addEventListener('play', onPlay);
      video.addEventListener('volumechange', onVolumeChange);
      state.silencedVideos.set(video, { onPlay, onVolumeChange, prevMuted });
    }

    video.classList.add('tk-twitch-video-hidden');
    if (!video.muted) video.muted = true;
    if (!video.paused) video.pause();
  }
}

export function restoreTwitchVideos(state: AppState, { resumePlayback = false } = {}): void {
  for (const [video, handlers] of state.silencedVideos.entries()) {
    video.removeEventListener('play', handlers.onPlay);
    video.removeEventListener('volumechange', handlers.onVolumeChange);
    video.classList.remove('tk-twitch-video-hidden');
    if (resumePlayback && video.isConnected) {
      video.muted = handlers.prevMuted;
      video.play().catch(() => {});
    }
  }
  state.silencedVideos.clear();
}

export function removeControlsBar(): void {
  const existing = document.getElementById(IDS.controlsBar);
  if (existing) existing.remove();
}

export function removeRestoreBadge(): void {
  const existing = document.getElementById(IDS.restoreBadge);
  if (existing) existing.remove();
}

export function mountControlsBar(
  state: AppState,
  actionBar: HTMLElement,
  twitchChannel: string,
  kickChannel: string,
  callbacks: PlayerCallbacks
): void {
  if (!state.settings.showBadge) {
    removeControlsBar();
    return;
  }

  const existing = document.getElementById(IDS.controlsBar);
  if (
    existing &&
    existing.parentElement === actionBar &&
    existing.dataset.twitchChannel === twitchChannel &&
    existing.dataset.kickChannel === kickChannel
  ) {
    return;
  }
  removeControlsBar();

  const bar = document.createElement('div');
  bar.id = IDS.controlsBar;
  bar.className = 'tk-action-group';
  bar.dataset.twitchChannel = twitchChannel;
  bar.dataset.kickChannel = kickChannel;

  const link = document.createElement('a');
  link.className = 'tk-action-btn tk-action-btn--kick-outline';
  link.href = `https://kick.com/${encodeURIComponent(kickChannel)}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = `Open kick.com/${kickChannel} in a new tab`;

  const dot = document.createElement('span');
  dot.className = 'tk-kick-dot';
  link.append(dot, document.createTextNode(`Kick: ${kickChannel}`));

  const switchBtn = document.createElement('button');
  switchBtn.type = 'button';
  switchBtn.className = 'tk-action-btn tk-action-btn--secondary';
  switchBtn.textContent = 'Twitch';
  switchBtn.title = 'Temporarily switch back to the native Twitch player';
  switchBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    callbacks.onSwitchToTwitch(twitchChannel);
  });

  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'tk-action-btn tk-action-btn--secondary';
  settingsBtn.textContent = 'Whitelist';
  settingsBtn.title = 'Manage Twitch Kicker whitelist & settings';
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    callbacks.onOpenWhitelist();
  });

  bar.append(link, switchBtn, settingsBtn);
  actionBar.prepend(bar);
}

export function mountRestoreBadge(
  state: AppState,
  actionBar: HTMLElement,
  twitchChannel: string,
  kickChannel: string,
  callbacks: PlayerCallbacks
): void {
  if (!state.settings.showBadge) {
    removeRestoreBadge();
    return;
  }

  const existing = document.getElementById(IDS.restoreBadge);
  if (
    existing &&
    existing.parentElement === actionBar &&
    existing.dataset.twitchChannel === twitchChannel &&
    existing.dataset.kick === kickChannel
  ) {
    return;
  }
  removeRestoreBadge();

  const wrapper = document.createElement('div');
  wrapper.id = IDS.restoreBadge;
  wrapper.className = 'tk-action-group';
  wrapper.dataset.twitchChannel = twitchChannel;
  wrapper.dataset.kick = kickChannel;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tk-action-btn tk-action-btn--kick';
  btn.title = `Switch player to kick.com/${kickChannel}`;

  const dot = document.createElement('span');
  dot.className = 'tk-kick-dot';
  btn.append(dot, document.createTextNode(`Switch to Kick`));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    callbacks.onSwitchToKick(twitchChannel);
  });

  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'tk-action-btn tk-action-btn--secondary';
  settingsBtn.textContent = 'Whitelist';
  settingsBtn.title = 'Manage Twitch Kicker whitelist & settings';
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    callbacks.onOpenWhitelist();
  });

  wrapper.append(btn, settingsBtn);
  actionBar.prepend(wrapper);
}

export function unmountKickOverlay(state: AppState, { resumeTwitch = false } = {}): void {
  state.mountSeq += 1;
  if (state.activePlayerTeardown) {
    state.activePlayerTeardown();
    state.activePlayerTeardown = null;
  }

  const existing = document.getElementById(IDS.overlay);
  if (existing) existing.remove();
  removeControlsBar();

  if (
    state.activeContainer &&
    state.activeContainerOriginalPosition !== null &&
    state.activeContainer.isConnected
  ) {
    state.activeContainer.style.position = state.activeContainerOriginalPosition;
  }

  state.activeTwitchChannel = null;
  state.activeKickChannel = null;
  state.activeContainer = null;
  state.activeContainerOriginalPosition = null;

  restoreTwitchVideos(state, { resumePlayback: resumeTwitch });
}

function mountEmbedIframe(overlay: HTMLElement, kickChannel: string, embedSrc: string): void {
  overlay.replaceChildren();
  overlay.dataset.mode = 'embed';

  const iframe = document.createElement('iframe');
  iframe.className = 'tk-kick-iframe';
  iframe.src = embedSrc;
  iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture';
  iframe.allowFullscreen = true;
  iframe.setAttribute('frameborder', '0');
  iframe.setAttribute('scrolling', 'no');
  iframe.title = `Kick stream for ${kickChannel}`;

  overlay.appendChild(iframe);
}

export function mountKickOverlay(
  state: AppState,
  container: HTMLElement,
  twitchChannel: string,
  kickChannel: string
): void {
  removeRestoreBadge();

  const existing = document.getElementById(IDS.overlay);
  const desiredMode = state.settings.preferDirectHls && Hls.isSupported() ? 'hls' : 'embed';
  const desiredEmbedSrc = buildKickEmbedUrl(kickChannel, state.settings);
  const desiredKey = `${desiredMode}:${kickChannel}:${desiredEmbedSrc}`;

  // Already mounted cleanly for this channel, mode & container — just keep Twitch muted
  if (
    existing &&
    existing.parentElement === container &&
    state.activeTwitchChannel === twitchChannel &&
    state.activeKickChannel === kickChannel &&
    existing.dataset.mountKey === desiredKey
  ) {
    silenceTwitchVideos(state, container);
    return;
  }

  unmountKickOverlay(state, { resumeTwitch: false });

  const computedPos = getComputedStyle(container).position;
  if (computedPos === 'static') {
    state.activeContainerOriginalPosition = container.style.position;
    container.style.position = 'relative';
  } else {
    state.activeContainerOriginalPosition = null;
  }

  const overlay = document.createElement('div');
  overlay.id = IDS.overlay;
  overlay.dataset.twitchChannel = twitchChannel;
  overlay.dataset.kickChannel = kickChannel;
  overlay.dataset.mountKey = desiredKey;

  state.activeTwitchChannel = twitchChannel;
  state.activeKickChannel = kickChannel;
  state.activeContainer = container;

  const seq = ++state.mountSeq;

  if (desiredMode === 'hls') {
    overlay.dataset.mode = 'hls';
    const loading = document.createElement('div');
    loading.className = 'tk-hls-loading';
    loading.textContent = `Loading Kick stream (${kickChannel})…`;
    overlay.appendChild(loading);
    container.appendChild(overlay);
    silenceTwitchVideos(state, container);

    void fetchKickPlaybackUrl(kickChannel).then((playbackUrl) => {
      if (state.mountSeq !== seq || !overlay.isConnected) return;

      if (!playbackUrl) {
        mountEmbedIframe(overlay, kickChannel, desiredEmbedSrc);
        return;
      }

      state.activePlayerTeardown = mountHlsPlayer(overlay, playbackUrl, kickChannel, state.settings, {
        onVolumeChange: (volume) => {
          state.settings = saveSettings({ ...state.settings, volume });
        },
        onFallbackToEmbed: () => {
          if (state.mountSeq !== seq || !overlay.isConnected) return;
          state.activePlayerTeardown = null;
          mountEmbedIframe(overlay, kickChannel, desiredEmbedSrc);
        },
      });
    });
    return;
  }

  mountEmbedIframe(overlay, kickChannel, desiredEmbedSrc);
  container.appendChild(overlay);
  silenceTwitchVideos(state, container);
}
