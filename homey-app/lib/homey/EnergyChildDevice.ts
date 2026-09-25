import Homey from 'homey';

import type { LiveData } from '../inverter/types.js';

/** The inverter device as the energy devices see it. */
export interface InverterParent {
  getData(): { id: string };
  getName(): string;
  latestLive(): LiveData | null;
}

interface EnergyChild {
  getData(): { parent?: string };
  onLive(live: LiveData): Promise<void>;
}

type HomeyInstance = Homey.Device['homey'];

const allDevices = (homey: HomeyInstance): unknown[] => Object.values(homey.drivers.getDrivers()).flatMap((d) => d.getDevices());

/** The home battery devices of every brand's driver, in pairing order. */
export function inverterDevices<T extends InverterParent = InverterParent>(homey: HomeyInstance): T[] {
  return allDevices(homey).filter((d): d is T => typeof (d as Partial<InverterParent>).latestLive === 'function');
}

/** The solar panel and grid meter devices that belong to an inverter device. */
export function energyChildren(homey: HomeyInstance, parentId: string): EnergyChild[] {
  return allDevices(homey)
    .filter((d): d is EnergyChild => typeof (d as Partial<EnergyChild>).onLive === 'function')
    .filter((d) => d.getData().parent === parentId);
}

/**
 * Solar panels and the grid meter as their own Homey devices, so Homey Energy shows production and
 * grid import/export (a hybrid inverter must appear as one device per role). They get their values
 * from the inverter device they belong to, whatever its brand: no extra requests to the inverter.
 */
export abstract class EnergyChildDevice extends Homey.Device {
  get parentId(): string {
    return (this.getData() as { parent: string }).parent;
  }

  override async onInit(): Promise<void> {
    const live = this.parent()?.latestLive();
    if (live) await this.onLive(live);
    else await this.setUnavailable(this.homey.__('child.waiting')).catch(this.error);
  }

  private parent(): InverterParent | undefined {
    return inverterDevices(this.homey).find((d) => d.getData().id === this.parentId);
  }

  /** New values from the inverter device. */
  async onLive(live: LiveData): Promise<void> {
    await this.update(live);
    if (!this.getAvailable()) await this.setAvailable();
  }

  protected abstract update(live: LiveData): Promise<void>;

  protected async set(capability: string, value: number): Promise<void> {
    if (Number.isFinite(value) && this.hasCapability(capability)) await this.setCapabilityValue(capability, value);
  }
}

/** Pairing: one energy device per inverter that does not have one yet. */
export class EnergyChildDriver extends Homey.Driver {
  protected suffix = '';
  protected nameKey = '';

  override async onPairListDevices(): Promise<Array<{ name: string; data: { id: string; parent: string } }>> {
    const taken = new Set(this.getDevices().map((d) => (d.getData() as { parent: string }).parent));
    const inverters = inverterDevices(this.homey);
    if (inverters.length === 0) throw new Error(this.homey.__('child.noInverter'));
    return inverters
      .filter((inv) => !taken.has(inv.getData().id))
      .map((inv) => ({
        name: inverters.length > 1 ? `${this.homey.__(this.nameKey)} (${inv.getName()})` : this.homey.__(this.nameKey),
        data: { id: `${inv.getData().id}-${this.suffix}`, parent: inv.getData().id },
      }));
  }
}
