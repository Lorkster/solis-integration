import type SolisBatteryApp from '../../app.js';

export default {
  async getPlan({ homey }: { homey: { app: SolisBatteryApp } }): Promise<unknown> {
    return homey.app.getPlanView();
  },
};
