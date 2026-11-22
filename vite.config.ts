import monkey, { cdn } from "vite-plugin-monkey";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  plugins:
    mode === "test"
      ? []
      : [
          monkey({
            entry: "src/index.ts",
            userscript: {
              name: "Twitch Kicker - Replace Twitch Player with Kick",
              namespace: "https://github.com/aleksigold/twitch-kicker",
              author: "aleksigold",
              homepageURL: "https://github.com/aleksigold/twitch-kicker",
              supportURL: "https://github.com/aleksigold/twitch-kicker/issues",
              updateURL:
                "https://github.com/aleksigold/twitch-kicker/releases/latest/download/twitch-kicker.user.js",
              downloadURL:
                "https://github.com/aleksigold/twitch-kicker/releases/latest/download/twitch-kicker.user.js",
              icon: "https://kick.com/favicon.ico",
              match: ["https://www.twitch.tv/*", "https://twitch.tv/*"],
              exclude: [
                "https://www.twitch.tv/popout/*",
                "https://www.twitch.tv/embed/*",
                "https://www.twitch.tv/moderator/*",
              ],
              connect: ["kick.com", "live-video.net", "*"],
              "run-at": "document-idle",
            },
            server: {
              mountGmApi: true,
            },
            build: {
              fileName: "twitch-kicker.user.js",
              externalGlobals: {
                "hls.js": cdn.jsdelivr("Hls", "dist/hls.light.min.js"),
              },
            },
          }),
        ],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT || 8787),
    strictPort: false,
  },
  build: {
    target: "es2022",
    minify: true,
    emptyOutDir: true,
  },
  test: {
    environment: "happy-dom",
    environmentOptions: {
      happyDOM: {
        url: "https://www.twitch.tv/",
        settings: {
          enableIframePageLoading: true,
          navigation: {
            disableChildFrameNavigation: true,
          },
        },
      },
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/types.d.ts"],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
}));
