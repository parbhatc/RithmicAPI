import { ClientPlanet } from "./ClientPlanet.js";

export class PnLPlanet extends ClientPlanet {
  constructor(session) {
    super(session, "PnL", () => session.pnlClient);
  }
}
