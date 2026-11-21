import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, IDS, type AppState } from "./config";
import {
  closeWhitelistModal,
  mountSuggestionBanner,
  openWhitelistModal,
  removeSuggestionBanner,
} from "./ui";

function createState(whitelist: Record<string, string> = {}): AppState {
  return {
    whitelist,
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
    lastHref: "https://www.twitch.tv/current_user",
    syncTimer: null,
    lastSilenceCheck: 0,
    modalKeyHandler: null,
  };
}

describe("ui", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    history.replaceState({}, "", "/current_user");
    vi.stubGlobal("GM_setValue", vi.fn<() => void>());
    vi.stubGlobal("alert", vi.fn<(message?: unknown) => void>());
    vi.stubGlobal(
      "prompt",
      vi.fn<(message?: string, defaultValue?: string) => string | null>(() => null),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  describe("mountSuggestionBanner / removeSuggestionBanner", () => {
    it("formats tooltip with optional metadata, stays idempotent, and handles Whitelist & Switch", () => {
      const state = createState();
      state.disabledChannels.add("streamer");
      const actionBar = document.createElement("div");
      document.body.appendChild(actionBar);
      const onSync = vi.fn<() => void>();

      mountSuggestionBanner(
        state,
        actionBar,
        "streamer",
        {
          kickChannel: "streamer-kick",
          title: "Big Grind",
          viewerCount: 1234,
          category: "OSRS",
        },
        onSync,
      );

      const banner = document.getElementById(IDS.suggestionBanner)!;
      expect(banner).not.toBeNull();
      const btn = banner.querySelector("button")!;
      expect(btn.title).toContain("Live on kick.com/streamer-kick");
      expect(btn.title).toContain("OSRS");
      expect(btn.title).toContain("Big Grind");
      expect(btn.title).toContain("viewers");

      // Idempotent call returns same element
      mountSuggestionBanner(
        state,
        actionBar,
        "streamer",
        { kickChannel: "streamer-kick", title: null, viewerCount: null, category: null },
        onSync,
      );
      expect(document.getElementById(IDS.suggestionBanner)).toBe(banner);

      // Clicking whitelists, clears disabledChannels, removes banner, and calls onSync
      btn.click();
      expect(state.whitelist).toEqual({ streamer: "streamer-kick" });
      expect(state.disabledChannels.has("streamer")).toBe(false);
      expect(document.getElementById(IDS.suggestionBanner)).toBeNull();
      expect(onSync).toHaveBeenCalledTimes(1);

      // Minimal tooltip when metadata fields are null
      mountSuggestionBanner(
        state,
        actionBar,
        "other",
        { kickChannel: "other", title: null, viewerCount: null, category: null },
        onSync,
      );
      expect(document.querySelector(`#${IDS.suggestionBanner} button`)?.getAttribute("title")).toBe(
        "Live on kick.com/other",
      );

      removeSuggestionBanner();
      expect(document.getElementById(IDS.suggestionBanner)).toBeNull();
    });
  });

  describe("openWhitelistModal / closeWhitelistModal", () => {
    it("pre-fills current channel, adds/removes sorted entries, and ignores invalid form submission", () => {
      const state = createState({ zeta: "zeta_kick" });
      state.disabledChannels.add("alpha");
      const onSync = vi.fn<() => void>();

      openWhitelistModal(state, onSync);

      const modal = document.querySelector(".tk-modal")!;
      const [twitchInput, kickInput] = Array.from(
        modal.querySelectorAll<HTMLInputElement>("form input"),
      );
      const form = modal.querySelector("form")!;

      expect(twitchInput.value).toBe("current_user");

      // Empty/invalid submission does nothing
      twitchInput.value = "!!!";
      kickInput.value = "";
      form.dispatchEvent(new Event("submit", { cancelable: true }));
      expect(onSync).not.toHaveBeenCalled();

      // Add with omitted Kick username defaults to Twitch username
      twitchInput.value = "https://www.twitch.tv/Alpha";
      kickInput.value = "";
      form.dispatchEvent(new Event("submit", { cancelable: true }));

      expect(state.whitelist).toEqual({ zeta: "zeta_kick", alpha: "alpha" });
      expect(state.disabledChannels.has("alpha")).toBe(false);
      expect(twitchInput.value).toBe("");
      expect(kickInput.value).toBe("");
      expect(onSync).toHaveBeenCalledTimes(1);

      // Entries are sorted alphabetically
      const items = Array.from(modal.querySelectorAll(".tk-list-item"));
      expect(items).toHaveLength(2);
      expect(items[0].textContent).toContain("twitch.tv/alpha");
      expect(items[1].textContent).toContain("twitch.tv/zeta");

      // Remove alpha
      items[0].querySelector<HTMLButtonElement>(".tk-btn-danger")!.click();
      expect(state.whitelist).toEqual({ zeta: "zeta_kick" });
      expect(onSync).toHaveBeenCalledTimes(2);

      // Remove remaining entry -> shows empty state
      modal.querySelector<HTMLButtonElement>(".tk-btn-danger")!.click();
      expect(modal.querySelector(".tk-empty")?.textContent).toContain("No whitelisted streamers");

      closeWhitelistModal(state);
    });

    it("toggles all settings checkboxes and persists changes", () => {
      const state = createState();
      const onSync = vi.fn<() => void>();
      openWhitelistModal(state, onSync);

      const checkboxes = Array.from(
        document.querySelectorAll<HTMLInputElement>('.tk-settings-section input[type="checkbox"]'),
      );
      expect(checkboxes).toHaveLength(5);

      for (const cb of checkboxes) {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change"));
      }

      expect(state.settings.preferDirectHls).toBe(false);
      expect(state.settings.autoplay).toBe(false);
      expect(state.settings.muted).toBe(true);
      expect(state.settings.showBadge).toBe(false);
      expect(state.settings.detectLiveKick).toBe(false);
      expect(onSync).toHaveBeenCalledTimes(5);

      closeWhitelistModal(state);
    });

    it("closes on backdrop click, close button, Done button, and Escape while ignoring inner clicks & other keys", () => {
      const state = createState();
      const onSync = vi.fn<() => void>();

      // Clicking inside modal does not close; clicking backdrop closes
      openWhitelistModal(state, onSync);
      const backdrop = document.getElementById(IDS.modalBackdrop)!;
      const modal = backdrop.querySelector<HTMLElement>(".tk-modal")!;
      modal.click();
      expect(document.getElementById(IDS.modalBackdrop)).not.toBeNull();
      backdrop.click();
      expect(document.getElementById(IDS.modalBackdrop)).toBeNull();

      // Close button (×)
      openWhitelistModal(state, onSync);
      document.querySelector<HTMLButtonElement>(".tk-modal-close")!.click();
      expect(document.getElementById(IDS.modalBackdrop)).toBeNull();

      // Done button
      openWhitelistModal(state, onSync);
      const doneBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === "Done",
      )!;
      doneBtn.click();
      expect(document.getElementById(IDS.modalBackdrop)).toBeNull();

      // Non-Escape key does not close; Escape closes and removes listener
      openWhitelistModal(state, onSync);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(document.getElementById(IDS.modalBackdrop)).not.toBeNull();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(document.getElementById(IDS.modalBackdrop)).toBeNull();
      expect(state.modalKeyHandler).toBeNull();
    });

    it("exports JSON via clipboard with prompt fallback when clipboard rejects or is unavailable", async () => {
      const state = createState({ sick_nerd: "sick_nerd" });
      const alertMock = vi.fn<(message?: unknown) => void>();
      const promptMock = vi.fn<(message?: string, defaultValue?: string) => string | null>();
      vi.stubGlobal("alert", alertMock);
      vi.stubGlobal("prompt", promptMock);

      // 1. Clipboard succeeds
      const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });

      openWhitelistModal(state, vi.fn<() => void>());
      const exportBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === "Export JSON",
      )!;

      exportBtn.click();
      await Promise.resolve();
      expect(writeText).toHaveBeenCalledWith(JSON.stringify(state.whitelist, null, 2));
      expect(alertMock).toHaveBeenCalledWith("Whitelist JSON copied to clipboard!");

      // 2. Clipboard rejects -> falls back to prompt
      writeText.mockRejectedValueOnce(new Error("denied"));
      exportBtn.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(promptMock).toHaveBeenCalledWith(
        "Copy your whitelist JSON:",
        JSON.stringify(state.whitelist, null, 2),
      );

      // 3. Clipboard unavailable -> falls back to prompt directly
      promptMock.mockClear();
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: undefined,
      });
      exportBtn.click();
      expect(promptMock).toHaveBeenCalledTimes(1);

      closeWhitelistModal(state);
    });

    it("imports valid JSON, ignores cancel, and alerts on malformed or non-object JSON", () => {
      const state = createState({ old: "old" });
      const onSync = vi.fn<() => void>();
      const alertMock = vi.fn<(message?: unknown) => void>();
      const promptMock = vi.fn<(message?: string, defaultValue?: string) => string | null>();
      vi.stubGlobal("alert", alertMock);
      vi.stubGlobal("prompt", promptMock);

      openWhitelistModal(state, onSync);
      const importBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === "Import JSON",
      )!;

      // Cancel (null)
      promptMock.mockReturnValueOnce(null);
      importBtn.click();
      expect(state.whitelist).toEqual({ old: "old" });
      expect(onSync).not.toHaveBeenCalled();

      // Invalid JSON syntax
      promptMock.mockReturnValueOnce("{bad");
      importBtn.click();
      expect(alertMock).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON:"));

      // Array instead of object
      alertMock.mockClear();
      promptMock.mockReturnValueOnce('["a", "b"]');
      importBtn.click();
      expect(alertMock).toHaveBeenCalledWith(
        "Invalid JSON: Expected a JSON object mapping Twitch usernames to Kick usernames.",
      );

      // Valid JSON object
      promptMock.mockReturnValueOnce(JSON.stringify({ New_User: "new-kick" }));
      importBtn.click();
      expect(state.whitelist).toEqual({ new_user: "new-kick" });
      expect(onSync).toHaveBeenCalledTimes(1);
      expect(document.querySelector(".tk-list")?.textContent).toContain("twitch.tv/new_user");

      closeWhitelistModal(state);
    });
  });
});
