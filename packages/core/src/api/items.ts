import { sleep } from '../util/async.js';
import type { Item, ItemRequirement, Shop } from '../state/types.js';
import type { ApiDeps } from './player.js';

export class InventoryApi {
  constructor(private readonly deps: ApiDeps) {}

  get items(): readonly Item[] {
    return this.deps.state.inventory;
  }

  /** Item lookup by id or (case-insensitive) name. */
  find(key: number | string): Item | undefined {
    return this.deps.state.findItem(key);
  }

  count(key: number | string): number {
    return this.deps.state.itemCount(key);
  }

  contains(key: number | string, quantity = 1): boolean {
    return this.deps.state.hasItem(key, quantity);
  }

  hasAll(requirements: readonly ItemRequirement[]): boolean {
    return this.deps.state.hasRequirements(requirements);
  }

  missing(requirements: readonly ItemRequirement[]): ItemRequirement[] {
    return this.deps.state.missingRequirements(requirements);
  }

  async equip(key: number | string): Promise<void> {
    const { bridge, log, options, clock, token } = this.deps;
    const item = this.find(key);
    if (!item) {
      log.warn(`Cannot equip "${key}" - not in inventory`);
      return;
    }
    if (item.equipped) return;
    log.info(`Equipping ${item.name}`);
    await bridge.call('player.equip', { itemId: item.id });
    await sleep(options.actionDelayMs, token(), clock);
  }

  async use(key: number | string): Promise<void> {
    const { bridge, log, options, clock, token } = this.deps;
    const item = this.find(key);
    if (!item) {
      log.warn(`Cannot use "${key}" - not in inventory`);
      return;
    }
    await bridge.call('player.useItem', { itemId: item.id });
    await sleep(options.actionDelayMs, token(), clock);
  }

  /** Sell an item. Dragon Coin items are refused unless `force` is set. */
  async sell(key: number | string, quantity = 1, force = false): Promise<boolean> {
    const { bridge, log, options, clock, token } = this.deps;
    const item = this.find(key);
    if (!item) return false;
    if (item.dragonCoinItem && !force) {
      log.warn(`Refusing to sell Dragon Coin item ${item.name} (pass force to override)`);
      return false;
    }
    const sold = await bridge.call('shop.sell', { itemId: item.id, quantity });
    await sleep(options.actionDelayMs, token(), clock);
    return sold;
  }
}

export class ShopApi {
  constructor(private readonly deps: ApiDeps) {}

  get current(): Shop | null {
    return this.deps.state.current.shop;
  }

  async load(shopId: number): Promise<Shop | null> {
    const { bridge, options, clock, token } = this.deps;
    const shop = await bridge.call('shop.load', { shopId });
    await sleep(options.actionDelayMs, token(), clock);
    return shop;
  }

  async buy(shopId: number, itemId: number, quantity = 1): Promise<boolean> {
    const { bridge, log, options, clock, token } = this.deps;
    log.info(`Buying item ${itemId} x${quantity} from shop ${shopId}`);
    const bought = await bridge.call('shop.buy', { shopId, itemId, quantity });
    await sleep(options.actionDelayMs, token(), clock);
    return bought;
  }
}
