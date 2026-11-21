import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, STORAGE_KEYS } from "./config";
import {
  buildKickEmbedUrl,
  getTwitchChannelFromPathname,
  loadSettings,
  loadWhitelist,
  normalizeChannelInput,
  normalizeWhitelist,
  saveSettings,
  saveWhitelist,
} from "./storage";

describe("storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  describe("normalizeChannelInput", () => {
    it("returns empty string for non-string inputs", () => {
      expect(normalizeChannelInput(null)).toBe("");
      expect(normalizeChannelInput(undefined)).toBe("");
      expect(normalizeChannelInput(123)).toBe("");
      expect(normalizeChannelInput({})).toBe("");
    });

    it("trims, lowercases, and strips leading @", () => {
      expect(normalizeChannelInput("  @Sick_Nerd  ")).toBe("sick_nerd");
      expect(normalizeChannelInput("Cool-Streamer_99")).toBe("cool-streamer_99");
    });

    it("extracts channel slug from full Twitch and Kick URLs", () => {
      expect(normalizeChannelInput("https://www.twitch.tv/Sick_Nerd/videos?filter=all")).toBe(
        "sick_nerd",
      );
      expect(normalizeChannelInput("http://twitch.tv/SomeUser#chat")).toBe("someuser");
      expect(normalizeChannelInput("https://kick.com/cool-streamer/about")).toBe("cool-streamer");
      expect(normalizeChannelInput("https://www.kick.com/Another_User?ref=home")).toBe(
        "another_user",
      );
    });

    it("strips invalid characters and path suffixes", () => {
      expect(normalizeChannelInput("user!@#$%/extra")).toBe("user");
      expect(normalizeChannelInput("!!!")).toBe("");
    });
  });

  describe("normalizeWhitelist", () => {
    it("returns empty object for null or non-object inputs", () => {
      expect(normalizeWhitelist(null)).toBeTypeOf("object");
      expect(normalizeWhitelist(null)).toEqual({});
      expect(normalizeWhitelist(undefined)).toEqual({});
      expect(normalizeWhitelist("invalid")).toEqual({});
      expect(normalizeWhitelist(42)).toEqual({});
    });

    it("normalizes keys and values and falls back to Twitch name when Kick value is blank or non-string", () => {
      expect(
        normalizeWhitelist({
          "https://www.twitch.tv/Streamer_One": "https://kick.com/streamer-one",
          Second_User: "   ",
          Third_User: 12345,
          "!!!": "valid_kick",
          Valid_Key: "!!!",
        }),
      ).toEqual({
        streamer_one: "streamer-one",
        second_user: "second_user",
        third_user: "third_user",
      });
    });
  });

  describe("loadWhitelist / saveWhitelist", () => {
    it("uses GM_getValue and GM_setValue when available", () => {
      const store: Record<string, unknown> = {};
      const gmGet = vi.fn<(key: string, fallback: unknown) => unknown>((key, fallback) =>
        key in store ? store[key] : fallback,
      );
      const gmSet = vi.fn<(key: string, val: unknown) => void>((key, val) => {
        store[key] = val;
      });
      vi.stubGlobal("GM_getValue", gmGet);
      vi.stubGlobal("GM_setValue", gmSet);

      // Initial load seeds default whitelist when missing
      expect(loadWhitelist()).toEqual({});
      expect(gmSet).toHaveBeenCalledWith(STORAGE_KEYS.whitelist, {});

      const saved = saveWhitelist({ " @Alpha ": "https://kick.com/Alpha_Kick" });
      expect(saved).toEqual({ alpha: "alpha_kick" });
      expect(store[STORAGE_KEYS.whitelist]).toEqual({ alpha: "alpha_kick" });

      expect(loadWhitelist()).toEqual({ alpha: "alpha_kick" });
    });

    it("falls back to localStorage when GM APIs are absent", () => {
      vi.stubGlobal("GM_getValue", undefined);
      vi.stubGlobal("GM_setValue", undefined);

      expect(loadWhitelist()).toEqual({});
      expect(localStorage.getItem(STORAGE_KEYS.whitelist)).toBe("{}");

      saveWhitelist({ Beta: "beta_kick" });
      expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.whitelist) || "{}")).toEqual({
        beta: "beta_kick",
      });
      expect(loadWhitelist()).toEqual({ beta: "beta_kick" });
    });

    it("recovers gracefully from corrupt localStorage JSON and storage errors", () => {
      vi.stubGlobal("GM_getValue", undefined);
      vi.stubGlobal("GM_setValue", undefined);
      localStorage.setItem(STORAGE_KEYS.whitelist, "{bad json");

      expect(loadWhitelist()).toEqual({});

      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubGlobal("GM_setValue", () => {
        throw new Error("Quota exceeded");
      });
      expect(saveWhitelist({ foo: "bar" })).toEqual({ foo: "bar" });
      expect(errSpy).toHaveBeenCalled();
    });
  });

  describe("loadSettings / saveSettings", () => {
    it("returns default settings when storage is empty or non-object", () => {
      vi.stubGlobal("GM_getValue", () => undefined);
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);

      vi.stubGlobal("GM_getValue", () => "not-an-object");
      expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    });

    it("merges partial saved settings with defaults", () => {
      vi.stubGlobal("GM_getValue", () => ({ muted: true, volume: 0.4 }));
      expect(loadSettings()).toEqual({
        ...DEFAULT_SETTINGS,
        muted: true,
        volume: 0.4,
      });
    });

    it("clamps volume and normalizes boolean flags on save", () => {
      const store: Record<string, unknown> = {};
      vi.stubGlobal("GM_setValue", (k: string, v: unknown) => {
        store[k] = v;
      });

      expect(
        saveSettings({
          autoplay: false,
          muted: true,
          showBadge: false,
          detectLiveKick: false,
          preferDirectHls: false,
          volume: 1.5,
        }),
      ).toEqual({
        autoplay: false,
        muted: true,
        showBadge: false,
        detectLiveKick: false,
        preferDirectHls: false,
        volume: 1,
      });

      expect(saveSettings({ volume: -0.3 }).volume).toBe(0);
      expect(saveSettings({ volume: Number.NaN }).volume).toBe(1);
      expect(saveSettings({ volume: Number.POSITIVE_INFINITY }).volume).toBe(1);
      expect(saveSettings({ volume: 0.42 }).volume).toBe(0.42);
      expect(saveSettings({}).detectLiveKick).toBe(true);
      expect(saveSettings({}).preferDirectHls).toBe(true);
      expect(store[STORAGE_KEYS.settings]).toBeDefined();
    });
  });

  describe("getTwitchChannelFromPathname", () => {
    it("extracts valid single-segment channel names", () => {
      expect(getTwitchChannelFromPathname("/sick_nerd")).toBe("sick_nerd");
      expect(getTwitchChannelFromPathname("/Sick_Nerd/")).toBe("sick_nerd");
      expect(getTwitchChannelFromPathname(`/${"a".repeat(25)}`)).toBe("a".repeat(25));
    });

    it("returns null for root, multi-segment, reserved, invalid, or non-string paths", () => {
      expect(getTwitchChannelFromPathname("/")).toBeNull();
      expect(getTwitchChannelFromPathname("")).toBeNull();
      expect(getTwitchChannelFromPathname("/sick_nerd/videos")).toBeNull();
      expect(getTwitchChannelFromPathname("/directory")).toBeNull();
      expect(getTwitchChannelFromPathname("/Settings")).toBeNull();
      expect(getTwitchChannelFromPathname("/popout")).toBeNull();
      expect(getTwitchChannelFromPathname("/invalid-hyphen")).toBeNull();
      expect(getTwitchChannelFromPathname(`/${"a".repeat(26)}`)).toBeNull();
      expect(getTwitchChannelFromPathname(null as unknown as string)).toBeNull();
    });
  });

  describe("buildKickEmbedUrl", () => {
    it("encodes channel slug and reflects autoplay and muted settings", () => {
      expect(
        buildKickEmbedUrl("cool_streamer", { ...DEFAULT_SETTINGS, autoplay: true, muted: false }),
      ).toBe("https://player.kick.com/cool_streamer?autoplay=true&muted=false");

      expect(buildKickEmbedUrl("a b", { ...DEFAULT_SETTINGS, autoplay: false, muted: true })).toBe(
        "https://player.kick.com/a%20b?autoplay=false&muted=true",
      );
    });
  });
});
