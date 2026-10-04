/** Table directory and a player -> table index. A player sits at one table at a time. */
export class Registry {
  #actors = new Map();
  #playerTable = new Map();

  add(actor) {
    this.#actors.set(actor.id, actor);
  }

  get(tableId) {
    return this.#actors.get(tableId) ?? null;
  }

  get size() {
    return this.#actors.size;
  }

  /** Called by actors as players sit down (tableId) and leave (null). */
  setSeat(playerId, tableId) {
    if (tableId === null) this.#playerTable.delete(playerId);
    else this.#playerTable.set(playerId, tableId);
  }

  tableOf(playerId) {
    const tableId = this.#playerTable.get(playerId);
    return tableId === undefined ? null : this.get(tableId);
  }

  summaries() {
    return [...this.#actors.values()].map((actor) => actor.summary());
  }

  /** Sum of chips sitting at every table, for conservation checks. */
  chipsOnTables() {
    let total = 0;
    for (const actor of this.#actors.values()) total += actor.chipsOnTable();
    return total;
  }

  destroyAll() {
    for (const actor of this.#actors.values()) actor.destroy();
  }
}
