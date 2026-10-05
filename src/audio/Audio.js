// Audio engine API (procedural, WebAudio). The audio module is owned by the
// audio sub-project; this file defines the stable API everyone calls.
//
//   audio.unlock()                       call from a user gesture (title click)
//   audio.setScene(name, music)          name: 'cosmos'|'galaxy'|'system'|'planet'
//                                        music: aesthetic.music ({root, scale, tempo, timbre}) or null
//   audio.setTimeOfDay(t01)              planet: 0 = midnight, 0.5 = noon
//   audio.setFlight(speed01, altitude01) intensity for wind/engine layers
//   audio.setEngine(kind|null, throttle) 'bike'|'ship'|null
//   audio.sfx(name, opts)                'select','hover','warp','arrive','jump','land','step','board','alight','boost','discover','ui'
//   audio.setVolume(v) / audio.toggleMute()
//   audio.update(dt)

export class AudioEngine {
  constructor(engine) {
    this.engine = engine;
    this.ctx = null;
    this.master = null;
    this.volume = 0.8;
    this.muted = false;
    this.scene = null;
  }
  async unlock() {
    if (this.ctx) { if (this.ctx.state !== 'running') await this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC({ latencyHint: 'playback' });
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
  }
  setScene(name, music = null) { this.scene = { name, music }; }
  setTimeOfDay() {}
  setFlight() {}
  setEngine() {}
  sfx() {}
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = this.muted ? 0 : v; }
  toggleMute() { this.muted = !this.muted; this.setVolume(this.volume); }
  update() {}
}
