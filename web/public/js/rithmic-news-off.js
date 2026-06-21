import { getNewsSettingsStore } from "/js/news/settings.js";

/** Rithmic web has no news backend — disable fetches and hide UI. */
export function disableRithmicNews() {
  getNewsSettingsStore().setEnabled(false);
}
