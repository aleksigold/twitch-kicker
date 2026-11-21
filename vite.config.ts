import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

interface PackageJson {
  version: string;
  description: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "package.json"), "utf8"),
) as PackageJson;
const hlsPkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "node_modules", "hls.js", "package.json"), "utf8"),
) as { version: string };

const USERSCRIPT_FILENAME = "twitch-kicker.user.js";
const USERSCRIPT_OUTFILE = path.join(__dirname, "dist", USERSCRIPT_FILENAME);

const USERSCRIPT_BANNER = `// ==UserScript==
// @name         Twitch Kicker - Replace Twitch Player with Kick
// @namespace    https://github.com/aleksigold/twitch-kicker
// @version      ${pkg.version}
// @description  ${pkg.description}
// @author       aleksigold
// @homepageURL  https://github.com/aleksigold/twitch-kicker
// @supportURL   https://github.com/aleksigold/twitch-kicker/issues
// @updateURL    https://github.com/aleksigold/twitch-kicker/releases/latest/download/twitch-kicker.user.js
// @downloadURL  https://github.com/aleksigold/twitch-kicker/releases/latest/download/twitch-kicker.user.js
// @match        https://www.twitch.tv/*
// @match        https://twitch.tv/*
// @exclude      https://www.twitch.tv/popout/*
// @exclude      https://www.twitch.tv/embed/*
// @exclude      https://www.twitch.tv/moderator/*
// @icon         https://kick.com/favicon.ico
// @require      https://cdn.jsdelivr.net/npm/hls.js@${hlsPkg.version}/dist/hls.light.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      kick.com
// @connect      live-video.net
// @connect      *
// @run-at       document-idle
// ==/UserScript==
`;

function userscriptPlugin(): Plugin {
  return {
    name: "twitch-kicker-userscript",
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === "chunk" && chunk.fileName === USERSCRIPT_FILENAME) {
          chunk.code = `${USERSCRIPT_BANNER}\n${chunk.code}`;
        }
      }
    },
    configureServer(server) {
      let pendingBuild: Promise<unknown> | null = null;

      const rebuild = (): Promise<unknown> => {
        if (!pendingBuild) {
          pendingBuild = viteBuild({
            configFile: path.join(__dirname, "vite.config.ts"),
            logLevel: "warn",
          }).finally(() => {
            pendingBuild = null;
          });
        }
        return pendingBuild;
      };

      void rebuild();

      server.watcher.on("change", (changedPath) => {
        if (changedPath.startsWith(path.join(__dirname, "src"))) {
          void rebuild().then(() => {
            server.config.logger.info(`[twitch-kicker] Rebuilt ${USERSCRIPT_FILENAME}`, {
              timestamp: true,
            });
          });
        }
      });

      server.middlewares.use(async (req, res, next) => {
        if (req.url !== "/" && req.url !== `/${USERSCRIPT_FILENAME}`) {
          next();
          return;
        }
        try {
          if (pendingBuild || !fs.existsSync(USERSCRIPT_OUTFILE)) {
            await rebuild();
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/javascript; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          fs.createReadStream(USERSCRIPT_OUTFILE).pipe(res);
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [userscriptPlugin()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT || 8787),
    strictPort: false,
  },
  build: {
    target: "es2022",
    minify: true,
    cssCodeSplit: false,
    emptyOutDir: true,
    lib: {
      entry: path.join(__dirname, "src", "index.ts"),
      name: "TwitchKicker",
      formats: ["iife"],
      fileName: () => USERSCRIPT_FILENAME,
    },
    rolldownOptions: {
      external: ["hls.js"],
      output: {
        globals: {
          "hls.js": "Hls",
        },
      },
    },
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
});
