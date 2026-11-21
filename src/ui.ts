import { IDS, type AppState, type KickLiveMatch, type Settings, type Whitelist } from "./config";
import {
  getTwitchChannelFromPathname,
  normalizeChannelInput,
  saveSettings,
  saveWhitelist,
} from "./storage";

export function removeSuggestionBanner(): void {
  const existing = document.getElementById(IDS.suggestionBanner);
  if (existing) existing.remove();
}

export function mountSuggestionBanner(
  state: AppState,
  actionBar: HTMLElement,
  twitchChannel: string,
  match: KickLiveMatch,
  onSync: () => void,
): void {
  const existing = document.getElementById(IDS.suggestionBanner);
  if (
    existing &&
    existing.parentElement === actionBar &&
    existing.dataset.twitchChannel === twitchChannel &&
    existing.dataset.kickChannel === match.kickChannel
  ) {
    return;
  }
  removeSuggestionBanner();

  const group = document.createElement("div");
  group.id = IDS.suggestionBanner;
  group.className = "tk-action-group";
  group.dataset.twitchChannel = twitchChannel;
  group.dataset.kickChannel = match.kickChannel;

  const tooltipParts: string[] = [`Live on kick.com/${match.kickChannel}`];
  if (match.viewerCount !== null) {
    tooltipParts.push(`${match.viewerCount.toLocaleString()} viewers`);
  }
  if (match.category) {
    tooltipParts.push(match.category);
  }
  if (match.title) {
    tooltipParts.push(match.title);
  }

  const whitelistBtn = document.createElement("button");
  whitelistBtn.type = "button";
  whitelistBtn.className = "tk-action-btn tk-action-btn--kick";
  whitelistBtn.title = tooltipParts.join(" · ");

  const dot = document.createElement("span");
  dot.className = "tk-kick-dot";
  whitelistBtn.append(dot, document.createTextNode("Whitelist & Switch"));
  whitelistBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    state.whitelist = saveWhitelist({
      ...state.whitelist,
      [twitchChannel]: match.kickChannel,
    });
    state.disabledChannels.delete(twitchChannel);
    removeSuggestionBanner();
    onSync();
  });

  group.append(whitelistBtn);
  actionBar.prepend(group);
}

export function closeWhitelistModal(state: AppState): void {
  if (state.modalKeyHandler) {
    document.removeEventListener("keydown", state.modalKeyHandler);
    state.modalKeyHandler = null;
  }
  const existing = document.getElementById(IDS.modalBackdrop);
  if (existing) existing.remove();
}

