const failure = code => Object.assign(new Error(code), {code});
export const providerHttpError = status => Object.assign(failure(status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_HTTP_ERROR'), {status});
export const providerNetworkError = () => failure('PROVIDER_NETWORK_ERROR');

// Attempts reserve cost before dispatch; uncertain delivery is never retried automatically.
export class ProviderPolicy {
  constructor({now = () => Date.now(), maxInFlight = 1, minIntervalMs = 250, maxCallsPerMinute = 20, maxCostPerMinute = 0.10, backoffBaseMs = 1000, backoffMaxMs = 60000} = {}) {
    if (typeof now !== 'function' || !Number.isInteger(maxInFlight) || maxInFlight < 1 || !Number.isFinite(minIntervalMs) || minIntervalMs < 0 || !Number.isInteger(maxCallsPerMinute) || maxCallsPerMinute < 1 || !Number.isFinite(maxCostPerMinute) || maxCostPerMinute < 0 || !Number.isFinite(backoffBaseMs) || backoffBaseMs <= 0 || !Number.isFinite(backoffMaxMs) || backoffMaxMs < backoffBaseMs) throw new TypeError('invalid provider policy');
    Object.assign(this, {now,maxInFlight,minIntervalMs,maxCallsPerMinute,maxCostPerMinute,backoffBaseMs,backoffMaxMs});
    this.inFlight = 0; this.calls = []; this.lastAt = -Infinity; this.failures = 0; this.blockedUntil = 0;
  }
  async run({cost, signal}, work) {
    if (!Number.isFinite(cost) || cost < 0 || typeof work !== 'function') throw failure('PROVIDER_INVALID_REQUEST');
    if (signal?.aborted) throw failure('PROVIDER_CANCELLED');
    const at = this.now();
    if (!Number.isFinite(at) || at < this.lastAt) throw failure('PROVIDER_CLOCK_ERROR');
    this.calls = this.calls.filter(call => at - call.at < 60000);
    if (at < this.blockedUntil) throw failure('PROVIDER_CIRCUIT_OPEN');
    if (this.inFlight >= this.maxInFlight) throw failure('PROVIDER_BUSY');
    if (at - this.lastAt < this.minIntervalMs) throw failure('PROVIDER_MIN_INTERVAL');
    if (this.calls.length >= this.maxCallsPerMinute || this.calls.reduce((sum, call) => sum + call.cost, 0) + cost > this.maxCostPerMinute + 1e-12) throw failure('PROVIDER_BUDGET_EXCEEDED');
    this.inFlight++; this.lastAt = at; this.calls.push({at,cost});
    try {
      const result = await work();
      this.failures = 0; this.blockedUntil = 0;
      return result;
    } catch (error) {
      if ((error?.code === 'PROVIDER_RATE_LIMITED' || error?.code === 'PROVIDER_NETWORK_ERROR') && !signal?.aborted) {
        this.failures++;
        const current = this.now();
        if (Number.isFinite(current)) this.blockedUntil = Math.max(current,at) + Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** Math.min(this.failures - 1, 30));
      }
      throw error;
    } finally { this.inFlight--; }
  }
}
export const sharedProviderPolicy = new ProviderPolicy();
