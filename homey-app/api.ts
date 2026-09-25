import type SolisBatteryApp from './app.js';

/**
 * App web API. The only route needs a Homey login or a Homey API key: there is deliberately no
 * public route, so nothing about the house is reachable without Homey's own authentication.
 */
export default {
  async getView({ homey }: { homey: { app: SolisBatteryApp } }): Promise<unknown> {
    return homey.app.getView();
  },
};
