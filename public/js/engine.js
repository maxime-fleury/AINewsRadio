/** Independent scheduler: one job at a time, no stale completion can take the antenna. */
export class RadioEngine {
  constructor({ build, play, pause, stop, state, error, heard, progress, request, beforePlay, delay = 1500 }) {
    Object.assign(this, { build, play, pauseAudio: pause, stopAudio: stop, onState: state, onError: error, onHeard: heard, progress, request, beforePlay, delay });
    this.running = false;
    this.current = null;
    this.queue = [];
    this.requests = [];
    this.conversation = [];
    this.version = 0;
    this.job = null;
    this.timer = null;
    this.failures = 0;
    this.warming = true;
  }
  emit() { this.onState(this); }
  invalidate() {
    this.version++;
    this.job?.controller.abort();
    clearTimeout(this.timer);
    this.timer = null;
  }
  capture(complete = false) {
    if (!this.current || this.current.id === this.ignoredContextId) return;
    const segment = this.current;
    const chars = this.progress(segment, complete);
    if (chars > 0) {
      const entry = { id: segment.id, topic: segment.topic, question: segment.question || "", text: segment.transcript.slice(0, chars), knowledge: !!segment.knowledge };
      const index = this.conversation.findIndex(x => x.id === segment.id);
      if (index >= 0) this.conversation[index] = entry;
      else this.conversation.push(entry);
      this.conversation = this.conversation.slice(-6);
      // C'est la mémoire éditoriale (serveur) qui décide à partir de quel seuil
      // une histoire compte comme entendue : on lui donne la position atteinte et
      // `complete`, qui dit seulement que le passage est allé au bout.
      this.onHeard?.(segment, chars, complete);
    }
  }
  context() { this.capture(); return this.conversation.map(x => ({ ...x, text: x.text.slice(-1600) })); }
  cancelTransition() { this.transition?.abort(); this.transition = null; }
  async begin(segment) {
    this.cancelTransition();
    this.current = segment;
    this.needsIntro = !!this.beforePlay;
    if (!this.beforePlay) { this.play(segment, true); this.emit(); return; }
    const controller = new AbortController();
    this.transition = controller;
    this.emit();
    try {
      await this.beforePlay(segment, controller.signal);
      if (controller.signal.aborted || !this.running || this.current !== segment) return;
      this.needsIntro = false;
      this.transition = null;
      this.play(segment, true);
      this.emit();
    } catch (err) {
      if (!controller.signal.aborted && this.running && this.current === segment) {
        this.transition = null;
        this.current = null;
        this.failed(err.message);
      }
    }
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    if (this.current) { if (this.needsIntro) void this.begin(this.current); else this.play(this.current, false); }
    this.emit();
    this.pump();
  }
  pause() {
    this.capture();
    this.running = false;
    this.cancelTransition();
    this.invalidate();
    this.pauseAudio();
    this.emit();
  }
  stop() {
    this.capture();
    this.running = false;
    this.cancelTransition();
    this.invalidate();
    this.queue = [];
    this.requests = [];
    this.current = null;
    this.warming = true;
    this.stopAudio();
    this.emit();
  }
  changeTopic() {
    this.capture();
    if (this.needsIntro) { this.cancelTransition(); this.current = null; this.stopAudio(); }
    this.invalidate();
    this.queue = [];
    this.requests = [];
    this.emit();
    this.pump();
  }
  enqueue(req, immediate = false) {
    const wasRunning = this.running;
    this.capture();
    this.invalidate();
    // Keep ready clips on air while the priority answer is being generated.
    this.requests.push(req);
    if (immediate || this.needsIntro) {
      this.warming = false;
      this.cancelTransition();
      this.current = null;
      this.stopAudio();
    }
    this.running = true;
    this.failures = 0;
    if (!wasRunning && this.current) { if (this.needsIntro) void this.begin(this.current); else this.play(this.current, false); }
    this.emit();
    this.pump();
  }
  ended() {
    if (!this.current || !this.running || this.transition) return;
    this.capture(true);
    this.current = null;
    this.emit();
    this.pump();
  }
  skip() {
    this.warming = false;
    this.capture();
    this.cancelTransition();
    this.current = null;
    this.stopAudio();
    this.running = true;
    this.emit();
    this.pump();
  }
  audioError(message) {
    if (!this.running) return;
    this.cancelTransition();
    this.capture();
    this.current = null;
    this.stopAudio();
    this.failed(message);
  }
  failed(message) {
    this.failures++;
    this.onError(message);
    if (this.failures >= 3) {
      this.pause();
      this.onError("Trois échecs consécutifs : antenne en pause. Reprends quand le service est disponible.");
    } else {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, this.delay * this.failures);
      this.emit();
    }
  }
  replay(segment) {
    this.capture();
    this.invalidate();
    this.queue = [];
    this.requests = [];
    this.cancelTransition();
    this.current = segment;
    this.running = true;
    this.needsIntro = false;
    this.warming = false;
    this.play(segment, true);
    this.emit();
    this.pump();
  }
  clearConversation() { this.conversation = []; this.ignoredContextId = this.current?.id; }
  async pump() {
    if (!this.running || this.timer) return;
    const { prefetch, ...normal } = this.request();
    const target = Math.max(1, prefetch);
    if (this.warming && this.queue.length >= target) this.warming = false;
    if (!this.current && this.queue.length && !this.warming) {
      void this.begin(this.queue.shift());
    }
    if (this.job) return;
    if (this.current && !this.requests.length && this.queue.length >= prefetch) return;
    const priority = this.requests[0];
    const req = priority || normal;
    const version = this.version;
    const controller = new AbortController();
    const job = { controller, req, priority };
    this.job = job;
    this.emit();
    try {
      const context = this.context();
      const prepared = [this.current, ...this.queue].filter(Boolean).map(s => ({ topic: s.topic, text: s.transcript.slice(this.current?.id === s.id ? this.progress(s) : 0, 3000) }));
      const result = await this.build({ ...req, context, prepared }, controller.signal);
      if (controller.signal.aborted || version !== this.version || !this.running) return;
      if (priority && this.requests[0] === priority) this.requests.shift();
      this.failures = 0;
      if (priority) { this.queue.unshift(result); this.warming = false; }
      else this.queue.push(result);
    } catch (err) {
      if (!controller.signal.aborted && version === this.version && this.running) this.failed(err.message);
    } finally {
      if (this.job === job) this.job = null;
      this.emit();
      if (this.running && !this.timer) void this.pump();
    }
  }
}

export function costProjection(stats) {
  const seconds = Number(stats.audioSeconds) || 0;
  const cost = Math.max(0, Number(stats.totalCostUsd) || 0);
  return seconds >= 60 ? { perMinute: cost * 60 / seconds, perHour: cost * 3600 / seconds } : null;
}
