// One active request and at most one pending frame. Work must honor AbortSignal
// where possible; late completions are always rejected even if it does not.
export class LatestScheduler {
  constructor({work, publish, timeoutMs = 10000}) {
    if (typeof work !== 'function' || typeof publish !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('invalid scheduler');
    Object.assign(this, {work, publish, timeoutMs, active: false, pending: null, running: false, generation: 0, dropped: 0, timeouts: 0});
  }
  start(sessionId) { if (this.active || this.running || typeof sessionId !== 'string' || !sessionId) throw new Error('scheduler busy or invalid session'); this.sessionId = sessionId; this.active = true; this.generation++; }
  submit(frame) {
    if (!this.active) return false;
    const request = {frame, sessionId: this.sessionId, generation: ++this.generation};
    if (this.running) { if (this.pending) this.dropped++; this.pending = request; }
    else this.run(request);
    return true;
  }
  stop() { this.active = false; this.generation++; this.pending = null; this.controller?.abort(); }
  async run(request) {
    this.running = true;
    this.current = request;
    const controller = new AbortController(); this.controller = controller;
    let timer;
    try {
      // Abort marks the result unusable but does not release the concurrency slot:
      // an uncooperative worker may still be running after its deadline.
      timer = setTimeout(() => { this.timeouts++; controller.abort(); }, this.timeoutMs);
      const result = await Promise.resolve().then(() => this.work(request.frame, {signal: controller.signal, sessionId: request.sessionId}));
      if (this.active && request.sessionId === this.sessionId && request.generation === this.generation && !controller.signal.aborted) this.publish(result, request);
    } catch { /* timeout or failure: no publication */ }
    finally {
      clearTimeout(timer); this.running = false; this.controller = null; this.current = null;
      const next = this.pending; this.pending = null;
      if (this.active && next) this.run(next);
    }
  }
}
