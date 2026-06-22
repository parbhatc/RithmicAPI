/**
 * In-memory cache for forming bootstrap replays (per symbol/exchange).
 * Speeds up repeated chart loads and multi-TF bootstrap within the same minute.
 */

const DEFAULT_1M_TTL_MS = 45_000;
const DEFAULT_NATIVE_TTL_MS = 60_000;
const DEFAULT_WEEKLY_ADJUST_TTL_MS = 6 * 60 * 60 * 1000;

function symKey(session) {
  return `${session.symbol}:${session.exchange}`;
}

export class FormingBootstrapCache {
  /** @type {Map<string, { raw: object[], closed: object[], partial: object|null, at: number }>} */
  #oneMinute = new Map();
  /** @type {Map<string, { bars: object[], at: number }>} */
  #nativePartial = new Map();
  /** @type {Map<string, { adjust: number, at: number }>} */
  #weeklyAdjust = new Map();

  static #global = new FormingBootstrapCache();

  /** Shared process-wide cache (reuse across FormingBarManager instances). */
  static global() {
    return FormingBootstrapCache.#global;
  }

  static clearGlobal() {
    FormingBootstrapCache.#global.clear();
  }

  clear() {
    this.#oneMinute.clear();
    this.#nativePartial.clear();
    this.#weeklyAdjust.clear();
  }

  oneMinuteKey(session, from, countback, nowSec, compat = false) {
    return `${symKey(session)}:1m:${from}:${countback}:${Math.floor(nowSec / 60)}${compat ? ":c" : ""}`;
  }

  /**
   * @returns {{ raw: object[], closed: object[], partial: object|null }|null}
   */
  get1m(session, from, countback, nowSec, ttlMs = DEFAULT_1M_TTL_MS, compat = false) {
    const key = this.oneMinuteKey(session, from, countback, nowSec, compat);
    const hit = this.#oneMinute.get(key);
    if (!hit || Date.now() - hit.at > ttlMs) return null;
    return { raw: hit.raw, closed: hit.closed, partial: hit.partial };
  }

  set1m(session, from, countback, nowSec, raw, closed, partial, compat = false) {
    const key = this.oneMinuteKey(session, from, countback, nowSec, compat);
    this.#oneMinute.set(key, { raw, closed, partial, at: Date.now() });
  }

  nativeKey(session, resolution, bucketMarker, nowSec) {
    return `${symKey(session)}:native:${String(resolution).toUpperCase()}:${bucketMarker}:${Math.floor(nowSec / 60)}`;
  }

  getNative(session, resolution, bucketMarker, nowSec, ttlMs = DEFAULT_NATIVE_TTL_MS) {
    const key = this.nativeKey(session, resolution, bucketMarker, nowSec);
    const hit = this.#nativePartial.get(key);
    if (!hit || Date.now() - hit.at > ttlMs) return null;
    return hit.bars;
  }

  setNative(session, resolution, bucketMarker, nowSec, bars) {
    const key = this.nativeKey(session, resolution, bucketMarker, nowSec);
    this.#nativePartial.set(key, { bars, at: Date.now() });
  }

  weeklyAdjustKey(session, weekYmd) {
    return `${symKey(session)}:weekly-adjust:${weekYmd}`;
  }

  getWeeklyAdjust(session, weekYmd, ttlMs = DEFAULT_WEEKLY_ADJUST_TTL_MS) {
    const key = this.weeklyAdjustKey(session, weekYmd);
    const hit = this.#weeklyAdjust.get(key);
    if (!hit || Date.now() - hit.at > ttlMs) return null;
    return hit.adjust;
  }

  setWeeklyAdjust(session, weekYmd, adjust) {
    if (!Number.isFinite(adjust)) return;
    const key = this.weeklyAdjustKey(session, weekYmd);
    this.#weeklyAdjust.set(key, { adjust, at: Date.now() });
  }
}

export {
  DEFAULT_1M_TTL_MS,
  DEFAULT_NATIVE_TTL_MS,
  DEFAULT_WEEKLY_ADJUST_TTL_MS,
};
