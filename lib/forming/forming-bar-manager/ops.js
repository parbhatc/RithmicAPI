import { createSeedOps } from "./seed.js";
import { createBootstrap1mOps } from "./bootstrap-1m.js";
import { createOneMinuteLiveOps } from "./one-minute-live.js";
import { createBootstrapHourlyOps } from "./bootstrap-hourly.js";
import { createBootstrapCalendarOps } from "./bootstrap-calendar.js";
import { createBootstrapNativeOps } from "./bootstrap-native.js";
import { createSessionOps } from "./session.js";
import { createLiveSyncOps } from "./live-sync.js";

export function createOps(s, emit) {
  /** @type {Record<string, Function>} */
  const ops = {};
  const call = (name, ...args) => ops[name](...args);
  Object.assign(ops, createSeedOps(s, emit, call));
  Object.assign(ops, createBootstrap1mOps(s, emit, call));
  Object.assign(ops, createOneMinuteLiveOps(s, emit, call));
  Object.assign(ops, createBootstrapHourlyOps(s, emit, call));
  Object.assign(ops, createBootstrapCalendarOps(s, emit, call));
  Object.assign(ops, createBootstrapNativeOps(s, emit, call));
  Object.assign(ops, createSessionOps(s, emit, call));
  Object.assign(ops, createLiveSyncOps(s, emit, call));
  return ops;
}
