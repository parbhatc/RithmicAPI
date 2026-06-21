import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { WebSocketServer } from "ws";
import {
  rithmicDatafeedConfig,
  rithmicHistory,
  rithmicResolve,
  rithmicSearch,
  subscribeRithmicBars,
} from "./lib/rithmic/datafeed.mjs";
import { rithmicHub } from "./lib/rithmic/hub.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const WEB_PUBLIC = path.join(__dirname, "..", "public");
const require = createRequire(import.meta.url);

function resolveChartPublic() {
  const sibling = path.join(ROOT, "..", "BetterWeightChart", "public");
  if (fs.existsSync(sibling)) return sibling;
  try {
    const pkg = require.resolve("betterweightchart/package.json");
    return path.join(path.dirname(pkg), "public");
  } catch {
    return null;
  }
}

const CHART_PUBLIC = resolveChartPublic();
const PORT = Number(process.env.PORT) || 3460;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const HDR = { "X-Chart-Api": "rithmic-api-web" };

function json(res, status, body) {
  res.writeHead(status, {
    ...HDR,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function safePublic(root, relPath) {
  if (!root) return null;
  const rel = path.normalize(decodeURIComponent(relPath)).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep) && full !== root) return null;
  return full;
}

function findStaticFile(relPath) {
  const rel = relPath.startsWith("/") ? relPath.slice(1) : relPath;
  const webFile = safePublic(WEB_PUBLIC, rel);
  if (webFile && fs.existsSync(webFile) && fs.statSync(webFile).isFile()) return webFile;
  const chartFile = safePublic(CHART_PUBLIC, rel);
  if (chartFile && fs.existsSync(chartFile) && fs.statSync(chartFile).isFile()) return chartFile;
  return null;
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const cacheable = ext === ".mjs" || ext === ".js" || ext === ".css";
  res.writeHead(200, {
    ...HDR,
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": cacheable ? "public, max-age=86400" : "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

function parseUrl(req) {
  const u = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  return { pathname: u.pathname.replace(/\/+$/, "") || "/", searchParams: u.searchParams };
}

async function handleRithmicDatafeed(pathname, sp, res) {
  if (pathname === "/datafeed/rithmic/config") {
    json(res, 200, rithmicDatafeedConfig());
    return true;
  }

  if (pathname === "/datafeed/rithmic/search") {
    const query = sp.get("query") || sp.get("text") || "";
    const limit = sp.get("limit");
    json(res, 200, rithmicSearch(query, limit != null ? Number(limit) : 25));
    return true;
  }

  if (pathname === "/datafeed/rithmic/symbols") {
    const symbol = sp.get("symbol") || "NQ";
    const info = rithmicResolve(symbol);
    json(res, 200, info);
    return true;
  }

  if (pathname === "/datafeed/rithmic/history") {
    try {
      const payload = await rithmicHistory({
        symbol: sp.get("symbol") || "NQ",
        resolution: sp.get("resolution") || "1",
        from: sp.get("from") != null ? Number(sp.get("from")) : undefined,
        to: sp.get("to") != null ? Number(sp.get("to")) : undefined,
        countback: sp.get("countback") != null ? Number(sp.get("countback")) : undefined,
      });
      json(res, 200, payload);
    } catch (err) {
      json(res, 200, { s: "error", errmsg: err.message || "History failed" });
    }
    return true;
  }

  if (pathname === "/datafeed/rithmic/stream") {
    const symbol = sp.get("symbol") || "NQ";
    const resolution = sp.get("resolution") || "1";

    res.writeHead(200, {
      ...HDR,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");

    let unsub = () => {};
    try {
      unsub = subscribeRithmicBars(symbol, resolution, (bar) => {
        res.write(`data: ${JSON.stringify(bar)}\n\n`);
      });
    } catch (err) {
      console.error("[rithmic] stream subscribe failed:", err?.message ?? err);
    }

    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    res.on("close", () => {
      clearInterval(ping);
      unsub();
    });
    return true;
  }

  return false;
}

async function handleApi(pathname, res) {
  if (pathname === "/api/health") {
    json(res, 200, {
      ok: true,
      service: "rithmic-api-web",
      chart: "betterweightchart",
      datafeed: "/datafeed/rithmic/config",
      chartPublic: CHART_PUBLIC,
      rithmic: { ready: rithmicHub.isReady() },
    });
    return true;
  }

  if (pathname.startsWith("/api/")) {
    json(res, 404, { error: "Unknown API route", path: pathname });
    return true;
  }

  return false;
}

function handleRequest(req, res) {
  const { pathname, searchParams } = parseUrl(req);

  if (req.method !== "GET" && req.method !== "HEAD") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  void handleRithmicDatafeed(pathname, searchParams, res).then((handled) => {
    if (handled) return;

    void handleApi(pathname, res).then((apiHandled) => {
      if (apiHandled) return;

      if (!CHART_PUBLIC) {
        json(res, 503, {
          error: "BetterweightChart not found",
          hint: "npm install && npm run web:vendor",
        });
        return;
      }

      let filePathname = pathname === "/" ? "/index.html" : pathname;
      if (!path.extname(filePathname)) {
        const asHtml = findStaticFile(`${filePathname.slice(1)}.html`);
        const asIndex = findStaticFile(path.join(filePathname.slice(1), "index.html"));
        filePathname = asHtml ? `${filePathname}.html` : filePathname;
        if (!path.extname(filePathname) && asIndex) {
          filePathname = path.join(filePathname, "index.html");
        }
      }

      const filePath = findStaticFile(filePathname.startsWith("/") ? filePathname.slice(1) : filePathname);
      if (!filePath) {
        res.writeHead(404, HDR);
        res.end("Not found");
        return;
      }

      if (req.method === "HEAD") {
        res.writeHead(200, HDR);
        res.end();
        return;
      }

      serveFile(res, filePath);
    });
  });
}

const server = http.createServer(handleRequest);

const wss = new WebSocketServer({ server, path: "/ws/ping" });
wss.on("connection", (ws) => {
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    if (String(data) === "ping") ws.send("pong");
  });
});

server.listen(PORT, () => {
  console.log(`Rithmic chart: http://127.0.0.1:${PORT}/`);
  console.log(`Embed:         http://127.0.0.1:${PORT}/embed?symbol=NQ&theme=dark`);
  console.log(`Datafeed:      http://127.0.0.1:${PORT}/datafeed/rithmic/config`);
  console.log(`Chart static:  ${CHART_PUBLIC ?? "(missing)"}`);
  if (CHART_PUBLIC) rithmicHub.warmup();
});
