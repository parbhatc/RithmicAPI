import { bootChart } from "/js/app.js";
import { createRithmicDatafeed } from "./js/datafeed/rithmic/index.js";
import { readRithmicPageOptions } from "./js/rithmic-page-options.js";
import { disableRithmicNews } from "./js/rithmic-news-off.js";

const opts = readRithmicPageOptions();
if (!opts.news) disableRithmicNews();

bootChart({
  ...opts,
  datafeed: createRithmicDatafeed("/datafeed/rithmic"),
}).catch(console.error);
