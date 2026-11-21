import Hls, { type Level } from 'hls.js';
import type { Settings } from './config';
import { GmHlsLoader } from './hls-loader';

export interface HlsPlayerCallbacks {
  onVolumeChange: (volume: number) => void;
  onFallbackToEmbed: () => void;
}

function formatQualityLabel(level: Level): string {
  const height = level.height ? `${level.height}p` : `${Math.round(level.bitrate / 1000)}k`;
  const fps = level.frameRate && level.frameRate >= 50 ? `${Math.round(level.frameRate)}` : '';
  return `${height}${fps}`;
}

export function mountHlsPlayer(
  overlay: HTMLElement,
  playbackUrl: string,
  kickChannel: string,
  settings: Settings,
  callbacks: HlsPlayerCallbacks
): () => void {
  overlay.replaceChildren();

  const video = document.createElement('video');
  video.className = 'tk-hls-video';
  video.playsInline = true;
  video.muted = settings.muted;
  video.volume = settings.volume;
  video.setAttribute('aria-label', `Kick stream for ${kickChannel}`);

  const controls = document.createElement('div');
  controls.className = 'tk-hls-controls';

  const leftGroup = document.createElement('div');
  leftGroup.className = 'tk-hls-controls-group';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'tk-hls-btn';
  playBtn.title = 'Play / Pause';
  playBtn.textContent = '❚❚';

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'tk-hls-btn';
  muteBtn.title = 'Mute / Unmute';

  const volumeSlider = document.createElement('input');
  volumeSlider.type = 'range';
  volumeSlider.className = 'tk-hls-volume';
  volumeSlider.min = '0';
  volumeSlider.max = '1';
  volumeSlider.step = '0.02';
  volumeSlider.value = String(settings.muted ? 0 : settings.volume);
  volumeSlider.setAttribute('aria-label', 'Volume');

  const liveBtn = document.createElement('button');
  liveBtn.type = 'button';
  liveBtn.className = 'tk-hls-live-btn';
  liveBtn.title = 'Jump to live edge';
  const liveDot = document.createElement('span');
  liveDot.className = 'tk-kick-dot';
  liveBtn.append(liveDot, document.createTextNode('LIVE'));

  leftGroup.append(playBtn, muteBtn, volumeSlider, liveBtn);

  const rightGroup = document.createElement('div');
  rightGroup.className = 'tk-hls-controls-group';

  const qualitySelect = document.createElement('select');
  qualitySelect.className = 'tk-hls-quality';
  qualitySelect.setAttribute('aria-label', 'Stream quality');
  const autoOption = document.createElement('option');
  autoOption.value = '-1';
  autoOption.textContent = 'Auto';
  qualitySelect.appendChild(autoOption);

  const pipBtn = document.createElement('button');
  pipBtn.type = 'button';
  pipBtn.className = 'tk-hls-btn';
  pipBtn.textContent = 'PiP';
  pipBtn.title = 'Picture-in-Picture';
  if (!('pictureInPictureEnabled' in document) || !document.pictureInPictureEnabled) {
    pipBtn.style.display = 'none';
  }

  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.type = 'button';
  fullscreenBtn.className = 'tk-hls-btn';
  fullscreenBtn.textContent = '⛶';
  fullscreenBtn.title = 'Fullscreen';

  rightGroup.append(qualitySelect, pipBtn, fullscreenBtn);
  controls.append(leftGroup, rightGroup);
  overlay.append(video, controls);

  let hls: Hls | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let mediaRecoveryAttempts = 0;
  let destroyed = false;

  const updatePlayIcon = (): void => {
    playBtn.textContent = video.paused ? '▶' : '❚❚';
    overlay.classList.toggle('tk-hls-paused', video.paused);
  };

  const updateMuteIcon = (): void => {
    const effectivelyMuted = video.muted || video.volume === 0;
    muteBtn.textContent = effectivelyMuted ? '🔇' : video.volume < 0.5 ? '🔉' : '🔊';
    volumeSlider.value = String(effectivelyMuted ? 0 : video.volume);
  };

  const bumpControlsVisibility = (): void => {
    overlay.classList.add('tk-hls-controls-visible');
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!video.paused) {
        overlay.classList.remove('tk-hls-controls-visible');
      }
    }, 2500);
  };

  const togglePlay = (): void => {
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  const toggleFullscreen = (): void => {
    if (document.fullscreenElement === overlay) {
      void document.exitFullscreen?.();
    } else {
      void overlay.requestFullscreen?.();
    }
  };

  playBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlay();
  });

  video.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlay();
  });

  video.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    toggleFullscreen();
  });

  muteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (video.muted || video.volume === 0) {
      video.muted = false;
      if (video.volume === 0) {
        video.volume = settings.volume > 0 ? settings.volume : 1;
      }
    } else {
      video.muted = true;
    }
    updateMuteIcon();
  });

  volumeSlider.addEventListener('input', (e) => {
    e.stopPropagation();
    const vol = Number.parseFloat(volumeSlider.value);
    if (Number.isFinite(vol)) {
      video.volume = vol;
      video.muted = vol === 0;
      if (vol > 0) callbacks.onVolumeChange(vol);
      updateMuteIcon();
    }
  });

  liveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (hls && typeof hls.liveSyncPosition === 'number' && Number.isFinite(hls.liveSyncPosition)) {
      video.currentTime = hls.liveSyncPosition;
    } else if (video.seekable.length > 0) {
      video.currentTime = video.seekable.end(video.seekable.length - 1);
    }
    if (video.paused) {
      video.play().catch(() => {});
    }
  });

  qualitySelect.addEventListener('change', (e) => {
    e.stopPropagation();
    if (!hls) return;
    const selected = Number.parseInt(qualitySelect.value, 10);
    if (!Number.isFinite(selected)) return;

    if (selected === -1) {
      // Smoothly return to Auto ABR without flushing already-buffered high-res segments
      hls.nextLevel = -1;
    } else {
      hls.currentLevel = selected;
    }
  });

  pipBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (document.pictureInPictureElement === video) {
      void document.exitPictureInPicture?.();
    } else {
      void video.requestPictureInPicture?.();
    }
  });

  fullscreenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFullscreen();
  });

  const onMouseMove = (): void => bumpControlsVisibility();
  const onMouseLeave = (): void => {
    if (!video.paused) overlay.classList.remove('tk-hls-controls-visible');
  };

  video.addEventListener('play', updatePlayIcon);
  video.addEventListener('pause', updatePlayIcon);
  video.addEventListener('volumechange', updateMuteIcon);
  overlay.addEventListener('mousemove', onMouseMove);
  overlay.addEventListener('mouseleave', onMouseLeave);

  updatePlayIcon();
  updateMuteIcon();
  bumpControlsVisibility();

  const startPlayback = (): void => {
    if (!settings.autoplay) return;
    video.play().catch(() => {
      // Browser blocked unmuted autoplay: retry muted so stream starts immediately
      if (!video.muted) {
        video.muted = true;
        updateMuteIcon();
        video.play().catch(() => {});
      }
    });
  };

  if (Hls.isSupported()) {
    hls = new Hls({
      lowLatencyMode: true,
      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 5,
      maxBufferLength: 15,
      backBufferLength: 10,
      abrEwmaDefaultEstimate: 10_000_000,
      abrBandWidthFactor: 0.95,
      abrBandWidthUpFactor: 0.85,
      capLevelToPlayerSize: false,
      ...(typeof GM_xmlhttpRequest === 'function' ? { loader: GmHlsLoader } : {}),
    });

    const updateAutoOptionLabel = (activeLevelIndex: number): void => {
      const opt = qualitySelect.querySelector<HTMLOptionElement>('option[value="-1"]');
      if (!opt || !hls) return;
      const lvl = hls.levels[activeLevelIndex];
      opt.textContent = lvl ? `Auto (${formatQualityLabel(lvl)})` : 'Auto';
    };

    hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
      if (destroyed || !hls) return;

      qualitySelect.replaceChildren();
      const sorted = data.levels
        .map((level, index) => ({ level, index }))
        .sort((a, b) => {
          const hDiff = (b.level.height || 0) - (a.level.height || 0);
          if (hDiff !== 0) return hDiff;
          const fpsDiff = (b.level.frameRate || 0) - (a.level.frameRate || 0);
          if (fpsDiff !== 0) return fpsDiff;
          return (b.level.bitrate || 0) - (a.level.bitrate || 0);
        });

      const autoOpt = document.createElement('option');
      autoOpt.value = '-1';
      autoOpt.textContent = 'Auto';
      qualitySelect.appendChild(autoOpt);

      for (const { level, index } of sorted) {
        const opt = document.createElement('option');
        opt.value = String(index);
        opt.textContent = formatQualityLabel(level);
        qualitySelect.appendChild(opt);
      }

      // Default to Auto ABR
      hls.currentLevel = -1;
      qualitySelect.value = '-1';

      startPlayback();
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      if (destroyed) return;
      updateAutoOptionLabel(data.level);
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (destroyed || !data.fatal) return;

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveryAttempts < 2 && hls) {
        mediaRecoveryAttempts += 1;
        hls.recoverMediaError();
        return;
      }

      // Fatal error (e.g., manifest blocked or stream dropped): fall back to Kick embed iframe
      destroy();
      callbacks.onFallbackToEmbed();
    });

    hls.loadSource(playbackUrl);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = playbackUrl;
    startPlayback();
  } else {
    callbacks.onFallbackToEmbed();
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    overlay.removeEventListener('mousemove', onMouseMove);
    overlay.removeEventListener('mouseleave', onMouseLeave);
    if (hls) {
      hls.destroy();
      hls = null;
    }
    video.pause();
    video.removeAttribute('src');
    video.load?.();
  }

  return destroy;
}
