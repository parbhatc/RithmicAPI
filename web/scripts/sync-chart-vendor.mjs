/**
 * Copy lightweight-charts into betterweightchart/public/vendor (BWC postinstall
 * expects lc inside its own node_modules; hoisted installs need this step).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const require = createRequire(import.meta.url);

const LC_SRC = path.join(
  ROOT,
  "node_modules",
  "lightweight-charts",
  "dist",
  "lightweight-charts.standalone.production.mjs",
);

function chartPublicDir() {
  const sibling = path.join(ROOT, "..", "BetterweightChart", "public");
  if (fs.existsSync(sibling)) return sibling;
  try {
    const pkg = require.resolve("betterweightchart/package.json");
    return path.join(path.dirname(pkg), "public");
  } catch {
    return null;
  }
}

const publicDir = chartPublicDir();
if (!publicDir) {
  console.warn("[web:vendor] betterweightchart not installed — skip");
  process.exit(0);
}

const vendorDir = path.join(publicDir, "vendor");
const dest = path.join(vendorDir, "lightweight-charts.mjs");

if (!fs.existsSync(LC_SRC)) {
  console.warn("[web:vendor] lightweight-charts not found — run npm install");
  process.exit(0);
}

fs.mkdirSync(vendorDir, { recursive: true });
fs.copyFileSync(LC_SRC, dest);
console.log("[web:vendor]", dest);
