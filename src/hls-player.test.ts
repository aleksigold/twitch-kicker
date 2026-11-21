import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from './config';

type HlsHandler = (event: string, data: unknown) => void;

interface MockHlsInstance {
  config: Record<string, unknown>;
  currentLevel: number;
  nextLevel: number;
  liveSyncPosition: number | null;
  levels: Array<{ height: number; frameRate?: number; bitrate: number }>;
  loadSource: ReturnType<typeof vi.fn>;
  attachMedia: ReturnType<typeof vi.fn>;
  recoverMediaError: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  emit: (event: string, data: unknown) => void;
}

const mockHlsState = {
  supported: true,
  instances: [] as MockHlsInstance[],
};

vi.mock('hls.js', () => {
  class MockHls {
    static isSupported = () => mockHlsState.supported;
    static Events = {
      MANIFEST_PARSED: 'hlsManifestParsed',
      LEVEL_SWITCHED: 'hlsLevelSwitched',
      ERROR: 'hlsError',
    };
    static ErrorTypes = {
      MEDIA_ERROR: 'mediaError',
      NETWORK_ERROR: 'networkError',
    };

    config: Record<string, unknown>;
    currentLevel = -1;
    nextLevel = -1;
    liveSyncPosition: number | null = 120;
    levels: Array<{ height: number; frameRate?: number; bitrate: number }> = [];
    loadSource = vi.fn();
    attachMedia = vi.fn();
    recoverMediaError = vi.fn();
    destroy = vi.fn();
    private handlers = new Map<string, HlsHandler[]>();

    constructor(config: Record<string, unknown> = {}) {
      this.config = config;
      mockHlsState.instances.push(this);
    }

    on(event: string, fn: HlsHandler): void {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
    }

    emit(event: string, data: unknown): void {
      for (const fn of this.handlers.get(event) ?? []) {
        fn(event, data);
      }
    }
  }

  return { default: MockHls };
});

import { GmHlsLoader } from './hls-loader';
import { mountHlsPlayer, type HlsPlayerCallbacks } from './hls-player';

