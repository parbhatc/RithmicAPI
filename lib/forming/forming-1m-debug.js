/** Verbose trace for 1m forming candle build. Set FORMING_1M_DEBUG=1 */
const TZ = "America/New_York";

export function is1mFormingDebug() {
  const v = process.env.FORMING_1M_DEBUG;
  return v === "1" || v === "true" || v === "yes";
}

const fPrice = (n) =>
  n == null || !Number.isFinite(Number(n)) ? "—" : Number(n).toFixed(2);

/** e.g. 6/21/2026, 6:00:01 AM ET */
export function fmtSec(sec, { date = true } = {}) {
  if (sec == null || !Number.isFinite(Number(sec))) return "—";
  const opts = {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  };
  if (date) {
    opts.month = "numeric";
    opts.day = "numeric";
    opts.year = "numeric";
  }
  return `${new Date(Number(sec) * 1000).toLocaleString("en-US", opts)} ET`;
}

export function fmt1mBar(bar) {
  if (!bar) return "null";
  const f = fPrice;
  return (
    `bucket=${fmtSec(bar.marker)} unix=${bar.marker}` +
    ` O=${f(bar.open)} H=${f(bar.high)} L=${f(bar.low)} C=${f(bar.close)}` +
    ` forming=${Boolean(bar.forming)} src=${bar.replaySource ?? "—"}`
  );
}

export function fmtSubBar(bar) {
  if (!bar) return "null";
  const t = Number(bar.marker);
  const f = fPrice;
  return (
    `@${fmtSec(t, { date: false })} unix=${t}` +
    ` O=${f(bar.open)} H=${f(bar.high)} L=${f(bar.low)} C=${f(bar.close)}` +
    (bar.volume != null ? ` V=${bar.volume}` : "")
  );
}

export function log1m(step, detail = "") {
  if (!is1mFormingDebug()) return;
  console.log(detail ? `[1m-forming] ${step}  ${detail}` : `[1m-forming] ${step}`);
}

export function log1mBars(step, bars, { nowSec, tail = 6 } = {}) {
  if (!is1mFormingDebug()) return;
  const list = bars ?? [];
  const slice = list.slice(-tail);
  log1m(
    step,
    `count=${list.length} now=${nowSec != null ? fmtSec(nowSec) : "—"}`,
  );
  for (const b of slice) {
    console.log(`           ${fmt1mBar(b)}`);
  }
}

/**
 * Audit log for a 1m candle build — shows bucket time and what supplied open.
 * @param {string} step
 * @param {object|null} bar - resulting 1m bar
 * @param {object} [audit]
 */
export function log1mBuild(step, bar, audit = {}) {
  if (!is1mFormingDebug()) return;
  console.log(`[1m-open-audit] ── ${step} ──`);
  if (!bar) {
    console.log("  (no bar produced)");
    return;
  }
  console.log(`  result     ${fmt1mBar(bar)}`);
  if (audit.openFrom) console.log(`  openFrom   ${audit.openFrom}`);
  if (audit.openWas != null && audit.openNow != null && audit.openWas !== audit.openNow) {
    console.log(`  openChange ${fPrice(audit.openWas)} → ${fPrice(audit.openNow)}`);
  }
  if (audit.histPartial) console.log(`  histPartial ${fmt1mBar(audit.histPartial)}`);
  if (audit.first1s) console.log(`  first1s    ${fmtSubBar(audit.first1s)}`);
  if (audit.bars1s?.length) {
    console.log(`  1s rollup (${audit.bars1s.length} bars in minute):`);
    for (const b of audit.bars1s) {
      const tag = audit.open1sUnix === Number(b.marker) ? " ← OPEN" : "";
      console.log(`    ${fmtSubBar(b)}${tag}`);
    }
  }
  if (audit.note) console.log(`  note       ${audit.note}`);
}
