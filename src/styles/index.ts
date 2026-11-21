import playerCss from "./player.css?inline";
import modalCss from "./modal.css?inline";

const COMBINED_CSS = `${playerCss}\n${modalCss}`;

export function injectStyles(): void {
  if (typeof GM_addStyle === "function") {
    GM_addStyle(COMBINED_CSS);
  } else {
    const style = document.createElement("style");
    style.textContent = COMBINED_CSS;
    (document.head || document.documentElement).appendChild(style);
  }
}