function makeVideoControllable(video: HTMLVideoElement, playImpl?: () => Promise<void>): {
  setPaused: (v: boolean) => void;
  playSpy: ReturnType<typeof vi.fn>;
  pauseSpy: ReturnType<typeof vi.fn>;
} {
  let paused = true;
  Object.defineProperty(video, 'paused', {
    configurable: true,
    get: () => paused,
  });

  const playSpy = vi.fn(() => {
    if (playImpl) {
      return playImpl();
    }
    paused = false;
    video.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  const pauseSpy = vi.fn(() => {
    paused = true;
    video.dispatchEvent(new Event('pause'));
  });

  video.play = playSpy;
  video.pause = pauseSpy;
  return {
    setPaused: (v: boolean) => {
      paused = v;
    },
    playSpy,
    pauseSpy,
  };
}

describe('hls-player', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    mockHlsState.supported = true;
    mockHlsState.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('configures GmHlsLoader only when GM_xmlhttpRequest is available and renders initial video state', () => {
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const callbacks: HlsPlayerCallbacks = {
      onVolumeChange: vi.fn(),
      onFallbackToEmbed: vi.fn(),
    };

    vi.stubGlobal('GM_xmlhttpRequest', vi.fn());
    const teardown1 = mountHlsPlayer(
      overlay,
      'https://example.com/live.m3u8',
      'sick_nerd',
      { ...DEFAULT_SETTINGS, muted: true, volume: 0.7 },
      callbacks
    );

    expect(mockHlsState.instances[0].config.loader).toBe(GmHlsLoader);
    expect(mockHlsState.instances[0].loadSource).toHaveBeenCalledWith(
      'https://example.com/live.m3u8'
    );
    const video = overlay.querySelector<HTMLVideoElement>('video')!;
    expect(video.muted).toBe(true);
    expect(video.volume).toBe(0.7);
    expect(video.getAttribute('aria-label')).toBe('Kick stream for sick_nerd');
    const slider = overlay.querySelector<HTMLInputElement>('.tk-hls-volume')!;
    expect(slider.value).toBe('0');
    teardown1();

    vi.stubGlobal('GM_xmlhttpRequest', undefined);
    const teardown2 = mountHlsPlayer(
      overlay,
      'https://example.com/live.m3u8',
      'sick_nerd',
      { ...DEFAULT_SETTINGS, muted: false, volume: 0.6 },
      callbacks
    );
    expect(mockHlsState.instances[1].config.loader).toBeUndefined();
    expect(overlay.querySelector<HTMLInputElement>('.tk-hls-volume')?.value).toBe('0.6');
    teardown2();
  });

  it('handles play/pause, mute/unmute, volume slider, quality selection, LIVE seek, PiP, fullscreen, and idle controls', async () => {
    Object.defineProperty(document, 'pictureInPictureEnabled', {
      configurable: true,
      value: true,
    });

    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    overlay.requestFullscreen = requestFullscreen;
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    document.exitFullscreen = exitFullscreen;
    const exitPiP = vi.fn().mockResolvedValue(undefined);
    document.exitPictureInPicture = exitPiP;

    const callbacks: HlsPlayerCallbacks = {
      onVolumeChange: vi.fn(),
      onFallbackToEmbed: vi.fn(),
    };
    const settings: Settings = { ...DEFAULT_SETTINGS, muted: false, volume: 0.8, autoplay: true };
    const teardown = mountHlsPlayer(
      overlay,
      'https://example.com/live.m3u8',
      'streamer',
      settings,
      callbacks
    );

    const hls = mockHlsState.instances[0];
    const video = overlay.querySelector<HTMLVideoElement>('video')!;
    const requestPiP = vi.fn().mockResolvedValue({});
    video.requestPictureInPicture = requestPiP;
    const { playSpy, pauseSpy } = makeVideoControllable(video);

    const [playBtn, muteBtn, liveBtn, pipBtn, fullscreenBtn] = Array.from(
      overlay.querySelectorAll<HTMLButtonElement>('button')
    );
    const volumeSlider = overlay.querySelector<HTMLInputElement>('.tk-hls-volume')!;
    const qualitySelect = overlay.querySelector<HTMLSelectElement>('.tk-hls-quality')!;

    // PiP button is visible when pictureInPictureEnabled is true
    expect(pipBtn.style.display).not.toBe('none');

    // Play/pause via button & video click
    playBtn.click();
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(playBtn.textContent).toBe('❚❚');
    expect(overlay.classList.contains('tk-hls-paused')).toBe(false);

    video.click();
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(playBtn.textContent).toBe('▶');
    expect(overlay.classList.contains('tk-hls-paused')).toBe(true);

    // Mute button: unmuted -> muted -> unmuted
    muteBtn.click();
    expect(video.muted).toBe(true);
    expect(muteBtn.textContent).toBe('🔇');
    expect(volumeSlider.value).toBe('0');

    muteBtn.click();
    expect(video.muted).toBe(false);
    expect(muteBtn.textContent).toBe('🔊');
    expect(volumeSlider.value).toBe('0.8');

    // Volume slider to low (< 0.5) shows medium speaker and notifies callback
    volumeSlider.value = '0.3';
    volumeSlider.dispatchEvent(new Event('input'));
    expect(video.volume).toBe(0.3);
    expect(video.muted).toBe(false);
    expect(muteBtn.textContent).toBe('🔉');
    expect(callbacks.onVolumeChange).toHaveBeenCalledWith(0.3);

    // Volume slider to 0 mutes without calling onVolumeChange
    (callbacks.onVolumeChange as ReturnType<typeof vi.fn>).mockClear();
    volumeSlider.value = '0';
    volumeSlider.dispatchEvent(new Event('input'));
    expect(video.muted).toBe(true);
    expect(video.volume).toBe(0);
    expect(callbacks.onVolumeChange).not.toHaveBeenCalled();

    // Unmuting when volume === 0 restores settings.volume
    muteBtn.click();
    expect(video.muted).toBe(false);
    expect(video.volume).toBe(0.8);

    // LIVE button seeks to hls.liveSyncPosition and resumes when paused
    hls.liveSyncPosition = 245.5;
    liveBtn.click();
    expect(video.currentTime).toBe(245.5);
    expect(playSpy).toHaveBeenCalledTimes(2);

    // LIVE button falls back to video.seekable when liveSyncPosition is unavailable
    hls.liveSyncPosition = null;
    Object.defineProperty(video, 'seekable', {
      configurable: true,
      value: { length: 1, start: () => 0, end: () => 310 },
    });
    liveBtn.click();
    expect(video.currentTime).toBe(310);

    // Manifest parsed populates sorted quality options including bitrate-only rung
    hls.levels = [
      { height: 0, frameRate: 30, bitrate: 160_000 },
      { height: 720, frameRate: 30, bitrate: 2_500_000 },
      { height: 720, frameRate: 60, bitrate: 4_000_000 },
      { height: 720, frameRate: 60, bitrate: 3_000_000 },
      { height: 1080, frameRate: 60, bitrate: 8_000_000 },
    ];
    hls.emit('hlsManifestParsed', { levels: hls.levels });

    expect(Array.from(qualitySelect.options).map((o) => o.textContent)).toEqual([
      'Auto',
      '1080p60',
      '720p60',
      '720p60',
      '720p',
      '160k',
    ]);

    // Selecting manual quality updates currentLevel; returning to Auto sets nextLevel = -1
    qualitySelect.value = '4';
    qualitySelect.dispatchEvent(new Event('change'));
    expect(hls.currentLevel).toBe(4);

    qualitySelect.value = '-1';
    qualitySelect.dispatchEvent(new Event('change'));
    expect(hls.nextLevel).toBe(-1);

    // LEVEL_SWITCHED updates Auto label, including out-of-range index fallback
    hls.emit('hlsLevelSwitched', { level: 0 });
    expect(qualitySelect.options[0].textContent).toBe('Auto (160k)');
    hls.emit('hlsLevelSwitched', { level: 99 });
    expect(qualitySelect.options[0].textContent).toBe('Auto');

    // PiP toggle
    pipBtn.click();
    expect(requestPiP).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'pictureInPictureElement', {
      configurable: true,
      value: video,
    });
    pipBtn.click();
    expect(exitPiP).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'pictureInPictureElement', {
      configurable: true,
      value: null,
    });

    // Fullscreen toggle via button and video dblclick
    fullscreenBtn.click();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: overlay,
    });
    video.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: null,
    });

    // Controls visibility hides after 2500ms while playing, stays visible while paused
    overlay.dispatchEvent(new MouseEvent('mousemove'));
    expect(overlay.classList.contains('tk-hls-controls-visible')).toBe(true);
    vi.advanceTimersByTime(2500);
    expect(overlay.classList.contains('tk-hls-controls-visible')).toBe(false);

    overlay.dispatchEvent(new MouseEvent('mousemove'));
    expect(overlay.classList.contains('tk-hls-controls-visible')).toBe(true);
    overlay.dispatchEvent(new MouseEvent('mouseleave'));
    expect(overlay.classList.contains('tk-hls-controls-visible')).toBe(false);

    // When paused, mouseleave & idle timer keep controls visible
    video.pause();
    overlay.dispatchEvent(new MouseEvent('mousemove'));
    overlay.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(3000);
    expect(overlay.classList.contains('tk-hls-controls-visible')).toBe(true);

    // Destroy is idempotent
    teardown();
    teardown();
    expect(hls.destroy).toHaveBeenCalledTimes(1);
  });

  it('retries autoplay muted when browser blocks unmuted autoplay, and skips when autoplay is disabled', async () => {
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const callbacks: HlsPlayerCallbacks = {
      onVolumeChange: vi.fn(),
      onFallbackToEmbed: vi.fn(),
    };

    const teardown1 = mountHlsPlayer(
      overlay,
      'https://example.com/live.m3u8',
      'streamer',
      { ...DEFAULT_SETTINGS, autoplay: true, muted: false },
      callbacks
    );
    const hls1 = mockHlsState.instances[0];
    const video1 = overlay.querySelector<HTMLVideoElement>('video')!;
    let attempts = 0;
    const { playSpy } = makeVideoControllable(video1, () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve();
    });

    hls1.emit('hlsManifestParsed', { levels: [] });
    await vi.advanceTimersByTimeAsync(0);

    expect(playSpy).toHaveBeenCalledTimes(2);
    expect(video1.muted).toBe(true);
    teardown1();

    // Autoplay disabled
    const teardown2 = mountHlsPlayer(
      overlay,
      'https://example.com/live.m3u8',
      'streamer',
      { ...DEFAULT_SETTINGS, autoplay: false, muted: false },
      callbacks
    );
    const hls2 = mockHlsState.instances[1];
    const video2 = overlay.querySelector<HTMLVideoElement>('video')!;
    const { playSpy: playSpy2 } = makeVideoControllable(video2);

    hls2.emit('hlsManifestParsed', { levels: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(playSpy2).not.toHaveBeenCalled();
    teardown2();
  });

  it('attempts media error recovery twice before falling back to embed and ignores non-fatal errors', () => {
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const callbacks: HlsPlayerCallbacks = {
      onVolumeChange: vi.fn(),
      onFallbackToEmbed: vi.fn(),
    };

    mountHlsPlayer(
      overlay,
      'https://example.com/live.m3u8',
      'streamer',
      { ...DEFAULT_SETTINGS },
      callbacks
    );
    const hls = mockHlsState.instances[0];

    // Non-fatal error ignored
    hls.emit('hlsError', { fatal: false, type: 'mediaError' });
    expect(hls.recoverMediaError).not.toHaveBeenCalled();
    expect(callbacks.onFallbackToEmbed).not.toHaveBeenCalled();

    // First two fatal media errors trigger recovery
    hls.emit('hlsError', { fatal: true, type: 'mediaError' });
    hls.emit('hlsError', { fatal: true, type: 'mediaError' });
    expect(hls.recoverMediaError).toHaveBeenCalledTimes(2);
    expect(callbacks.onFallbackToEmbed).not.toHaveBeenCalled();

    // Third fatal media error tears down and falls back to embed
    hls.emit('hlsError', { fatal: true, type: 'mediaError' });
    expect(hls.destroy).toHaveBeenCalledTimes(1);
    expect(callbacks.onFallbackToEmbed).toHaveBeenCalledTimes(1);

    // Events after destroy are ignored
    hls.emit('hlsManifestParsed', { levels: [] });
    hls.emit('hlsLevelSwitched', { level: 0 });
    hls.emit('hlsError', { fatal: true, type: 'networkError' });
    expect(callbacks.onFallbackToEmbed).toHaveBeenCalledTimes(1);
  });

  it('uses native Safari HLS playback when Hls.isSupported() is false and canPlayType succeeds', () => {
    mockHlsState.supported = false;
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const callbacks: HlsPlayerCallbacks = {
      onVolumeChange: vi.fn(),
      onFallbackToEmbed: vi.fn(),
    };

    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === 'video') {
        const video = el as HTMLVideoElement;
        video.canPlayType = vi.fn(() => 'maybe' as CanPlayTypeResult);
        makeVideoControllable(video);
      }
      return el;
    });

    const teardown = mountHlsPlayer(
      overlay,
      'https://example.com/safari.m3u8',
      'streamer',
      { ...DEFAULT_SETTINGS, autoplay: true },
      callbacks
    );

    const video = overlay.querySelector<HTMLVideoElement>('video')!;
    expect(video.src).toBe('https://example.com/safari.m3u8');
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(callbacks.onFallbackToEmbed).not.toHaveBeenCalled();

    teardown();
    expect(video.getAttribute('src')).toBeNull();
  });

  it('falls back to embed immediately when neither hls.js nor native HLS is supported', () => {
    mockHlsState.supported = false;
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const callbacks: HlsPlayerCallbacks = {
      onVolumeChange: vi.fn(),
      onFallbackToEmbed: vi.fn(),
    };

    const teardown = mountHlsPlayer(
      overlay,
      'https://example.com/live.m3u8',
      'streamer',
      { ...DEFAULT_SETTINGS },
      callbacks
    );

    expect(callbacks.onFallbackToEmbed).toHaveBeenCalledTimes(1);
    teardown();
  });
});
