/** Shim — experiment forming code expects `./history-query.js`. */
import { HistoryQuery } from "../HistoryQuery.js";

export function parseResolution(resolution) {
  return HistoryQuery.parseResolution(resolution);
}

export function parseTickResolution(resolution) {
  return HistoryQuery.parseTickResolution(resolution);
}

export function aggregateTickBars(bars, tickSize) {
  return HistoryQuery.aggregateTickBars(bars, tickSize);
}

export function isCalendarResolution(resolution) {
  return HistoryQuery.isCalendarResolution(resolution);
}
