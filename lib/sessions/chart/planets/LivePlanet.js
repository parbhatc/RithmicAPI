export class LivePlanet {
  #session;

  constructor(session) {
    this.#session = session;
  }

  start(options = {}) {
    return this.#session.liveFeed.start(this.#session, this.#session.ctx(), options);
  }

  stop() {
    return this.#session.liveFeed.stop(this.#session, this.#session.ctx());
  }

  pauseHistoryPump() {
    const client = this.#session.historyClient;
    this.#session.liveFeed.pauseHistoryPump(client);
  }

  resumeHistoryPump() {
    this.#session.liveFeed.resumeHistoryPump();
  }

  get active() {
    return this.#session.liveFeed.live;
  }
}
