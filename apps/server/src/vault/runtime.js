// Wires the vault pieces for one server: one JobResolver registered with the chain, one VaultCoordinator per
// vault table, the chain's events fanned out to them, the periodic tick and the periodic full re-read of the
// chain view, all on the injected clock. Nothing here decides anything: the coordinators and the resolver do.
//
// The TableActor and its coordinator need each other (the coordinator talks to the actor through `host`),
// so every coordinator gets a HostProxy: attachHost(tableId, actor) points it at the actor once the actor
// exists. Messages sent before that go nowhere, which is safe: a member gets the epoch, the newest bundle and
// the open signreq again when they connect or claim.

import { VaultCoordinator } from './coordinator.js';
import { JobResolver } from './job-resolver.js';
import { POLICY_DEFAULTS } from './vault-config.js';

const HOST_METHODS = [
  'send',
  'publishStatus',
  'unseat',
  'scheduleStart',
  'rekey',
  'inHand',
  'seatOf',
];

/** Forwards the host interface to whatever target is attached; a missing target or method is a no-op. */
export class HostProxy {
  #target = null;

  constructor(target = null) {
    this.#target = target;
    for (const method of HOST_METHODS) {
      this[method] = (...args) => {
        const fn = this.#target?.[method];
        if (typeof fn !== 'function') return method === 'inHand' ? false : undefined;
        return fn.apply(this.#target, args);
      };
    }
  }

  attach(target) {
    this.#target = target;
  }

  get target() {
    return this.#target;
  }
}

/**
 * @param {{ store: object, chain: object, signer: object, clock: object,
 *   hostFactory?: (cfg: object) => object, config: { tables: object[], policy?: object } }} deps
 *   config.tables  one cfg per vault table (parseVaultConfig().tables)
 *   config.policy  server-wide knobs: tickMs, rereadMs, challengeMarginSec (each table's own policy wins
 *                  for everything else)
 * Returns { start, close, tick, reread, coordinator(tableId), coordinators(), attachHost(tableId, host),
 *   resolver }.
 */
export function createVaultRuntime({ store, chain, signer, clock, hostFactory, config }) {
  if (!config || !Array.isArray(config.tables)) throw new TypeError('config.tables is required');
  const policy = { ...POLICY_DEFAULTS, ...(config.policy ?? {}) };
  const resolver = new JobResolver({
    store,
    chain,
    challengeMarginSec: policy.challengeMarginSec,
  });
  // FakeChain takes the resolver as a property; a real adapter may offer a setter method instead
  if (typeof chain.setResolver === 'function') chain.setResolver(resolver);
  else chain.resolver = resolver;

  const hosts = new Map();
  const coordinators = new Map();
  for (const cfg of config.tables) {
    if (coordinators.has(cfg.id)) throw new RangeError(`duplicate vault table ${cfg.id}`);
    const host = new HostProxy(hostFactory ? hostFactory(cfg) : null);
    hosts.set(cfg.id, host);
    coordinators.set(cfg.id, new VaultCoordinator({ cfg, store, chain, signer, clock, host }));
  }

  let started = false;
  let closed = false;
  let unsubscribe = null;
  let tickTimer = null;
  let rereadTimer = null;

  const tick = () => {
    for (const coordinator of coordinators.values()) coordinator.tick();
  };
  const reread = () => {
    if (typeof chain.refresh === 'function') chain.refresh();
    else if (typeof chain.repair === 'function') chain.repair();
  };
  const tickLoop = () => {
    tickTimer = null;
    if (closed) return;
    tick();
    tickTimer = clock.setTimeout(tickLoop, policy.tickMs);
  };
  const rereadLoop = () => {
    rereadTimer = null;
    if (closed) return;
    try {
      reread();
    } finally {
      rereadTimer = clock.setTimeout(rereadLoop, policy.rereadMs);
    }
  };

  return {
    resolver,

    /** Subscribe, initialise every coordinator (recovery included), then start the timers. */
    start() {
      if (started || closed) return;
      started = true;
      unsubscribe = chain.subscribe((event) => {
        for (const coordinator of coordinators.values()) coordinator.onChainEvent(event);
      });
      for (const coordinator of coordinators.values()) coordinator.init();
      tickTimer = clock.setTimeout(tickLoop, policy.tickMs);
      rereadTimer = clock.setTimeout(rereadLoop, policy.rereadMs);
    },

    /** Stop the timers and the subscription. The store is the caller's to close. */
    close() {
      if (closed) return;
      closed = true;
      if (tickTimer !== null) clock.clearTimeout(tickTimer);
      if (rereadTimer !== null) clock.clearTimeout(rereadTimer);
      tickTimer = null;
      rereadTimer = null;
      unsubscribe?.();
      unsubscribe = null;
    },

    get closed() {
      return closed;
    },

    tick,
    reread,

    coordinator(tableId) {
      return coordinators.get(tableId) ?? null;
    },

    coordinators() {
      return [...coordinators.values()];
    },

    /** Point a table's host at its TableActor (or any object with the host methods). */
    attachHost(tableId, host) {
      const proxy = hosts.get(tableId);
      if (!proxy) throw new RangeError(`no vault table ${tableId}`);
      proxy.attach(host);
    },
  };
}
