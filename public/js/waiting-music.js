/** Musique d'attente indépendante du TTS : aucune réponse tardive ne la relance. */
export class WaitingMusic {
  constructor({ audio, tracks, volume, changed = () => {}, error = () => {}, random = Math.random }) {
    Object.assign(this, { audio, tracks, volume, changed, error, random });
    this.active = false;
    this.version = 0;
    this.last = null;
    this.release = null;
    this.available = [];
    audio.loop = false;
    audio.addEventListener("ended", () => { if (this.active) void this.next(this.version); });
    audio.addEventListener("error", () => {
      if (!this.active) return;
      this.available = this.available.filter(track => track !== this.current);
      void this.next(this.version);
    });
  }
  async start() {
    if (this.active) return;
    this.active = true;
    const version = ++this.version;
    this.controller = new AbortController();
    try {
      const tracks = await this.tracks(this.controller.signal);
      if (!this.active || version !== this.version) return;
      this.available = tracks;
      await this.next(version);
    } catch (err) {
      if (version !== this.version || !this.active) return;
      this.stop();
      this.error(err.message);
    }
  }
  async next(version) {
    if (!this.active || version !== this.version) return;
    this.release?.();
    this.release = null;
    if (!this.available.length) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.changed(null);
      return;
    }
    const alternatives = this.available.filter(track => track.id !== this.last);
    const choices = alternatives.length ? alternatives : this.available;
    this.current = choices[Math.floor(this.random() * choices.length)];
    this.last = this.current.id;
    const source = this.current.open();
    this.release = source.release;
    this.audio.src = source.url;
    this.audio.volume = this.volume();
    try {
      await this.audio.play();
      if (!this.active || version !== this.version) return;
      this.changed(this.current.name);
    } catch (err) {
      if (!this.active || version !== this.version) return;
      // Un refus d'autoplay n'est pas contourné : l'antenne reste disponible.
      this.stop();
      this.error(err.message);
    }
  }
  stop() {
    this.active = false;
    ++this.version;
    this.controller?.abort();
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.release?.();
    this.release = null;
    this.changed(null);
  }
}
