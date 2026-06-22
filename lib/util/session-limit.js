const SESSION_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

export function isSessionLimitError(code, reason, errMsg = "") {
  if (code === 1011) return true;
  const text = `${reason ?? ""} ${errMsg}`;
  return /permission denied|\b13\b|forced.?logout/i.test(text);
}

/** Tracks Rithmic tp_max_session_count forced-logout backoff. */
export class SessionBackoff {
  #kickCount = 0;
  #until = 0;
  #lastKickAt = 0;

  get active() {
    return Date.now() < this.#until;
  }

  get until() {
    return this.#until;
  }

  currentMs() {
    const idx = Math.min(Math.max(this.#kickCount - 1, 0), SESSION_BACKOFF_MS.length - 1);
    return SESSION_BACKOFF_MS[idx];
  }

  noteKick() {
    const now = Date.now();
    if (now - this.#lastKickAt < 3000) return this.currentMs();
    this.#lastKickAt = now;
    this.#kickCount += 1;
    const backoff = this.currentMs();
    this.#until = Date.now() + backoff;
    return backoff;
  }

  reset() {
    this.#kickCount = 0;
    this.#until = 0;
  }
}
