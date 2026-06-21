import { HistoryPlanet } from "./HistoryPlanet.js";
import { TickerPlanet } from "./TickerPlanet.js";
import { LivePlanet } from "./LivePlanet.js";
import { OrderPlanet } from "./OrderPlanet.js";
import { PnLPlanet } from "./PnLPlanet.js";

export class Planets {
  #session;
  #history;
  #ticker;
  #live;
  #order;
  #pnl;

  constructor(session) {
    this.#session = session;
  }

  getHistory() {
    return (this.#history ??= new HistoryPlanet(this.#session));
  }

  getTicker() {
    return (this.#ticker ??= new TickerPlanet(this.#session));
  }

  getLive() {
    return (this.#live ??= new LivePlanet(this.#session));
  }

  getOrder() {
    return (this.#order ??= new OrderPlanet(this.#session));
  }

  getPnL() {
    return (this.#pnl ??= new PnLPlanet(this.#session));
  }

  get history() {
    return this.getHistory();
  }

  get ticker() {
    return this.getTicker();
  }

  get live() {
    return this.getLive();
  }

  get order() {
    return this.getOrder();
  }

  get pnl() {
    return this.getPnL();
  }
}
