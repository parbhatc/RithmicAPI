import { bootChart } from "/js/app.js";
import { createRithmicDatafeed } from "./datafeed/rithmic/index.js";
import { readRithmicPageOptions } from "./rithmic-page-options.js";
import { disableRithmicNews } from "./rithmic-news-off.js";

const opts = readRithmicPageOptions();
if (!opts.news) disableRithmicNews();

bootChart({
  ...opts,
  datafeed: createRithmicDatafeed("/datafeed/rithmic"),
})
  .then((widget) => {
    if (typeof window !== "undefined") window.__BWC_WIDGET__ = widget;
  })
  .catch((err) => {
    console.error(err);
    document.getElementById("app-loader")?.classList.add("app-loader--hidden");
  });
