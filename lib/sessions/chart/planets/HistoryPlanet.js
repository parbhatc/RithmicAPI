import { TimeBarHistory } from "../TimeBarHistory.js";
import { TickBarHistory } from "../TickBarHistory.js";

export class HistoryPlanet {
  #session;
  #chain = Promise.resolve();

  constructor(session) {
    this.#session = session;
  }

  load(options = {}) {
    return this.#run((ctx, opts) => TimeBarHistory.load(ctx, opts), options);
  }

  loadTick(options = {}) {
    return this.#run((ctx, opts) => TickBarHistory.load(ctx, opts), options);
  }

  #run(loader, options = {}) {
    const { symbol, exchange, ...queryOpts } = options;
    if (symbol) this.#session.symbol = symbol;
    if (exchange) this.#session.exchange = exchange;

    const run = () =>
      loader(this.#session.ctx({ symbol, exchange }), {
        symbol,
        exchange,
        ...queryOpts,
      });

    const result = this.#chain.then(run);
    this.#chain = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
