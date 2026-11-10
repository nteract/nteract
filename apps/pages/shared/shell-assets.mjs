// The theme script and stylesheet the Worker's own HTML pages load (/connect
// and the OAuth screens). viewer/index.html gets the same files from the build.
//
// scripts/build.mjs defines their content-hashed URLs (shellAssetDefine in
// scripts/viewer-chunks.mjs). Unbundled code (unit tests, tsx) uses the source
// names.

/* global __PAGES_THEME_SCRIPT__, __PAGES_STYLESHEET__ */
export const THEME_SCRIPT =
  typeof __PAGES_THEME_SCRIPT__ === "string" &&
  /^\/theme-[A-Z2-7]{8}\.js$/.test(__PAGES_THEME_SCRIPT__)
    ? __PAGES_THEME_SCRIPT__
    : "/theme.js";
export const STYLESHEET =
  typeof __PAGES_STYLESHEET__ === "string" && /^\/app-[A-Z2-7]{8}\.css$/.test(__PAGES_STYLESHEET__)
    ? __PAGES_STYLESHEET__
    : "/app.css";
