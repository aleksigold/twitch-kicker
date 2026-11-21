import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./player.css?inline", () => ({ default: "#tk-kick-overlay { color: red; }" }));
vi.mock("./modal.css?inline", () => ({ default: "#tk-modal-backdrop { color: blue; }" }));

import { injectStyles } from "./index";

describe("styles", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
  });

  it("injects combined CSS via GM_addStyle when available", () => {
    const gmAddStyle = vi.fn<(css: string) => void>();
    vi.stubGlobal("GM_addStyle", gmAddStyle);

    injectStyles();

    expect(gmAddStyle).toHaveBeenCalledTimes(1);
    const css = gmAddStyle.mock.calls[0][0];
    expect(css).toContain("#tk-kick-overlay");
    expect(css).toContain("#tk-modal-backdrop");
    expect(document.head.querySelector("style")).toBeNull();
  });

  it("falls back to appending a <style> element to document.head when GM_addStyle is unavailable", () => {
    vi.stubGlobal("GM_addStyle", undefined);

    injectStyles();

    const style = document.head.querySelector("style");
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain("#tk-kick-overlay");
    expect(style?.textContent).toContain("#tk-modal-backdrop");
  });
});
