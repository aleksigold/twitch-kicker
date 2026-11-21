# Twitch Kicker

A Tampermonkey userscript that replaces the Twitch video player with the Kick stream player (`player.kick.com`) for whitelisted streamers, while keeping Twitch chat, theatre mode, and layout intact.

## Features

- **Direct 1080p60 HLS player (with embed fallback)**: fetches Kick's live `playback_url` (`.m3u8`) and plays it via `hls.js` with full quality selection (defaulting to **Auto** with 1080p60 support), volume, live-edge sync, PiP, and fullscreen — automatically falling back to the `player.kick.com` iframe when offline or unavailable.
- **Per-streamer whitelist** mapping Twitch usernames to Kick usernames (supports different usernames between platforms).
- **Live Kick stream detection**: automatically checks if a non-whitelisted Twitch channel has a matching live Kick stream (including `_` → `-` slug fallback) and shows a **Whitelist & Switch** button below the stream.
- **Non-destructive replacement**: overlays the Kick player and pauses/mutes the underlying Twitch `<video>` without tearing down Twitch's React DOM tree.
- **SPA-aware**: automatically switches as you navigate between Twitch channels, directory pages, VODs, and clips.
- **Built-in Whitelist Manager UI**: add/remove streamers, import/export JSON, and toggle autoplay/mute settings directly on Twitch.
- **Native-style stream bar controls**: adds Kick/Twitch toggle, link, and whitelist buttons right next to Twitch's Follow / Subscribe buttons below the stream so the video player stays unobstructed.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Install the latest release directly: [`twitch-kicker.user.js`](https://github.com/aleksigold/twitch-kicker/releases/latest/download/twitch-kicker.user.js) (Tampermonkey will prompt to install and auto-update from GitHub Releases).
3. Or build from source:
   ```bash
   mise install
   npm install
   npm run build
   ```
   Then open `dist/twitch-kicker.user.js` in Tampermonkey (or run `npm start` and open `http://127.0.0.1:8787/twitch-kicker.user.js`).
4. Visit any Twitch channel page (`https://www.twitch.tv/<channel>`).

## Usage

### Managing the Whitelist

You have three ways to add streamers:

1. **Tampermonkey menu**: Click the Tampermonkey extension icon on Twitch → **Manage Kick Whitelist** (or **Add / Remove Current Channel**).
2. **Stream action bar**: Click **Whitelist** next to the Follow / Subscribe buttons below a replaced stream.
3. **In-script defaults**: Edit `DEFAULT_WHITELIST` in [`src/config.ts`](./src/config.ts) and rebuild before first run:
   ```js
   const DEFAULT_WHITELIST = {
     sick_nerd: "sick_nerd",
     twitch_name: "different_kick_name",
   };
   ```

## Troubleshooting

### Kick player shows a blocked frame / CSP console error

If Twitch's Content Security Policy (`frame-src`) blocks `https://player.kick.com` in your browser:

1. Open **Tampermonkey Dashboard → Settings**.
2. Set **Config mode** to **Advanced**.
3. Under **Security**, set **Modify existing content security policy (CSP) headers** to **Yes** (or **Remove entirely** if needed), then reload Twitch.

### Autoplay starts paused or muted

Modern browsers block unmuted autoplay before you interact with the page. Enable **Start Kick stream muted** in the Whitelist settings modal if you want streams to start playing immediately on page load.

## Development

This project is written in TypeScript ([`src/index.ts`](./src/index.ts)) and uses [mise](https://mise.jdx.dev/) ([`mise.toml`](./mise.toml)) for Node.js and npm scripts ([`package.json`](./package.json)) for tasks:

```bash
# Install configured tools (Node 26.13.1) and npm dependencies
mise install
npm install

# Type-check with TypeScript
npm run typecheck

# Build dist/twitch-kicker.user.js
npm run build

# Run unit & DOM tests (Vitest + happy-dom)
npm test

# Run tests in watch mode
npm run test:watch

# Build and serve dist/twitch-kicker.user.js locally at http://127.0.0.1:8787/twitch-kicker.user.js
npm start
```
