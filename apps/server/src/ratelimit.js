/** Token bucket: `capacity` burst, refilled at `refillPerSec`. One per connection. */
export class TokenBucket {
  #capacity;
  #refillPerMs;
  #tokens;
  #last;
  #now;

  constructor({ capacity, refillPerSec, now = Date.now }) {
    this.#capacity = capacity;
    this.#refillPerMs = refillPerSec / 1000;
    this.#now = now;
    this.#tokens = capacity;
    this.#last = now();
  }

  /** @returns {boolean} true if the call is allowed */
  take(cost = 1) {
    const now = this.#now();
    this.#tokens = Math.min(this.#capacity, this.#tokens + (now - this.#last) * this.#refillPerMs);
    this.#last = now;
    if (this.#tokens < cost) return false;
    this.#tokens -= cost;
    return true;
  }
}