export function openWhitelistModal(state: AppState, onSync: () => void): void {
  closeWhitelistModal(state);

  const currentTwitch = getTwitchChannelFromPathname(location.pathname) || "";

  const backdrop = document.createElement("div");
  backdrop.id = IDS.modalBackdrop;
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeWhitelistModal(state);
  });

  const modal = document.createElement("div");
  modal.className = "tk-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-label", "Twitch Kicker Whitelist");

  const header = document.createElement("div");
  header.className = "tk-modal-header";

  const title = document.createElement("h2");
  title.className = "tk-modal-title";
  const dot = document.createElement("span");
  dot.className = "tk-kick-dot";
  title.append(dot, document.createTextNode("Twitch Kicker Whitelist"));

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "tk-modal-close";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.addEventListener("click", () => closeWhitelistModal(state));

  header.append(title, closeBtn);

  const body = document.createElement("div");
  body.className = "tk-modal-body";

  const form = document.createElement("form");
  form.className = "tk-form-row";

  const twitchInput = document.createElement("input");
  twitchInput.type = "text";
  twitchInput.className = "tk-input";
  twitchInput.placeholder = "Twitch username";
  twitchInput.value = currentTwitch;

  const kickInput = document.createElement("input");
  kickInput.type = "text";
  kickInput.className = "tk-input";
  kickInput.placeholder = "Kick username (optional)";

  const addBtn = document.createElement("button");
  addBtn.type = "submit";
  addBtn.className = "tk-btn-primary";
  addBtn.textContent = "Add";

  form.append(twitchInput, kickInput, addBtn);

  const hint = document.createElement("div");
  hint.className = "tk-hint";
  hint.textContent =
    "Leave Kick username empty if it matches the Twitch username. You can also paste full channel URLs.";

  const listEl = document.createElement("div");
  listEl.className = "tk-list";

  function renderList(): void {
    listEl.replaceChildren();
    const entries = Object.entries(state.whitelist).sort(([a], [b]) => a.localeCompare(b));

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tk-empty";
      empty.textContent = "No whitelisted streamers yet. Add a Twitch channel above.";
      listEl.appendChild(empty);
      return;
    }

    for (const [tw, ki] of entries) {
      const item = document.createElement("div");
      item.className = "tk-list-item";

      const mapping = document.createElement("div");
      mapping.className = "tk-list-mapping";

      const twSpan = document.createElement("span");
      twSpan.className = "tk-tag-twitch";
      twSpan.textContent = `twitch.tv/${tw}`;

      const arrow = document.createElement("span");
      arrow.textContent = "→";

      const kiSpan = document.createElement("span");
      kiSpan.className = "tk-tag-kick";
      kiSpan.textContent = `kick.com/${ki}`;

      mapping.append(twSpan, arrow, kiSpan);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "tk-btn-danger";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => {
        const next = { ...state.whitelist };
        delete next[tw];
        state.whitelist = saveWhitelist(next);
        state.disabledChannels.delete(tw);
        renderList();
        onSync();
      });

      item.append(mapping, removeBtn);
      listEl.appendChild(item);
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const tw = normalizeChannelInput(twitchInput.value);
    const ki = normalizeChannelInput(kickInput.value || twitchInput.value);
    if (!tw || !ki) return;

    state.whitelist = saveWhitelist({
      ...state.whitelist,
      [tw]: ki,
    });
    state.disabledChannels.delete(tw);
    twitchInput.value = "";
    kickInput.value = "";
    renderList();
    onSync();
  });

  const settingsSection = document.createElement("div");
  settingsSection.className = "tk-settings-section";

  function createSettingToggle(key: keyof Settings, labelText: string): HTMLLabelElement {
    const label = document.createElement("label");
    label.className = "tk-checkbox-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(state.settings[key]);
    checkbox.addEventListener("change", () => {
      state.settings = saveSettings({
        ...state.settings,
        [key]: checkbox.checked,
      });
      onSync();
    });

    label.append(checkbox, document.createTextNode(labelText));
    return label;
  }

  settingsSection.append(
    createSettingToggle("preferDirectHls", "Use direct 1080p60 HLS player (falls back to embed)"),
    createSettingToggle("autoplay", "Autoplay Kick stream"),
    createSettingToggle("muted", "Start Kick stream muted"),
    createSettingToggle("showBadge", "Show Kick buttons below stream"),
    createSettingToggle(
      "detectLiveKick",
      "Suggest whitelisting when a matching Kick stream is live",
    ),
  );

  body.append(form, hint, listEl, settingsSection);

  const footer = document.createElement("div");
  footer.className = "tk-modal-footer";

  const leftActions = document.createElement("div");
  leftActions.style.display = "flex";
  leftActions.style.gap = "6px";

  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.className = "tk-btn-secondary";
  exportBtn.textContent = "Export JSON";
  exportBtn.addEventListener("click", () => {
    const json = JSON.stringify(state.whitelist, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(
        () => alert("Whitelist JSON copied to clipboard!"),
        () => prompt("Copy your whitelist JSON:", json),
      );
    } else {
      prompt("Copy your whitelist JSON:", json);
    }
  });

  const importBtn = document.createElement("button");
  importBtn.type = "button";
  importBtn.className = "tk-btn-secondary";
  importBtn.textContent = "Import JSON";
  importBtn.addEventListener("click", () => {
    const raw = prompt(
      'Paste whitelist JSON (e.g. {"sick_nerd": "sick_nerd"}):',
      JSON.stringify(state.whitelist),
    );
    if (raw === null) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected a JSON object mapping Twitch usernames to Kick usernames.");
      }
      state.whitelist = saveWhitelist(parsed as Whitelist);
      renderList();
      onSync();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      alert(`Invalid JSON: ${message}`);
    }
  });

  leftActions.append(exportBtn, importBtn);

  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "tk-btn-secondary";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", () => closeWhitelistModal(state));

  footer.append(leftActions, doneBtn);

  modal.append(header, body, footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  renderList();

  state.modalKeyHandler = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      closeWhitelistModal(state);
    }
  };
  document.addEventListener("keydown", state.modalKeyHandler);
}
