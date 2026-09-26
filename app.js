"use strict";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const g = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;

const ui = {
  file: $("file"), drop: $("drop"), fileName: $("fileName"), url: $("url"),
  speed: $("speed"), intensity: $("intensity"), reverb: $("reverb"),
  speedOut: $("speedOut"), intensityOut: $("intensityOut"), reverbOut: $("reverbOut"),
  showHead: $("showHead"), showLogo: $("showLogo"), showIntro: $("showIntro"),
  showLyrics: $("showLyrics"), lyricsOffset: $("lyricsOffset"), lyricsOffsetText: $("lyricsOffsetText"),
  lyricsLine: $("lyricsLine"), lyricsNow: $("lyricsNow"),
  start: $("start"), end: $("end"), startTime: $("startTime"), endTime: $("endTime"), duration: $("duration"), excerptInfo: $("excerptInfo"),
  rate: $("rate"), rateOut: $("rateOut"), keepPitch: $("keepPitch"),
  pos: $("pos"), posTime: $("posTime"),
  play: $("play"), exportBtn: $("export"), cancel: $("cancel"),
  progress: $("progress"), progressBar: $("progressBar"), progressText: $("progressText"),
  download: $("download"), format: $("format"),
};

// ---------- Sliders ----------
// The filled part of each slider is drawn in CSS from --from/--to. Bipolar
// sliders (data-zero) fill from their neutral value. The value setter is
// wrapped so sliders moved by code (playback, Sync auto…) repaint too.
const rangeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
function paintRange(el) {
  const min = +el.min || 0, max = +el.max || 0;
  const pct = (v) => `${max > min ? ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100 : 0}%`;
  const v = +rangeValue.get.call(el);
  const zero = el.dataset.zero === undefined ? min : +el.dataset.zero;
  el.style.setProperty("--from", pct(Math.min(zero, v)));
  el.style.setProperty("--to", pct(Math.max(zero, v)));
}
document.querySelectorAll('input[type="range"]').forEach((el) => {
  Object.defineProperty(el, "value", {
    get: () => rangeValue.get.call(el),
    set: (v) => { rangeValue.set.call(el, v); paintRange(el); },
  });
  el.addEventListener("input", () => paintRange(el));
  new MutationObserver(() => paintRange(el)).observe(el, { attributes: true, attributeFilter: ["min", "max"] });
  paintRange(el);
});

// ---------- Audio graph ----------
// source ─┬─ lowpass ─────────────────────────────── bass (centre) ─┐
//         └─ highpass ─┬─ panner (HRTF) ─ gain(intensité) ─┐       ├─ master
//                      └─ gain(1 - intensité) ─────────────┴─ mix ─┤
//                                  mix ─ predelay ─ convolver ─ damp ─┘
// master ─┬─ (dry) ──────────────────────────────────────────────────────┬─ masterOut ─┬─ destination
//         └─ (studio) EQ ─ compressor ─ makeup ─ limiter ────────────────┘             └─ recDest
const ctx = new (window.AudioContext || window.webkitAudioContext)();
const CROSSOVER = 120;
const impulse = makeImpulse(2.8, 2.5);

// Builds the chain in any context: the live one, or an OfflineAudioContext for the fast export.
function buildChain(ac) {
  const n = {
    lowpass: new BiquadFilterNode(ac, { type: "lowpass", frequency: CROSSOVER, Q: 0.7 }),
    highpass: new BiquadFilterNode(ac, { type: "highpass", frequency: CROSSOVER, Q: 0.7 }),
    panner: new PannerNode(ac, {
      panningModel: "HRTF", distanceModel: "inverse", refDistance: 1, rolloffFactor: 0,
      channelCount: 1, channelCountMode: "explicit",
    }),
    pannedGain: new GainNode(ac),
    centerGain: new GainNode(ac),
    mix: new GainNode(ac),
    convolver: new ConvolverNode(ac, { buffer: impulse }),
    wetGain: new GainNode(ac),
    bassGain: new GainNode(ac, { gain: 1 }),
    master: new GainNode(ac, { gain: 0.9 }),
    // Studio: pre-delay and darker tail on the reverb, then a mastering chain.
    predelay: new DelayNode(ac, { maxDelayTime: 0.1 }),
    damp: new BiquadFilterNode(ac, { type: "lowpass", frequency: 20000, Q: 0.5 }),
    eqLow: new BiquadFilterNode(ac, { type: "lowshelf", frequency: 110, gain: 2.5 }),
    eqMud: new BiquadFilterNode(ac, { type: "peaking", frequency: 320, Q: 1, gain: -2 }),
    eqAir: new BiquadFilterNode(ac, { type: "highshelf", frequency: 9000, gain: 3 }),
    glue: new DynamicsCompressorNode(ac, { threshold: -20, knee: 8, ratio: 3, attack: 0.015, release: 0.25 }),
    makeup: new GainNode(ac, { gain: 1.6 }),
    limiter: new DynamicsCompressorNode(ac, { threshold: -2, knee: 0, ratio: 20, attack: 0.002, release: 0.08 }),
    dryOut: new GainNode(ac),
    studioOut: new GainNode(ac, { gain: 0 }),
    masterOut: new GainNode(ac),
  };
  n.lowpass.connect(n.bassGain).connect(n.master);
  n.highpass.connect(n.panner).connect(n.pannedGain).connect(n.mix);
  n.highpass.connect(n.centerGain).connect(n.mix);
  n.mix.connect(n.master);
  n.mix.connect(n.predelay).connect(n.convolver).connect(n.damp).connect(n.wetGain).connect(n.master);
  n.master.connect(n.dryOut).connect(n.masterOut);
  n.master.connect(n.eqLow).connect(n.eqMud).connect(n.eqAir).connect(n.glue).connect(n.makeup).connect(n.limiter)
    .connect(n.studioOut).connect(n.masterOut);
  n.masterOut.connect(ac.destination);
  return n;
}

const chain = buildChain(ctx);
const { lowpass, highpass, panner, masterOut } = chain;
const analyser = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0.6 });
const recDest = ctx.createMediaStreamDestination();
masterOut.connect(recDest);

function makeImpulse(seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

// Sets the sliders' mix on a chain; tau > 0 glides there (live), 0 sets it at once (export).
function applyMix(n = chain, tau = 0.05) {
  const k = +ui.intensity.value;
  const r = +ui.reverb.value;
  const studio = $("studio").checked;
  const t = n.master.context.currentTime;
  const set = (param, v) => (tau ? param.setTargetAtTime(v, t, tau) : param.setValueAtTime(v, 0));
  set(n.pannedGain.gain, k);
  set(n.centerGain.gain, 1 - k);
  set(n.wetGain.gain, r * 0.8);
  set(n.mix.gain, 1 - r * 0.35);
  set(n.dryOut.gain, studio ? 0 : 1);
  set(n.studioOut.gain, studio ? 1 : 0);
  set(n.predelay.delayTime, studio ? 0.03 : 0);
  set(n.damp.frequency, studio ? 6500 : 20000);
}

// ---------- Track state ----------
let buffer = null;
// The track plays through an <audio> element feeding the graph above: its
// playbackRate can keep the pitch (preservesPitch), like TikTok's speed setting.
const player = new Audio();
player.preload = "auto";
const playerNode = ctx.createMediaElementSource(player);
playerNode.connect(lowpass);
playerNode.connect(highpass);
playerNode.connect(analyser);
let playerUrl = null;
let playing = false;
let angle = 0;
let playStartCtx = 0; // ctx time when the music starts
let introLength = 0; // seconds of intro card shown over the start of the music, for the current playback
let introEndCtx = 0; // ctx time when the intro card is gone
let onExcerptEnd = null;
let cursor = null; // where "Écouter" resumes (track seconds); null = start of the excerpt
const INTRO_SECONDS = 1.5;
let excerpt = { start: 0, length: 30 };
let sel = { start: 0, end: 30 }; // chosen range in seconds; excerpt is derived from it
let highlight = null; // start of the chorus (track seconds), shown as a red dot on the waveform

// Output fades (40 ms). Muting on stop also cuts the reverb tail, which
// otherwise keeps ringing like an echo after the music.
function muteOutput() {
  const g = masterOut.gain, now = ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(0, now + 0.04);
}
// Fade-in over the intro on a squared curve (slow start, like a mixer fade),
// built from short ramps so a Stop in the middle can cancel it cleanly.
function unmuteOutput(at, duration) {
  muteOutput();
  fadeIn(masterOut.gain, at, duration);
}
function fadeIn(g, at, duration) {
  const d = Math.max(0.04, duration), steps = 12;
  g.setValueAtTime(0, at);
  for (let i = 1; i <= steps; i++) g.linearRampToValueAtTime((i / steps) ** 2, at + (d * i) / steps);
}

function stopSource() {
  muteOutput();
  player.pause();
  onExcerptEnd = null;
  playing = false;
  ui.play.textContent = "▶ Écouter";
  updateLyricsNow();
  drawWave();
}

// live: the excerpt changed while listening, so jump to it without the intro
// and without reshuffling the videos.
function startSource(onEnd, { live = false } = {}) {
  stopSource();
  computeExcerpt();
  // Resuming from the playback cursor skips the intro; exports always start at the beginning.
  const from = onEnd || cursor === null ? excerpt.start : cursor;
  const fromStart = from <= excerpt.start + 0.05;
  if (!live) {
    angle = 0;
    restartScenes();
  }
  // The music starts right away: the intro card sits over its first seconds
  // while the sound fades in.
  introLength = !live && fromStart && ui.showIntro.checked ? INTRO_SECONDS : 0;
  playStartCtx = ctx.currentTime;
  introEndCtx = playStartCtx + introLength;
  unmuteOutput(ctx.currentTime + 0.05, introLength);
  applyRate();
  player.currentTime = from;
  onExcerptEnd = onEnd || (() => {});
  player.play().catch(() => {});
  playing = true;
  ui.play.textContent = "■ Stop";
  updateLyricsNow();
  requestAnimationFrame(waveLoop);
}

// After a change of start/end/duration while listening, keep playing from the
// same spot; if it is now outside the excerpt, jump to its start, or to 3 s
// before its new end to hear the cut.
let relaunchTimer = null;
function relaunchIfPlaying() {
  clearTimeout(relaunchTimer);
  relaunchTimer = setTimeout(() => {
    if (!playing || recording) return;
    const end = excerpt.start + excerpt.length;
    const t = player.currentTime;
    if (t < excerpt.start) player.currentTime = excerpt.start;
    else if (t >= end) player.currentTime = Math.max(excerpt.start, end - 3);
  }, 120);
}

// Playback speed of the excerpt. With "Garder la tonalité" the voice keeps its
// pitch; without it, it gets higher/lower like "sped up" / "slowed" edits.
function rate() {
  return +ui.rate.value;
}

function applyRate() {
  player.playbackRate = rate();
  player.preservesPitch = player.webkitPreservesPitch = ui.keepPitch.checked;
}

// Safari only lets a media element play later (after the intro) if it was
// first started by a click: play it muted once, from the click handlers.
function unlockPlayer() {
  if (player.dataset.unlocked) return;
  player.dataset.unlocked = "1";
  player.muted = true;
  player.play()
    .then(() => { if (!playing || ctx.currentTime < playStartCtx) player.pause(); }) // silent during the intro
    .catch(() => {})
    .finally(() => { player.muted = false; });
}

// Stops at the end of the excerpt (checked on timeupdate and every frame).
function checkExcerptEnd() {
  if (!playing || !onExcerptEnd || ctx.currentTime < playStartCtx) return;
  if (player.ended || player.currentTime >= excerpt.start + excerpt.length) {
    const done = onExcerptEnd;
    stopSource();
    cursor = null;
    syncCursor();
    done();
  }
}
player.addEventListener("timeupdate", checkExcerptEnd);
player.addEventListener("ended", checkExcerptEnd);

// Position in the track (seconds) of what is playing now.
function playPosition() {
  return playing && ctx.currentTime >= playStartCtx ? player.currentTime : excerpt.start;
}

// 16-bit PCM WAV of a decoded buffer, so the <audio> element can play any source.
function bufferToWav(buf) {
  const channels = buf.numberOfChannels, frames = buf.length, bytes = frames * channels * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const text = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, 36 + bytes, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, buf.sampleRate, true);
  view.setUint32(28, buf.sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, bytes, true);
  const data = [];
  for (let c = 0; c < channels; c++) data.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([view], { type: "audio/wav" });
}

function minExcerpt() {
  return Math.min(1, buffer.duration);
}

function computeExcerpt() {
  if (!buffer) return;
  const total = buffer.duration;
  sel.end = Math.min(Math.max(sel.end, minExcerpt()), total);
  sel.start = Math.max(0, Math.min(sel.start, sel.end - minExcerpt()));
  excerpt = { start: sel.start, length: sel.end - sel.start };
  ui.start.max = total.toFixed(1);
  ui.start.value = sel.start;
  ui.end.max = total.toFixed(1);
  ui.end.value = sel.end;
  showTime(ui.startTime, sel.start);
  showTime(ui.endTime, sel.end);
  $("customOpt").textContent = `Personnalisée (${fmt(excerpt.length)})`;
  ui.excerptInfo.textContent =
    `Extrait : ${fmt(excerpt.start)} → ${fmt(excerpt.start + excerpt.length)} sur ${fmt(total)} · ` +
    `vidéo de ${fmt(excerpt.length / rate())}${rate() === 1 ? "" : ` à ${rate().toFixed(2)}×`}` +
    (ui.showIntro.checked ? ` · intro de ${String(INTRO_SECONDS).replace(".", ",")} s en fondu au début` : "");
  syncCursor();
  drawWave();
}

// Base name of the exported file, derived from the track.
let trackName = "orbite-8d";
// Song and artist, used for the default TikTok caption.
let trackInfo = { song: "", artist: "" };

// "Artist - Song (Official Video)" → { artist, song }; fallbackArtist is used
// when the title has no "Artist - " part (e.g. the YouTube channel name).
function describeTrack(title, fallbackArtist = "") {
  const clean = (s) => s
    .replace(/_+/g, " ")
    .replace(/\s*[([{][^)\]}]*(?<!\p{L})(official|officiel(le)?|vid[eé]o|audio|lyrics?|paroles?|letra|clip|visuali[sz]er|h[dq]|4k|remaster(ed)?|m\/?v|explicit)(?!\p{L})[^)\]}]*[)\]}]/giu, "")
    .replace(/\s*[|/]\s*(official|lyrics?|paroles|clip|vid[eé]o).*$/iu, "")
    .replace(/\s+(\+\s*)?(lyrics?|paroles)$/iu, "")
    .replace(/\s+/g, " ").trim();
  const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: clean(m[1]), song: clean(m[2]) };
  const artist = fallbackArtist.replace(/\s*-\s*Topic$/i, "").replace(/\s*VEVO$/i, "");
  return { artist: clean(artist), song: clean(title) };
}
function fileBaseName(name) {
  const base = name.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}\- ]/gu, "").trim().replace(/\s+/g, "-");
  return base.slice(0, 60) || "orbite-8d";
}

// ---------- Timecode fields (Début, Fin, Lecture) ----------
// Typed as "1:23.4" or "83.4"; Enter applies, Escape reverts, ↑/↓ nudge by 0.1 s (Shift: 1 s).
function fmtTime(s) {
  s = Math.round(Math.max(0, s) * 10) / 10;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

function parseTime(text) {
  const v = text.trim().replace(",", ".");
  if (!/^\d+(:\d+(\.\d*)?|\.\d*)?$|^\d*:\d+(\.\d*)?$/.test(v)) return NaN;
  return v.split(":").reduce((acc, part) => acc * 60 + (+part || 0), 0);
}

// Code updates never overwrite a field the user is typing in.
function showTime(input, s) {
  if (document.activeElement !== input) input.value = fmtTime(s);
}

function bindTimeField(input, get, set) {
  const apply = (t) => {
    if (buffer && Number.isFinite(t)) set(t);
    input.value = fmtTime(get());
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { apply(parseTime(input.value)); input.select(); }
    else if (e.key === "Escape") { input.value = fmtTime(get()); input.blur(); }
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      apply(get() + (e.shiftKey ? 1 : 0.1) * (e.key === "ArrowUp" ? 1 : -1));
    }
  });
  input.addEventListener("focus", () => input.select());
  input.addEventListener("blur", () => apply(parseTime(input.value)));
}

function fmt(s) {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Applies the "Durée" preset to the selection, keeping its start when possible.
function applyPreset() {
  if (!buffer || ui.duration.value === "custom") return computeExcerpt();
  const total = buffer.duration;
  if (ui.duration.value === "full") {
    sel = { start: 0, end: total };
  } else {
    const len = Math.min(+ui.duration.value, total);
    const start = Math.min(sel.start, total - len);
    sel = { start, end: start + len };
  }
  computeExcerpt();
}

// Disables the durations longer than the track; falls back to the longest one left.
function updateDurationOptions() {
  const options = [...ui.duration.options];
  for (const o of options) {
    if (!isNaN(+o.value)) o.disabled = +o.value > buffer.duration + 0.5;
  }
  const current = ui.duration.selectedOptions[0];
  if (ui.duration.value === "custom" || current.disabled) {
    const fits = options.filter((o) => !isNaN(+o.value) && !o.disabled);
    ui.duration.value = fits.length ? fits.pop().value : "full";
  }
}

function setBuffer(buf, name) {
  stopSource();
  clearExport();
  buffer = buf;
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = URL.createObjectURL(bufferToWav(buf));
  player.src = playerUrl;
  sel = { start: 0, end: 0 };
  cursor = null;
  setLyrics([], "");
  setLyricsOffset(0);
  $("lyricsText").value = "";
  showLyricsResults([]);
  updateDurationOptions();
  ui.fileName.textContent = name;
  levels = computeLevels(buf);
  applyPreset();
  $("chorusMsg").textContent = "";
  highlight = null;
  goToChorus();
  autoSel = { ...sel };
}

// ---------- Waveform (dB) ----------
// One RMS level per bucket, in dB, drawn as mirrored bars. The excerpt is
// highlighted; clicking or dragging sets its start.
const wave = $("wave");
const waveWrap = $("waveWrap");
const waveTip = $("waveTip");
const waveG = wave.getContext("2d");
const WAVE_BUCKETS = 800;
const DB_FLOOR = -60;
const HANDLE_W = 12; // CSS px
const SNAP_PX = 12; // the frame snaps onto the chorus dot within this distance
// Waveform colours come from tokens.css, so the canvas matches the interface.
// OKLCH tokens are converted to rgb() so every canvas implementation accepts them.
function cssToken(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = v.match(/^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (!m) return v;
  const L = m[1] / 100, C = +m[2], H = (m[3] * Math.PI) / 180;
  const a = C * Math.cos(H), b = C * Math.sin(H);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ];
  const srgb = lin.map((c) => {
    c = Math.min(1, Math.max(0, c));
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  });
  return `rgb(${srgb.join(", ")})`;
}
const WAVE = {
  accent: cssToken("--color-accent"),
  inside: cssToken("--color-ink-2"),
  outside: cssToken("--color-rule-2"),
  grid: cssToken("--color-rule"),
  label: cssToken("--color-muted"),
  grip: cssToken("--color-paper-0"),
  head: cssToken("--color-ink"),
};
let levels = null;

function computeLevels(buf) {
  const channels = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
  const size = Math.max(1, Math.floor(buf.length / WAVE_BUCKETS));
  const out = new Float32Array(WAVE_BUCKETS);
  for (let b = 0; b < WAVE_BUCKETS; b++) {
    let sum = 0;
    const from = b * size;
    const to = Math.min(buf.length, from + size);
    for (let i = from; i < to; i++) {
      let v = 0;
      for (const ch of channels) v += ch[i];
      v /= channels.length;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, to - from));
    out[b] = Math.max(DB_FLOOR, 20 * Math.log10(rms || 1e-9));
  }
  return out;
}

function drawWave() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(wave.clientWidth * dpr);
  const h = Math.round(wave.clientHeight * dpr);
  if (!w || !h) return;
  if (wave.width !== w || wave.height !== h) { wave.width = w; wave.height = h; }
  waveG.clearRect(0, 0, w, h);
  showMarker();
  if (!levels || !buffer) return;

  const total = buffer.duration;
  const x0 = (excerpt.start / total) * w;
  const x1 = ((excerpt.start + excerpt.length) / total) * w;
  waveG.globalAlpha = 0.1;
  waveG.fillStyle = WAVE.accent;
  waveG.fillRect(x0, 0, x1 - x0, h);
  waveG.globalAlpha = 1;

  // dB grid
  waveG.font = `${10 * dpr}px "Geist Mono", ui-monospace, monospace`;
  waveG.textBaseline = "middle";
  for (const db of [-6, -18, -36]) {
    const r = 1 - db / DB_FLOOR;
    for (const y of [h / 2 - (r * h) / 2, h / 2 + (r * h) / 2]) {
      waveG.fillStyle = WAVE.grid;
      waveG.fillRect(0, Math.round(y), w, dpr);
    }
    waveG.fillStyle = WAVE.label;
    waveG.fillText(`${db} dB`, 4 * dpr, h / 2 - (r * h) / 2 + 6 * dpr);
  }

  const barW = w / levels.length;
  for (let i = 0; i < levels.length; i++) {
    const x = i * barW;
    const r = 1 - levels[i] / DB_FLOOR;
    const bh = Math.max(dpr, r * (h - 4 * dpr));
    waveG.fillStyle = x + barW >= x0 && x <= x1 ? WAVE.inside : WAVE.outside;
    waveG.fillRect(x, (h - bh) / 2, Math.max(dpr, barW - dpr * 0.5), bh);
  }

  // iPhone-style trim frame: two handles joined by top and bottom borders.
  const hw = HANDLE_W * dpr;
  const border = 3 * dpr;
  const left = Math.max(0, Math.min(x0, w - 2 * hw));
  const right = Math.min(w, Math.max(x1, left + 2 * hw));
  waveG.fillStyle = WAVE.accent;
  waveG.fillRect(left, 0, right - left, border);
  waveG.fillRect(left, h - border, right - left, border);
  for (const x of [left, right - hw]) {
    waveG.beginPath();
    if (waveG.roundRect) waveG.roundRect(x, 0, hw, h, 4 * dpr);
    else waveG.rect(x, 0, hw, h);
    waveG.fill();
    waveG.fillStyle = WAVE.grip;
    waveG.fillRect(x + hw / 2 - dpr, h / 2 - 8 * dpr, 2 * dpr, 16 * dpr);
    waveG.fillStyle = WAVE.accent;
  }

  if (playing || cursor !== null) {
    const t = playing ? playPosition() : cursor;
    waveG.globalAlpha = playing ? 1 : 0.6;
    waveG.fillStyle = WAVE.head;
    waveG.fillRect(Math.round((t / total) * w), 0, 2 * dpr, h);
    waveG.globalAlpha = 1;
  }
}

// ---------- Playback cursor ----------
// Shows where the excerpt is playing; dragging it seeks (or sets where
// "Écouter" resumes when stopped).
let posDragging = false;
function syncCursor() {
  if (!buffer) return;
  const end = excerpt.start + excerpt.length;
  if (cursor !== null && (cursor < excerpt.start || cursor >= end)) cursor = null;
  const t = playing && ctx.currentTime >= playStartCtx ? player.currentTime : cursor ?? excerpt.start;
  ui.pos.min = excerpt.start.toFixed(2);
  ui.pos.max = end.toFixed(2);
  if (!posDragging) ui.pos.value = t;
  showTime(ui.posTime, t);
}

function seekTo(t) {
  t = Math.min(Math.max(t, excerpt.start), excerpt.start + excerpt.length - 0.05);
  if (playing && ctx.currentTime >= playStartCtx) player.currentTime = t;
  else cursor = t;
  syncCursor();
  drawWave();
}

ui.pos.addEventListener("input", () => {
  posDragging = true;
  seekTo(+ui.pos.value);
});
ui.pos.addEventListener("change", () => { posDragging = false; });

function waveLoop() {
  drawWave();
  syncCursor();
  if (playing) requestAnimationFrame(waveLoop);
}

function waveTime(e) {
  const rect = wave.getBoundingClientRect();
  const r = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  return { r, t: r * buffer.duration };
}

// Which part of the trim frame a pointer is on: "start"/"end" handle, "move" inside.
function waveHit(e) {
  const rect = wave.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const x0 = (sel.start / buffer.duration) * rect.width;
  const x1 = (sel.end / buffer.duration) * rect.width;
  const grab = HANDLE_W + 6;
  const dStart = Math.abs(x - (x0 + HANDLE_W / 2));
  const dEnd = Math.abs(x - (x1 - HANDLE_W / 2));
  if (Math.min(dStart, dEnd) <= grab) return dStart <= dEnd ? "start" : "end";
  return x > x0 && x < x1 ? "move" : null;
}

let waveDrag = null; // { mode, offset }
function dragWave(e) {
  const { t } = waveTime(e);
  const total = buffer.duration;
  if (waveDrag.mode === "start") {
    sel.start = Math.max(0, Math.min(t, sel.end - minExcerpt()));
    ui.duration.value = "custom";
  } else if (waveDrag.mode === "end") {
    sel.end = Math.min(total, Math.max(t, sel.start + minExcerpt()));
    ui.duration.value = "custom";
  } else {
    const len = sel.end - sel.start;
    sel.start = Math.max(0, Math.min(t - waveDrag.offset, total - len));
    const snap = snapStart(len);
    const pxPerSec = wave.getBoundingClientRect().width / total;
    if (snap !== null && Math.abs(sel.start - snap) * pxPerSec <= SNAP_PX) sel.start = snap;
    sel.end = sel.start + len;
  }
  computeExcerpt();
}

// Where the excerpt starts when placed on the chorus dot (a little before it).
function snapStart(len) {
  if (highlight === null) return null;
  return Math.max(0, Math.min(highlight - CHORUS_PREROLL, buffer.duration - len));
}

// Red dot under the waveform on the chorus, like Instagram's music picker.
const waveDot = $("waveDot");
function showMarker() {
  waveDot.hidden = highlight === null || !buffer;
  if (waveDot.hidden) return;
  waveDot.style.left = `${(highlight / buffer.duration) * 100}%`;
  waveDot.title = `Refrain à ${fmt(highlight)} : clique pour y placer l'extrait`;
}
// Clicking the dot places the excerpt on the chorus and plays it.
waveDot.addEventListener("click", () => {
  if (!buffer || highlight === null || waveWrap.classList.contains("disabled")) return;
  const len = sel.end - sel.start;
  sel.start = snapStart(len);
  sel.end = sel.start + len;
  computeExcerpt();
  cursor = null;
  if (playing) player.currentTime = excerpt.start;
  else startSource();
});

wave.addEventListener("pointerdown", (e) => {
  if (!buffer || waveWrap.classList.contains("disabled")) return;
  const { t } = waveTime(e);
  const hit = waveHit(e);
  // Tapping outside the frame moves the whole selection to start there.
  waveDrag = { mode: hit || "move", offset: hit === "move" ? t - sel.start : 0, from: sel.start };
  wave.setPointerCapture(e.pointerId);
  dragWave(e);
});
wave.addEventListener("pointermove", (e) => {
  if (!buffer) return;
  const { r, t } = waveTime(e);
  const db = levels[Math.min(levels.length - 1, Math.floor(r * levels.length))];
  waveTip.hidden = false;
  waveTip.style.left = `${Math.min(88, Math.max(12, r * 100))}%`;
  waveTip.textContent = `${fmt(t)} · ${db <= DB_FLOOR ? "silence" : `${db.toFixed(0)} dB`}`;
  if (waveDrag) return dragWave(e);
  const hit = waveHit(e);
  wave.style.cursor = hit === "start" || hit === "end" ? "ew-resize" : hit === "move" ? "grab" : "pointer";
});
wave.addEventListener("pointerleave", () => { waveTip.hidden = true; });
// Like Instagram: once the frame is dropped somewhere new, the excerpt plays from its start.
wave.addEventListener("pointerup", () => {
  if (!waveDrag) return;
  const moved = waveDrag.mode === "move" && waveDrag.from !== sel.start;
  waveDrag = null;
  if (!moved) return relaunchIfPlaying();
  cursor = null;
  if (playing) player.currentTime = excerpt.start;
  else startSource();
});
window.addEventListener("resize", drawWave);

// ---------- Demo track (synthesised, no external file) ----------
async function makeDemo() {
  const sr = 44100, dur = 32;
  const off = new OfflineAudioContext(2, sr * dur, sr);
  const out = new GainNode(off, { gain: 0.5 });
  out.connect(off.destination);
  const bpm = 96, beat = 60 / bpm;
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  for (let bar = 0; bar * beat * 4 < dur; bar++) {
    const t0 = bar * beat * 4;
    const ch = chords[bar % 4];
    // pad
    const lp = new BiquadFilterNode(off, { type: "lowpass", frequency: 1400 });
    const pg = new GainNode(off, { gain: 0 });
    lp.connect(pg).connect(out);
    pg.gain.linearRampToValueAtTime(0.18, t0 + 0.4);
    pg.gain.setValueAtTime(0.18, t0 + beat * 4 - 0.2);
    pg.gain.linearRampToValueAtTime(0, t0 + beat * 4);
    ch.forEach((m, i) => {
      [-6, 6].forEach((det) => {
        const o = new OscillatorNode(off, { type: "sawtooth", frequency: hz(m), detune: det });
        o.connect(lp); o.start(t0); o.stop(t0 + beat * 4);
      });
    });
    // arpeggio
    for (let s = 0; s < 8; s++) {
      const ts = t0 + s * beat / 2;
      const o = new OscillatorNode(off, { type: "triangle", frequency: hz(ch[s % 3] + 12 + (s >= 4 ? 12 : 0)) });
      const ag = new GainNode(off, { gain: 0 });
      o.connect(ag).connect(out);
      ag.gain.setValueAtTime(0, ts);
      ag.gain.linearRampToValueAtTime(0.22, ts + 0.01);
      ag.gain.exponentialRampToValueAtTime(0.001, ts + beat / 2);
      o.start(ts); o.stop(ts + beat / 2);
    }
    // bass
    const b = new OscillatorNode(off, { type: "sine", frequency: hz(ch[0] - 24) });
    const bg = new GainNode(off, { gain: 0.5 });
    b.connect(bg).connect(out); b.start(t0); b.stop(t0 + beat * 4);
    // kick + hat
    for (let k = 0; k < 4; k++) {
      const tk = t0 + k * beat;
      const ko = new OscillatorNode(off, { type: "sine", frequency: 140 });
      const kg = new GainNode(off, { gain: 0 });
      ko.connect(kg).connect(out);
      ko.frequency.exponentialRampToValueAtTime(40, tk + 0.15);
      kg.gain.setValueAtTime(1, tk);
      kg.gain.exponentialRampToValueAtTime(0.001, tk + 0.35);
      ko.start(tk); ko.stop(tk + 0.4);

      const th = tk + beat / 2;
      const nb = off.createBuffer(1, sr * 0.05, sr);
      const nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * (1 - i / nd.length);
      const ns = new AudioBufferSourceNode(off, { buffer: nb });
      const hp = new BiquadFilterNode(off, { type: "highpass", frequency: 7000 });
      const hg = new GainNode(off, { gain: 0.12 });
      ns.connect(hp).connect(hg).connect(out); ns.start(th);
    }
  }
  return off.startRendering();
}

// ---------- Scenes (vertical 1080×1920 city videos, muted) ----------
// Every clip plays once in a shuffled order, then the list is reshuffled;
// two clips of the same place never follow each other.
const scenes = [
  { id: "dubai-downtown", name: "Dubai Downtown" },
  { id: "dubai-lumieres", name: "Dubai lumières" },
  { id: "bahrein", name: "Bahreïn" },
  { id: "bangkok", name: "Bangkok" },
  { id: "shanghai", name: "Shanghai" },
  { id: "chine", name: "Chine" },
  { id: "islamabad", name: "Islamabad" },
  { id: "londres", name: "Londres" },
  { id: "paris", name: "Paris" },
  { id: "new-york", name: "New York" },
  { id: "avion", name: "Vue d'avion" },
  { id: "miami", name: "Miami en voiture" },
  { id: "londres-knightsbridge", name: "Londres en voiture" },
  // Cinematic FPV drone clips, cut from horizontal 4K videos (skipping the first 10 s) and cropped to 9:16.
  { id: "madere-1", name: "Madère 1" },
  { id: "madere-2", name: "Madère 2" },
  { id: "madere-3", name: "Madère 3" },
  { id: "le-puy-1", name: "Le Puy-en-Velay 1" },
  { id: "le-puy-2", name: "Le Puy-en-Velay 2" },
  { id: "le-puy-3", name: "Le Puy-en-Velay 3" },
  { id: "le-puy-4", name: "Le Puy-en-Velay 4" },
  { id: "venise-1", name: "Venise 1" },
  { id: "venise-2", name: "Venise 2" },
  { id: "venise-3", name: "Venise 3" },
  { id: "venise-4", name: "Venise 4" },
  { id: "istanbul-1", name: "Istanbul 1" },
  { id: "istanbul-2", name: "Istanbul 2" },
  { id: "istanbul-3", name: "Istanbul 3" },
  { id: "alpes-1", name: "Alpes 1" },
  { id: "alpes-2", name: "Alpes 2" },
  { id: "alpes-3", name: "Alpes 3" },
  { id: "alpes-4", name: "Alpes 4" },
];
const CROSSFADE_MS = 400;

let current = null; // scene on screen
let fading = null; // { video, start } of the clip fading out
let queue = [];

// Safari only keeps decoding frames of videos that are in the document.
const videoHolder = document.createElement("div");
videoHolder.style.cssText = "position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none";
document.body.appendChild(videoHolder);

function sceneVideo(s) {
  if (!s.video) {
    const v = document.createElement("video");
    v.src = `assets/videos/${s.id}.mp4`;
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.addEventListener("ended", () => {
      if (current === s) showScene(nextRandomScene());
    });
    videoHolder.appendChild(v);
    s.video = v;
  }
  return s.video;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Place of a clip ("venise-2" → "venise", "londres-knightsbridge" → "londres").
const place = (s) => s.id.split("-")[0];

// Shuffled scenes where two clips of the same place never follow each other,
// starting with a different place than `last` (the clip on screen before).
function shuffleScenes(last) {
  for (;;) {
    const pool = shuffle(scenes);
    const order = [];
    let prev = last;
    while (pool.length) {
      const i = pool.findIndex((s) => !prev || place(s) !== place(prev));
      if (i < 0) break; // only one place left at the end: draw again
      prev = pool.splice(i, 1)[0];
      order.push(prev);
    }
    if (!pool.length) return order;
  }
}

function nextRandomScene() {
  if (!queue.length) queue = shuffleScenes(current);
  const next = queue.shift();
  sceneVideo(queue[0] || next); // start buffering the one after
  return next;
}

function showScene(s, { crossfade = true } = {}) {
  const v = sceneVideo(s);
  if (fading) fading.video.pause();
  fading = crossfade && current && current !== s ? { video: current.video, start: performance.now() } : null;
  if (!fading && current && current !== s) current.video.pause();
  current = s;
  v.currentTime = 0;
  v.play().catch(() => {});
}

// Called when playback/export starts: a fresh random order for each video.
function restartScenes() {
  queue = [];
  showScene(nextRandomScene(), { crossfade: false });
}

function drawVideo(v, bass, alpha) {
  if (v instanceof HTMLVideoElement && v.readyState < 2) return;
  // Videos are exactly 1080×1920: at rest they are drawn 1:1 (sharpest); only the bass pump zooms.
  const zoom = 1 + bass * 0.03;
  const w = W * zoom, h = H * zoom;
  g.imageSmoothingQuality = "high";
  g.globalAlpha = alpha;
  g.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
  g.globalAlpha = 1;
}

// Live background: the current clip, and the previous one fading out on top.
function drawScene(bass) {
  let k = 0;
  if (fading) {
    k = 1 - (performance.now() - fading.start) / CROSSFADE_MS;
    if (k <= 0) { fading.video.pause(); fading = null; }
  }
  drawBackground(sceneVideo(current), fading && fading.video, k, bass);
}

// Video full-frame with a slight bass "pump", darkened a little for the overlay.
// src/prev are <video> elements live, VideoFrames in the fast export.
function drawBackground(src, prev, prevAlpha, bass) {
  g.fillStyle = "#000";
  g.fillRect(0, 0, W, H);
  if (src) drawVideo(src, bass, 1);
  if (prev && prevAlpha > 0) drawVideo(prev, bass, prevAlpha);
  const shade = g.createLinearGradient(0, 0, 0, H);
  shade.addColorStop(0, "rgba(0,0,0,0.25)");
  shade.addColorStop(0.5, "rgba(0,0,0,0.05)");
  shade.addColorStop(1, "rgba(0,0,0,0.35)");
  g.fillStyle = shade;
  g.fillRect(0, 0, W, H);
}

showScene(nextRandomScene());

// ---------- Overlay ----------
function roundRect(x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Headphones icon with "8dsongslive" written around it; the ring turns with the sound.
const LOGO_TEXT = "8dsongslive • 8dsongslive • ";
const LOGO_SCALE = 0.55;
function drawLogo(x, y) {
  const R = 92;
  const cx = 0, cy = 0;
  g.save();
  g.translate(x, y);
  g.scale(LOGO_SCALE, LOGO_SCALE);
  g.fillStyle = "rgba(0,0,0,0.35)";
  g.beginPath(); g.arc(cx, cy, R + 22, 0, Math.PI * 2); g.fill();
  g.strokeStyle = "rgba(255,255,255,0.85)"; g.lineWidth = 3;
  g.beginPath(); g.arc(cx, cy, R + 22, 0, Math.PI * 2); g.stroke();

  // headphones
  g.strokeStyle = "#fff"; g.fillStyle = "#fff";
  g.lineWidth = 9; g.lineCap = "round";
  g.beginPath(); g.arc(cx, cy + 2, 38, Math.PI * 1.08, Math.PI * 1.92); g.stroke();
  for (const side of [-1, 1]) {
    roundRect(cx + side * 38 - 13, cy - 4, 26, 44, 11); g.fill();
  }
  g.fillStyle = "#3de0d0";
  for (const side of [-1, 1]) {
    roundRect(cx + side * 38 - 5, cy + 4, 10, 28, 5); g.fill();
  }

  // text on a circle, letters spread evenly over the full turn
  g.font = "800 26px Outfit, system-ui, sans-serif";
  g.fillStyle = "#fff";
  g.textAlign = "center"; g.textBaseline = "middle";
  const chars = [...LOGO_TEXT];
  const widths = chars.map((c) => g.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0);
  let a = angle * 0.5;
  chars.forEach((c, i) => {
    const step = (widths[i] / total) * Math.PI * 2;
    a += step / 2;
    g.save();
    g.translate(cx + R * Math.sin(a), cy - R * Math.cos(a));
    g.rotate(a);
    g.fillText(c, 0, 0);
    g.restore();
    a += step / 2;
  });
  g.restore();
}

// AirPods Pro line icon (SVG Repo), recoloured white for the dark intro.
const airpodsImg = new Image();
airpodsImg.src = "assets/airpods.svg";

// Intro card: dark screen with AirPods and "Put on your headphones", fading into the video.
function drawIntro(elapsed, length) {
  const fadeOut = Math.min(1, (length - elapsed) / 0.35);
  const fadeIn = Math.min(1, elapsed / 0.3);
  g.save();
  g.globalAlpha = fadeOut;
  g.fillStyle = "#07070f";
  g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W / 2, 820, 0, W / 2, 820, 520);
  glow.addColorStop(0, "rgba(139,123,255,0.35)");
  glow.addColorStop(1, "rgba(139,123,255,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);

  g.globalAlpha = fadeOut * fadeIn;
  if (airpodsImg.complete && airpodsImg.naturalWidth) {
    const size = 720 * (1 + elapsed * 0.04);
    const float = Math.sin(elapsed * 4) * 10;
    g.save();
    g.shadowColor = "rgba(139,123,255,0.8)"; g.shadowBlur = 40;
    g.drawImage(airpodsImg, (W - size) / 2, 720 - size / 2 + float, size, size);
    g.restore();
  }

  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillStyle = "#fff";
  g.font = "800 92px Outfit, system-ui, sans-serif";
  g.fillText("PUT ON YOUR", W / 2, 1120);
  g.fillText("HEADPHONES", W / 2, 1225);
  g.fillStyle = "#3de0d0";
  g.font = "600 44px Outfit, system-ui, sans-serif";
  g.fillText("for the full 8D experience", W / 2, 1320);
  g.restore();
}

// ---------- Lyrics ----------
// Synced lyrics (LRC) from lrclib.net, shown one line at a time in the middle
// of the video with a fade in/out. Times are track times, so the excerpt and
// the speed are followed automatically.
const LYRIC_FADE_IN = 0.3;
const LYRIC_FADE_OUT = 0.35;
const LYRIC_MAX_HOLD = 8; // a line fades out after this, even if the next one is far
let lyrics = []; // [{ t, text }] sorted by time
let lyricsRequest = 0;

function lyricsMessage(text) {
  $("lyricsMsg").textContent = text;
}

function setLyrics(lines, message) {
  lyrics = lines;
  if (message) lyricsMessage(message);
  fillLyricsLines();
  // Lyrics arrived after the track: refine the chorus if the user hasn't moved the excerpt.
  if (lines.length && autoSel && sel.start === autoSel.start && sel.end === autoSel.end) goToChorus({ lyricsOnly: true });
}

// Reference lines for "C'est maintenant" (non-empty lines, with their time).
function fillLyricsLines() {
  ui.lyricsLine.innerHTML = "";
  lyrics.forEach((l, i) => {
    if (!l.text) return;
    const o = document.createElement("option");
    o.value = i;
    o.textContent = `${fmt(l.t)} — ${l.text}`;
    ui.lyricsLine.appendChild(o);
  });
  ui.lyricsLine.disabled = !ui.lyricsLine.options.length;
  $("lyricsAuto").disabled = !ui.lyricsLine.options.length || !buffer;
  markSynced(false);
  updateLyricsNow();
}

function updateLyricsNow() {
  ui.lyricsNow.disabled = !ui.lyricsLine.options.length || !playing;
}

// "[01:23.45] text" lines → [{ t, text }]; several stamps per line are allowed.
function parseLrc(lrc) {
  const out = [];
  for (const line of lrc.split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) out.push({ t: +m[1] * 60 + parseFloat(m[2].replace(":", ".")), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Results of the last search; the list lets the user switch to another version.
let lyricsResults = [];

function showLyricsResults(results) {
  lyricsResults = results;
  const list = $("lyricsResults");
  list.innerHTML = "";
  results.forEach((r, i) => {
    const o = document.createElement("option");
    o.value = i;
    o.textContent = `${r.trackName} – ${r.artistName} (${fmt(r.duration)})`;
    list.appendChild(o);
  });
  list.hidden = results.length < 2;
}

function useLyricsResult(r) {
  const lines = parseLrc(r.syncedLyrics);
  setLyrics(lines, `Paroles : ${r.trackName} – ${r.artistName} (${lines.length} lignes). Si elles sont décalées, ajuste le décalage.`);
  $("lyricsText").value = r.syncedLyrics;
}

// Searches lrclib.net and applies the result closest in duration to the loaded
// track (most likely the same version). Automatic on load, or typed by the user.
async function searchLyrics(params, label) {
  const id = ++lyricsRequest;
  lyricsMessage(`Recherche des paroles de « ${label} »…`);
  try {
    const res = await fetch(`https://lrclib.net/api/search?${new URLSearchParams(params)}`);
    const results = (await res.json()).filter((r) => r.syncedLyrics && parseLrc(r.syncedLyrics).length > 3);
    if (id !== lyricsRequest) return; // a newer search or track took over
    if (buffer) results.sort((a, b) => Math.abs(a.duration - buffer.duration) - Math.abs(b.duration - buffer.duration));
    showLyricsResults(results);
    if (!results.length) return setLyrics([], `Aucune parole synchronisée trouvée pour « ${label} ». Essaie une autre recherche ou colle des paroles ci-dessous.`);
    useLyricsResult(results[0]);
  } catch (_) {
    if (id === lyricsRequest) setLyrics([], "Impossible de joindre lrclib.net. Tu peux coller des paroles ci-dessous.");
  }
}

function findLyrics() {
  const { song, artist } = trackInfo;
  $("lyricsQuery").value = [song, artist].filter(Boolean).join(" ");
  if (!song) return setLyrics([], "Pas de titre de morceau : cherche les paroles ci-dessus ou colle des paroles LRC ci-dessous.");
  searchLyrics(artist ? { track_name: song, artist_name: artist } : { q: song }, song);
}

$("lyricsSearch").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("lyricsQuery").value.trim();
  if (q) searchLyrics({ q }, q);
});

$("lyricsResults").addEventListener("change", (e) => {
  const r = lyricsResults[+e.target.value];
  if (r) useLyricsResult(r);
});

// Offset in seconds added to the playback time: positive = lyrics come earlier.
const LYRICS_OFFSET_MAX = 60;
// auto: the offset comes from a successful Sync auto (button turns green);
// any other change (manual, new lyrics, new track) clears that state.
function setLyricsOffset(v, { auto = false } = {}) {
  markSynced(auto);
  v = Math.round(Math.max(-LYRICS_OFFSET_MAX, Math.min(LYRICS_OFFSET_MAX, v)) * 10) / 10;
  ui.lyricsOffset.value = v;
  if (document.activeElement !== ui.lyricsOffsetText) ui.lyricsOffsetText.value = `${v > 0 ? "+" : ""}${v.toFixed(1)} s`;
}
ui.lyricsOffset.addEventListener("input", () => setLyricsOffset(+ui.lyricsOffset.value));
ui.lyricsOffset.addEventListener("dblclick", () => setLyricsOffset(0));

// ---------- Sync auto ----------
// Finds the global offset that best lines up the LRC lines with the voice.
// Voice ≈ energy in the 300 Hz–3 kHz band that sits in the centre of the mix
// (mid minus side), 10 frames per second. Each LRC line is "sung" from its
// time to the next line (6 s max); every shift within ±60 s is scored by how
// much louder the voice is inside those spans than outside, then refined within
// ±1 s on the voice attacks at line starts. If the best shift is weak or not
// clearly ahead of another one, the LRC times are kept.
const SYNC_RATE = 10;
const SYNC_MIN_SCORE = 0.35; // voice inside vs outside the lines, in standard deviations
const SYNC_MIN_LEAD = 0.1; // the best shift must beat any other (> 2 s away) by 10 %
const vocalEnvelopes = new WeakMap();

function vocalEnvelope(buf) {
  if (vocalEnvelopes.has(buf)) return vocalEnvelopes.get(buf);
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const hop = Math.round(buf.sampleRate / SYNC_RATE);
  const n = Math.floor(L.length / hop);
  const aHp = Math.exp((-2 * Math.PI * 300) / buf.sampleRate);
  const aLp = 1 - Math.exp((-2 * Math.PI * 3000) / buf.sampleRate);
  let mh = 0, mx = 0, ml = 0, sh = 0, sx = 0, sl = 0;
  const raw = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let em = 0, es = 0;
    for (let i = f * hop, end = i + hop; i < end; i++) {
      const m = (L[i] + R[i]) * 0.5, s = (L[i] - R[i]) * 0.5;
      mh = aHp * (mh + m - mx); mx = m; ml += aLp * (mh - ml); em += ml * ml;
      sh = aHp * (sh + s - sx); sx = s; sl += aLp * (sh - sl); es += sl * sl;
    }
    raw[f] = Math.log10(1e-9 + Math.max(0, em - es) / hop);
  }
  const env = raw.map((_, f) => (raw[Math.max(0, f - 1)] + raw[f] + raw[Math.min(n - 1, f + 1)]) / 3);
  vocalEnvelopes.set(buf, env);
  return env;
}

// Returns the offset for the "Décalage" field, or null if unsure.
function estimateLyricsOffset(env, lines) {
  const n = env.length;
  const prefix = new Float64Array(n + 1);
  let sum = 0, sq = 0;
  env.forEach((v, i) => { prefix[i + 1] = prefix[i] + v; sum += v; sq += v * v; });
  const std = Math.sqrt(Math.max(1e-12, sq / n - (sum / n) ** 2));
  const spans = [];
  lines.forEach((l, i) => {
    if (!l.text) return;
    const end = Math.min(lines[i + 1] ? lines[i + 1].t : l.t + 6, l.t + 6);
    if (end > l.t) spans.push([Math.round(l.t * SYNC_RATE), Math.round(end * SYNC_RATE)]);
  });
  const total = spans.reduce((a, [s, e]) => a + e - s, 0);
  if (spans.length < 4 || !total) return null;

  const max = LYRICS_OFFSET_MAX * SYNC_RATE;
  const scores = new Float64Array(2 * max + 1).fill(-Infinity);
  for (let d = -max; d <= max; d++) {
    let inSum = 0, inCount = 0;
    for (const [s, e] of spans) {
      const a = Math.max(0, s + d), b = Math.min(n, e + d);
      if (b > a) { inSum += prefix[b] - prefix[a]; inCount += b - a; }
    }
    if (inCount < total * 0.6 || inCount >= n) continue; // lines pushed out of the track
    scores[d + max] = (inSum / inCount - (sum - inSum) / (n - inCount)) / std;
  }
  let best = 0;
  scores.forEach((s, i) => { if (s > scores[best]) best = i; });
  let rival = -Infinity;
  scores.forEach((s, i) => { if (Math.abs(i - best) > 2 * SYNC_RATE) rival = Math.max(rival, s); });
  const top = scores[best];
  if (!(top >= SYNC_MIN_SCORE) || top - rival < top * SYNC_MIN_LEAD) return null;

  const rise = (f) => (f > 0 && f < n ? Math.max(0, env[f] - env[f - 1]) : 0);
  let fine = best - max, fineScore = -1;
  for (let d = best - max - SYNC_RATE; d <= best - max + SYNC_RATE; d++) {
    let s = 0;
    for (const [start] of spans) s += rise(start + d) + rise(start + d + 1);
    if (s > fineScore) { fineScore = s; fine = d; }
  }
  // Lines at t + d match the voice; the offset is added to the playback time.
  return -fine / SYNC_RATE || 0;
}

function markSynced(on) {
  const btn = $("lyricsAuto");
  btn.classList.toggle("is-synced", on);
  btn.textContent = on ? "✓ Synchronisé" : "Sync auto";
}

$("lyricsAuto").addEventListener("click", () => {
  if (!buffer || !lyrics.length) return;
  const offset = estimateLyricsOffset(vocalEnvelope(buffer), lyrics);
  if (offset === null) {
    setLyricsOffset(0);
    lyricsMessage("Sync auto : pas assez sûr sur ce morceau, je garde les temps du LRC. Ajuste à la main si besoin.");
  } else {
    setLyricsOffset(offset, { auto: true });
    lyricsMessage(offset ? `Sync auto : paroles décalées de ${ui.lyricsOffsetText.value}.` : "Sync auto : les temps du LRC étaient déjà bons.");
  }
});

// ---------- Refrain ----------
// Places the excerpt on the chorus, like Instagram's "best moment".
// 1. Lyrics (when synced lyrics are loaded): the chorus is the lines that come
//    back; the excerpt starts where a block of repeated lines begins and is
//    filled with as many repeated lines as possible.
// 2. Audio otherwise: every 0.5 s, which notes sound (chroma) and how loud it
//    is. A passage scores high when it comes back elsewhere in the track and
//    is loud; the start is then nudged onto the nearest rise in energy.
// If neither is confident, the excerpt stays at the start of the track.
const CHORUS_RATE = 2; // analysis frames per second
const CHORUS_PREROLL = 0.5; // start a little before, not to clip the attack
const chorusFeatures = new WeakMap();
let autoSel = null; // selection placed automatically; lyrics may refine it while untouched

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

// Per 0.5 s frame: a zero-mean, unit-length 12-note chroma, and the level in dB.
function audioFeatures(buf) {
  if (chorusFeatures.has(buf)) return chorusFeatures.get(buf);
  const L = buf.getChannelData(0);
  const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const down = Math.max(1, Math.round(buf.sampleRate / 11025));
  const rate = buf.sampleRate / down;
  const mono = new Float32Array(Math.floor(L.length / down));
  for (let i = 0; i < mono.length; i++) {
    let s = 0;
    for (let k = i * down; k < (i + 1) * down; k++) s += L[k] + R[k];
    mono[i] = s / (2 * down);
  }
  const N = 2048, sub = 2; // two FFTs per frame
  const hop = Math.round(rate / CHORUS_RATE);
  const n = Math.floor(mono.length / hop);
  const pcOfBin = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * rate) / N;
    if (f >= 80 && f <= 4000) pcOfBin[k] = (((Math.round(12 * Math.log2(f / 440)) + 69) % 12) + 12) % 12;
  }
  const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const chroma = new Float32Array(n * 12);
  const energy = new Float32Array(n);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f < n; f++) {
    let sq = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) sq += mono[i] * mono[i];
    energy[f] = 10 * Math.log10(1e-10 + sq / hop);
    const c = chroma.subarray(f * 12, f * 12 + 12);
    for (let s = 0; s < sub; s++) {
      const at = f * hop + Math.floor((s * hop) / sub);
      for (let i = 0; i < N; i++) { re[i] = (mono[at + i] || 0) * hann[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 1; k < N / 2; k++) if (pcOfBin[k] >= 0) c[pcOfBin[k]] += Math.hypot(re[k], im[k]);
    }
    let mean = 0;
    for (let p = 0; p < 12; p++) mean += c[p] / 12;
    let norm = 0;
    for (let p = 0; p < 12; p++) { c[p] -= mean; norm += c[p] * c[p]; }
    norm = Math.sqrt(norm) || 1;
    for (let p = 0; p < 12; p++) c[p] /= norm;
  }
  const features = { chroma, energy, n };
  chorusFeatures.set(buf, features);
  return features;
}

// Values spread over [0, 1] between the 5th and 95th percentiles.
function spread(values) {
  const sorted = Float32Array.from(values).sort();
  const lo = sorted[Math.floor(sorted.length * 0.05)], hi = sorted[Math.floor(sorted.length * 0.95)];
  return values.map((v) => Math.min(1, Math.max(0, (v - lo) / (hi - lo || 1))));
}

// Start (track seconds) of the chorus, or null if unsure. The search window is
// the core of a chorus (12 s at most), whatever the excerpt length: the excerpt
// then starts there.
function chorusFromAudio(buf, len) {
  const { chroma, energy, n } = audioFeatures(buf);
  const w = Math.round(Math.min(len, 12) * CHORUS_RATE);
  const last = n - Math.round(len * CHORUS_RATE); // latest start that still fits the whole excerpt
  if (last < 0 || n < w + 16) return null;
  const sim = (i, j) => {
    let d = 0;
    for (let p = 0; p < 12; p++) d += chroma[i * 12 + p] * chroma[j * 12 + p];
    return d;
  };
  // Repetition: best average similarity over 4 s with the same passage elsewhere (≥ 8 s away).
  const span = 4 * CHORUS_RATE, minLag = 8 * CHORUS_RATE;
  const rep = new Float32Array(n).fill(-1);
  const prefix = new Float64Array(n + 1);
  for (let lag = minLag; lag < n - span; lag++) {
    for (let j = 0; j < n - lag; j++) prefix[j + 1] = prefix[j] + sim(j, j + lag);
    for (let j = 0; j + span <= n - lag; j++) {
      const v = (prefix[j + span] - prefix[j]) / span;
      for (const f of [j, j + lag]) if (v > rep[f]) rep[f] = v;
    }
  }
  const r = spread(rep), e = spread(energy);
  const frame = Float32Array.from(r, (v, i) => 0.5 * v + 0.5 * e[i]);
  const acc = new Float64Array(n + 1);
  frame.forEach((v, i) => { acc[i + 1] = acc[i] + v; });
  const windowScore = (s) => (acc[s + w] - acc[s]) / w;
  const scores = [];
  let best = 0;
  for (let s = 0; s <= last; s++) {
    scores.push(windowScore(s));
    if (scores[s] > scores[best]) best = s;
  }
  const median = [...scores].sort((a, b) => a - b)[Math.floor(scores.length / 2)];
  if (scores[best] - median < 0.1) return null;
  // Nudge onto the nearest entrance: the frame within ±4 s where the level jumps most.
  const mean = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += e[i]; return s / (b - a); };
  let start = best, top = -Infinity;
  for (let s = Math.max(4, best - 8); s <= Math.min(last, best + 8); s++) {
    const v = windowScore(s) + 0.5 * (mean(s, s + 4) - mean(s - 4, s));
    if (v > top) { top = v; start = s; }
  }
  return start / CHORUS_RATE;
}

// Start (track seconds) of the chorus from synced lyrics, or null.
function chorusFromLyrics(lines, len, offset, total) {
  const norm = (t) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
  const sung = lines.filter((l) => l.text).map((l) => ({ t: l.t - offset, key: norm(l.text) }));
  const count = new Map();
  for (const l of sung) if (l.key.split(" ").length >= 2) count.set(l.key, (count.get(l.key) || 0) + 1);
  const repeated = sung.map((l) => (count.get(l.key) || 0) >= 2);
  if (new Set(sung.filter((_, i) => repeated[i]).map((l) => l.key)).size < 2) return null;
  let best = null, bestScore = 0;
  sung.forEach((l, i) => {
    if (!repeated[i] || (i > 0 && repeated[i - 1] && l.t - sung[i - 1].t < 8)) return; // block starts only
    if (l.t - CHORUS_PREROLL + len > total) return; // the whole excerpt must fit after it
    let score = 0;
    for (let k = i; k < sung.length && sung[k].t < l.t + len; k++) if (repeated[k]) score++;
    if (score > bestScore) { bestScore = score; best = l.t; }
  });
  return bestScore >= 3 ? best : null;
}

// Moves the excerpt (current length) onto the chorus. Returns true if found.
function goToChorus({ lyricsOnly = false } = {}) {
  if (!buffer || ui.duration.value === "full") return false;
  const total = buffer.duration;
  const len = Math.min(sel.end - sel.start || +ui.duration.value || 30, total);
  let t = lyrics.length ? chorusFromLyrics(lyrics, len, +ui.lyricsOffset.value, total) : null;
  let source = "paroles";
  if (t === null && !lyricsOnly) { t = chorusFromAudio(buffer, len); source = "son"; }
  const msg = $("chorusMsg");
  if (t === null) {
    if (!lyricsOnly) {
      msg.textContent = "Refrain pas trouvé avec assez de certitude : extrait laissé au début.";
      highlight = null;
      drawWave();
    }
    return false;
  }
  highlight = Math.min(Math.max(0, t), total);
  const start = snapStart(len);
  sel = { start, end: start + len };
  computeExcerpt();
  relaunchIfPlaying();
  autoSel = { ...sel };
  msg.textContent = `Refrain à ${fmt(start)} (d'après le ${source}).`;
  return true;
}
$("chorusBtn").addEventListener("click", () => goToChorus());

// Typed as "+2.5", "-12" or "3,5 s"; Enter applies, Escape reverts, arrows nudge.
const offsetField = ui.lyricsOffsetText;
function applyOffsetText() {
  const v = parseFloat(offsetField.value.replace(",", ".").replace("−", "-").replace(/[^\d.+-]/g, ""));
  offsetField.blur();
  setLyricsOffset(Number.isFinite(v) ? v : +ui.lyricsOffset.value);
}
offsetField.addEventListener("focus", () => offsetField.select());
offsetField.addEventListener("blur", applyOffsetText);
offsetField.addEventListener("keydown", (e) => {
  if (e.key === "Enter") applyOffsetText();
  else if (e.key === "Escape") { offsetField.value = ""; offsetField.blur(); }
  else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    const v = +ui.lyricsOffset.value + (e.shiftKey ? 1 : 0.1) * (e.key === "ArrowUp" ? 1 : -1);
    offsetField.blur();
    setLyricsOffset(v);
    offsetField.focus();
  }
});
setLyricsOffset(0);

// Tap-to-sync: the chosen line is being sung right now.
ui.lyricsNow.addEventListener("click", () => {
  const line = lyrics[+ui.lyricsLine.value];
  if (!line || !playing || ctx.currentTime < playStartCtx) return;
  setLyricsOffset(line.t - playPosition());
  lyricsMessage(`Paroles recalées sur « ${line.text} » (décalage ${ui.lyricsOffsetText.value}).`);
});

$("lyricsApply").addEventListener("click", () => {
  const lines = parseLrc($("lyricsText").value);
  setLyrics(lines, lines.length
    ? `Paroles collées (${lines.length} lignes).`
    : "Aucune ligne reconnue : il faut le format « [mm:ss.xx] texte ».");
});

// Splits text into lines that fit maxW with the current font.
function wrapText(text, maxW) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const test = line ? `${line} ${word}` : word;
    if (line && g.measureText(test).width > maxW) { lines.push(line); line = word; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

// pos: track time being heard, or null when nothing plays.
function drawLyrics(pos) {
  if (pos === null || !ui.showLyrics.checked || !lyrics.length) return;
  const now = pos + +ui.lyricsOffset.value;
  let i = -1;
  while (i + 1 < lyrics.length && lyrics[i + 1].t <= now) i++;
  if (i < 0 || !lyrics[i].text) return;
  const { t, text } = lyrics[i];
  const end = Math.min(lyrics[i + 1] ? lyrics[i + 1].t : t + LYRIC_MAX_HOLD, t + LYRIC_MAX_HOLD);
  const since = now - t;
  const alpha = Math.max(0, Math.min(1, since / LYRIC_FADE_IN, (end - now) / LYRIC_FADE_OUT));
  if (!alpha) return;

  let size = 50;
  g.font = `600 ${size}px Outfit, system-ui, sans-serif`;
  let lines = wrapText(text, W - 280);
  if (lines.length > 2) {
    size = 42;
    g.font = `600 ${size}px Outfit, system-ui, sans-serif`;
    lines = wrapText(text, W - 240);
  }
  const lead = size * 1.25;
  const rise = (1 - Math.min(1, since / LYRIC_FADE_IN)) * 14; // slides up while fading in
  const y0 = H / 2 - ((lines.length - 1) * lead) / 2 + rise;
  g.save();
  g.globalAlpha = alpha * 0.92;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = "rgba(0,0,0,0.6)";
  g.shadowBlur = 18;
  g.fillStyle = "#fff";
  lines.forEach((l, k) => g.fillText(l, W / 2, y0 + k * lead));
  g.restore();
}

function drawOverlay(bass, pos) {
  if (ui.showLogo.checked) drawLogo(W - 100, 100);
  drawLyrics(pos);
  g.textAlign = "center";
  g.textBaseline = "middle";

  // head diagram
  if (ui.showHead.checked) {
    const cx = W / 2, cy = 1330, R = 190;
    g.strokeStyle = "rgba(255,255,255,0.35)"; g.lineWidth = 3;
    g.setLineDash([10, 14]);
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    g.setLineDash([]);
    // head (top = front)
    g.fillStyle = "rgba(255,255,255,0.9)";
    g.beginPath(); g.ellipse(cx, cy, 58, 66, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(cx - 14, cy - 62); g.lineTo(cx, cy - 86); g.lineTo(cx + 14, cy - 62); g.fill();
    g.beginPath(); g.ellipse(cx - 60, cy, 12, 22, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(cx + 60, cy, 12, 22, 0, 0, Math.PI * 2); g.fill();
    // sound source
    const px = cx + R * Math.sin(angle), py = cy - R * Math.cos(angle);
    const pr = 26 + bass * 16;
    const glow = g.createRadialGradient(px, py, 0, px, py, pr * 3);
    glow.addColorStop(0, "rgba(61,224,208,0.9)");
    glow.addColorStop(1, "rgba(61,224,208,0)");
    g.fillStyle = glow;
    g.beginPath(); g.arc(px, py, pr * 3, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#3de0d0";
    g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#06201d";
    g.font = `800 ${Math.round(pr)}px Outfit, system-ui, sans-serif`;
    g.fillText("♪", px, py + 2);
  }
}

// ---------- Render loop ----------
const freq = new Uint8Array(analyser.frequencyBinCount);
let bassLevel = 0;
let lastFrame = performance.now();

function readBass() {
  if (!playing) return 0;
  analyser.getByteFrequencyData(freq);
  const binHz = ctx.sampleRate / analyser.fftSize;
  const maxBin = Math.max(2, Math.floor(150 / binHz));
  let sum = 0;
  for (let i = 1; i <= maxBin; i++) sum += freq[i];
  return Math.min(1, Math.max(0, (sum / maxBin / 255 - 0.35) / 0.55));
}

function frame(now) {
  if (recording && recording.fast) { // the fast export draws on the canvas itself
    lastFrame = now;
    return requestAnimationFrame(frame);
  }
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  const target = readBass();
  bassLevel += (target - bassLevel) * (target > bassLevel ? 0.5 : 0.12);

  const introLeft = playing ? introEndCtx - ctx.currentTime : 0;
  if (playing) {
    angle += (dt * Math.PI * 2) / +ui.speed.value;
    const x = Math.sin(angle), z = -Math.cos(angle), y = 0.15 * Math.sin(angle * 0.5);
    const at = ctx.currentTime;
    panner.positionX.setTargetAtTime(x, at, 0.015);
    panner.positionY.setTargetAtTime(y, at, 0.015);
    panner.positionZ.setTargetAtTime(z, at, 0.015);
  }

  drawScene(bassLevel);
  drawOverlay(bassLevel, playing && ctx.currentTime >= playStartCtx ? playPosition() : null);
  if (introLength && introLeft > 0) drawIntro(introLength - introLeft, introLength);
  checkExcerptEnd();
  if (recording) updateProgress();
  requestAnimationFrame(frame);
}

// ---------- Export ----------
// Fast export (WebCodecs): the sound is rendered offline, the background clips
// are decoded frame by frame and each frame is encoded as soon as it is drawn,
// so it runs as fast as the machine allows. The local server (api/export.js)
// stretches the tempo when the pitch is kept and muxes the MP4 with ffmpeg.
// Browsers without WebCodecs, or a failure on the way, fall back to recording
// the canvas in real time with MediaRecorder.
const MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];
const mime = window.MediaRecorder
  ? MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || ""
  : "";
const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
const FPS = 30;
const MP4BOX_URL = "https://cdn.jsdelivr.net/npm/mp4box@0.5.3/dist/mp4box.all.min.js";
const AVC_CODECS = ["avc1.640028", "avc1.4d0028", "avc1.42002a"]; // High, Main, Baseline (level 4+ fits 1080×1920)

let recording = null;
let encoderConfig = null; // set when the fast export is available

(async () => {
  if (window.VideoEncoder && window.VideoDecoder && window.VideoFrame && window.OfflineAudioContext) {
    for (const codec of AVC_CODECS) {
      const config = { codec, width: W, height: H, bitrate: 16_000_000, framerate: FPS };
      const { supported } = await VideoEncoder.isConfigSupported(config).catch(() => ({}));
      if (supported) { encoderConfig = config; break; }
    }
  }
  ui.format.textContent = encoderConfig || mime
    ? `${encoderConfig ? "MP4" : ext.toUpperCase()} 1080×1920`
    : "export non pris en charge par ce navigateur";
  $("exportMode").textContent = encoderConfig
    ? "Rendu accéléré, plus rapide que la durée de la vidéo"
    : "Enregistré en temps réel : garde l'onglet au premier plan";
  ui.exportBtn.disabled = !encoderConfig && !mime;
})();

function updateProgress() {
  const done = Math.max(0, player.currentTime - excerpt.start);
  const p = Math.min(1, done / excerpt.length);
  ui.progressBar.style.width = `${(p * 100).toFixed(1)}%`;
  ui.progressText.textContent = `Enregistrement… ${fmt(done / rate())} / ${fmt(excerpt.length / rate())}`;
}

function finishExport(blob, extension) {
  const base = trackName.replace(/[^\p{L}\p{N}\- ]/gu, "").trim().replace(/\s+/g, "-");
  ui.download.href = URL.createObjectURL(blob);
  ui.download.download = `${base}-8d.${extension}`;
  ui.download.textContent = `Télécharger la vidéo (${(blob.size / 1e6).toFixed(1)} Mo)`;
  ui.download.hidden = false;
  lastExport = blob;
  captionInput.value = defaultCaption();
  $("tiktok").hidden = false;
  if (autoTikTok.checked) prepareOnTikTok({ auto: true });
}

// Hides the previous video's download link and TikTok panel.
function clearExport() {
  if (ui.download.href) URL.revokeObjectURL(ui.download.href);
  ui.download.removeAttribute("href");
  ui.download.hidden = true;
  $("tiktok").hidden = true;
  lastExport = null;
}

async function startExport() {
  if (!buffer || recording) return;
  unlockPlayer();
  await ctx.resume();
  await document.fonts.ready;
  clearExport();
  if (encoderConfig) {
    try {
      return await fastExport();
    } catch (e) {
      if (e.name === "AbortError") return;
      console.warn("Fast export failed, recording in real time instead", e);
      if (!mime) {
        $("exportMode").textContent = `Export impossible : ${e.message}`;
        return;
      }
    }
  }
  realtimeExport();
}

function realtimeExport() {
  const stream = new MediaStream([
    ...canvas.captureStream(30).getVideoTracks(),
    ...recDest.stream.getAudioTracks(),
  ]);
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 20_000_000, audioBitsPerSecond: 256_000 });
  recording = { rec, cancelled: false };
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    stream.getVideoTracks().forEach((tr) => tr.stop());
    const cancelled = recording.cancelled;
    recording = null;
    setBusy(false);
    if (!cancelled) finishExport(new Blob(chunks, { type: mime.split(";")[0] }), ext);
  };

  setBusy(true);
  rec.start(1000);
  startSource(() => { if (rec.state !== "inactive") rec.stop(); });
}

function cancelExport() {
  if (!recording) return;
  recording.cancelled = true;
  if (recording.fast) return recording.abort.abort();
  stopSource();
  if (recording.rec.state !== "inactive") recording.rec.stop();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${src} introuvable`));
    document.head.appendChild(s);
  });
}

async function postExport(path, body, signal) {
  const res = await fetch(path, { method: "POST", body, signal });
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  return res;
}

// Decodes a background clip, frame by frame in display order, a few frames ahead.
class ClipReader {
  static async open(id, signal) {
    if (!window.MP4Box) {
      await loadScript(MP4BOX_URL);
      Log.setLogLevel(Log.error);
    }
    const data = await (await fetch(`assets/videos/${id}.mp4`, { signal })).arrayBuffer();
    const file = MP4Box.createFile();
    let track = null;
    const samples = [];
    file.onReady = (info) => {
      track = info.videoTracks[0];
      file.setExtractionOptions(track.id, null, { nbSamples: Infinity });
      file.start();
    };
    file.onSamples = (_, __, list) => samples.push(...list);
    data.fileStart = 0;
    file.appendBuffer(data); // parsing is synchronous: everything is ready after flush()
    file.flush();
    if (!track) throw new Error(`${id}.mp4 illisible`);
    const avcC = file.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0].avcC;
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    avcC.write(stream);
    return new ClipReader(track, samples, new Uint8Array(stream.buffer, 8)); // without the box header
  }

  constructor(track, samples, description) {
    this.samples = samples;
    this.fed = 0;
    this.frames = [];
    this.flushed = false;
    this.error = null;
    this.wake = null;
    this.decoder = new VideoDecoder({
      output: (f) => { this.frames.push(f); this.wake?.(); },
      error: (e) => { this.error = e; this.wake?.(); },
    });
    this.decoder.configure({ codec: track.codec, codedWidth: track.video.width, codedHeight: track.video.height, description });
  }

  // Next frame (the caller closes it), or null at the end of the clip.
  async next() {
    while (!this.frames.length) {
      if (this.error) throw this.error;
      if (this.fed < this.samples.length) {
        while (this.fed < this.samples.length && this.decoder.decodeQueueSize < 8) {
          const s = this.samples[this.fed++];
          this.decoder.decode(new EncodedVideoChunk({
            type: s.is_sync ? "key" : "delta",
            timestamp: (1e6 * s.cts) / s.timescale,
            duration: (1e6 * s.duration) / s.timescale,
            data: s.data,
          }));
        }
        // The decoder may hold frames back to reorder them: wait for one, or feed more.
        await new Promise((resolve) => { this.wake = resolve; setTimeout(resolve, 4); });
      } else if (!this.flushed) {
        this.flushed = true;
        await this.decoder.flush();
      } else {
        return null;
      }
    }
    return this.frames.shift();
  }

  close() {
    this.frames.forEach((f) => f.close());
    this.frames = [];
    if (this.decoder.state !== "closed") this.decoder.close();
  }
}

// Endless random order of clips, never the same place twice in a row (like nextRandomScene).
function clipOrder() {
  let queue = [], last = null;
  return () => {
    if (!queue.length) queue = shuffleScenes(last);
    return (last = queue.shift()).id;
  };
}

function sliceBuffer(buf, start, length) {
  const from = Math.floor(start * buf.sampleRate);
  const frames = Math.max(1, Math.min(buf.length - from, Math.ceil(length * buf.sampleRate)));
  const out = new AudioBuffer({ numberOfChannels: buf.numberOfChannels, length: frames, sampleRate: buf.sampleRate });
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(from, from + frames), c);
  return out;
}

// The excerpt as it is heard: the source buffer and its playback rate. With
// "Garder la tonalité", ffmpeg changes the tempo and the result plays at 1×.
async function exportSource(signal) {
  const src = sliceBuffer(buffer, excerpt.start, excerpt.length);
  const r = rate();
  if (r === 1 || !ui.keepPitch.checked) return { src, srcRate: r };
  const res = await postExport(`/api/export/stretch?rate=${r}`, bufferToWav(src), signal);
  return { src: await ctx.decodeAudioData(await res.arrayBuffer()), srcRate: 1 };
}

// The same chain as the live one, with the rotation and the intro fade-in scheduled up front.
function renderExportAudio(src, srcRate, total, introLen) {
  const sr = ctx.sampleRate;
  const off = new OfflineAudioContext(2, Math.ceil(total * sr), sr);
  const n = buildChain(off);
  applyMix(n, 0);
  const source = new AudioBufferSourceNode(off, { buffer: src, playbackRate: srcRate });
  source.connect(n.lowpass);
  source.connect(n.highpass);
  const steps = Math.max(2, Math.ceil(total * 200));
  const x = new Float32Array(steps), y = new Float32Array(steps), z = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const a = (((i / (steps - 1)) * total) * Math.PI * 2) / +ui.speed.value;
    x[i] = Math.sin(a); y[i] = 0.15 * Math.sin(a * 0.5); z[i] = -Math.cos(a);
  }
  n.panner.positionX.setValueCurveAtTime(x, 0, total);
  n.panner.positionY.setValueCurveAtTime(y, 0, total);
  n.panner.positionZ.setValueCurveAtTime(z, 0, total);
  fadeIn(n.masterOut.gain, 0, introLen);
  source.start(0);
  return off.startRendering();
}

// Bass level for each video frame, as readBass() and the smoothing in frame()
// compute it live at 60 fps from the analyser (2048-point Blackman FFT, bins under 150 Hz).
function exportBassLevels(src, srcRate, nFrames) {
  const N = 2048, sr = src.sampleRate, STEP = 60;
  const L = src.getChannelData(0), R = src.numberOfChannels > 1 ? src.getChannelData(1) : L;
  const maxBin = Math.max(2, Math.floor(150 / (sr / N)));
  const win = Float32Array.from({ length: N }, (_, i) =>
    0.42 - 0.5 * Math.cos((2 * Math.PI * i) / N) + 0.08 * Math.cos((4 * Math.PI * i) / N));
  const cos = [], sin = [];
  for (let k = 0; k <= maxBin; k++) {
    cos[k] = Float32Array.from({ length: N }, (_, i) => Math.cos((2 * Math.PI * k * i) / N));
    sin[k] = Float32Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * k * i) / N));
  }
  const frame = new Float32Array(N);
  const smooth = new Float64Array(maxBin + 1);
  const levels = new Float32Array(nFrames);
  let level = 0;
  const steps = Math.ceil((nFrames / FPS) * STEP);
  for (let j = 0, f = 0; j <= steps && f < nFrames; j++) {
    const end = Math.floor((j / STEP) * srcRate * sr);
    for (let i = 0; i < N; i++) {
      const at = end - N + i;
      frame[i] = at >= 0 && at < L.length ? ((L[at] + R[at]) / 2) * win[i] : 0;
    }
    let sum = 0;
    for (let k = 1; k <= maxBin; k++) {
      let re = 0, im = 0;
      for (let i = 0; i < N; i++) { re += frame[i] * cos[k][i]; im -= frame[i] * sin[k][i]; }
      smooth[k] = 0.6 * smooth[k] + 0.4 * (Math.hypot(re, im) / N);
      const db = 20 * Math.log10(smooth[k] || 1e-12);
      sum += Math.max(0, Math.min(255, Math.floor((255 * (db + 100)) / 70)));
    }
    const target = Math.min(1, Math.max(0, (sum / maxBin / 255 - 0.35) / 0.55));
    level += (target - level) * (target > level ? 0.5 : 0.12);
    while (f < nFrames && f / FPS <= j / STEP) levels[f++] = level;
  }
  return levels;
}

// Length-prefixed NAL units (WebCodecs "avc") to Annex B, with SPS/PPS before each key frame.
function avcToAnnexB(avcC) {
  const lengthSize = (avcC[4] & 3) + 1;
  const params = [];
  let p = 5;
  const readSets = (count) => {
    for (let i = 0; i < count; i++) {
      const len = (avcC[p] << 8) | avcC[p + 1];
      params.push(avcC.slice(p + 2, p + 2 + len));
      p += 2 + len;
    }
  };
  readSets(avcC[p++] & 31); // SPS
  readSets(avcC[p++]); // PPS
  return (data, key) => {
    const nals = key ? [...params] : [];
    for (let i = 0; i < data.length;) {
      let len = 0;
      for (let k = 0; k < lengthSize; k++) len = len * 256 + data[i + k];
      nals.push(data.subarray(i + lengthSize, i + lengthSize + len));
      i += lengthSize + len;
    }
    const out = new Uint8Array(nals.reduce((n, nal) => n + 4 + nal.length, 0));
    let o = 0;
    for (const nal of nals) {
      out[o + 3] = 1; // 00 00 00 01
      out.set(nal, o + 4);
      o += 4 + nal.length;
    }
    return out;
  };
}

const yieldToPage = () => new Promise((resolve) => setTimeout(resolve));

async function fastExport() {
  const abort = new AbortController();
  const { signal } = abort;
  const r = rate();
  const total = excerpt.length / r;
  const nFrames = Math.max(1, Math.round(total * FPS));
  const introLen = ui.showIntro.checked ? INTRO_SECONDS : 0;
  const readers = [];
  let encoder = null, cur = null, prev = null, upcoming = null;

  stopSource();
  computeExcerpt();
  current?.video?.pause();
  recording = { fast: true, cancelled: false, abort };
  setBusy(true);
  const progress = (p, text) => {
    ui.progressBar.style.width = `${(p * 100).toFixed(1)}%`;
    ui.progressText.textContent = text;
  };
  try {
    progress(0, "Préparation du son…");
    const { src, srcRate } = await exportSource(signal);
    const audioDone = renderExportAudio(src, srcRate, total, introLen);
    const bass = exportBassLevels(src, srcRate, nFrames);

    const chunks = [];
    let toAnnexB = null, encodeError = null;
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig?.description) toAnnexB = avcToAnnexB(new Uint8Array(meta.decoderConfig.description));
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        chunks.push(toAnnexB(data, chunk.type === "key"));
      },
      error: (e) => { encodeError = e; },
    });
    encoder.configure({ ...encoderConfig, avc: { format: "avc" } });

    const nextClip = clipOrder();
    let reader = await ClipReader.open(nextClip(), signal);
    upcoming = ClipReader.open(nextClip(), signal);
    readers.push(reader);
    let prevStart = 0;
    for (let i = 0; i < nFrames; i++) {
      if (signal.aborted) throw new DOMException("Export annulé", "AbortError");
      if (encodeError) throw encodeError;
      const t = i / FPS;
      let f = await reader.next();
      if (!f) { // clip over: its last frame fades out over the next clip
        prev?.close();
        prev = cur;
        cur = null;
        prevStart = t;
        reader.close();
        reader = await upcoming;
        readers.push(reader);
        upcoming = ClipReader.open(nextClip(), signal);
        f = await reader.next();
      }
      cur?.close();
      cur = f;
      let fade = prev ? 1 - ((t - prevStart) * 1000) / CROSSFADE_MS : 0;
      if (prev && fade <= 0) { prev.close(); prev = null; fade = 0; }

      angle = (t * Math.PI * 2) / +ui.speed.value;
      drawBackground(cur, prev, fade, bass[i]);
      drawOverlay(bass[i], excerpt.start + t * r);
      if (introLen && t < introLen) drawIntro(t, introLen);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 4) await yieldToPage();
      if (i % 5 === 0) {
        progress((0.9 * i) / nFrames, `Rendu de la vidéo… ${Math.round((100 * i) / nFrames)} %`);
        await yieldToPage();
      }
    }
    await encoder.flush();
    if (encodeError) throw encodeError;

    progress(0.92, "Assemblage du MP4…");
    const audio = await audioDone;
    const wav = bufferToWav(audio);
    const header = new DataView(new ArrayBuffer(4));
    header.setUint32(0, wav.size, true);
    const res = await postExport("/api/export/mux", new Blob([header, wav, ...chunks]), signal);
    const blob = new Blob([await res.arrayBuffer()], { type: "video/mp4" });
    if (signal.aborted) throw new DOMException("Export annulé", "AbortError");
    finishExport(blob, "mp4");
  } finally {
    cur?.close();
    prev?.close();
    readers.forEach((rd) => rd.close());
    upcoming?.then((rd) => rd.close(), () => {});
    if (encoder && encoder.state !== "closed") encoder.close();
    recording = null;
    setBusy(false);
    current?.video?.play().catch(() => {});
  }
}

function setBusy(busy) {
  ui.progress.hidden = !busy;
  ui.exportBtn.disabled = busy;
  ui.play.disabled = busy;
  ui.file.disabled = busy;
  ui.url.disabled = busy;
  $("urlBtn").disabled = busy;
  $("pasteBtn").disabled = busy;
  ui.start.disabled = busy;
  ui.end.disabled = busy;
  waveWrap.classList.toggle("disabled", busy);
  ui.duration.disabled = busy;
  ui.rate.disabled = busy;
  ui.pos.disabled = busy;
  if (!busy) ui.progressBar.style.width = "0";
}

document.addEventListener("visibilitychange", () => {
  if (recording && !recording.fast && document.hidden) {
    ui.progressText.textContent = "Onglet en arrière-plan : la vidéo risque de figer. Reviens ici.";
  }
});

// ---------- UI wiring ----------
function syncOutputs() {
  ui.speedOut.textContent = `${(+ui.speed.value).toFixed(1)} s / tour`;
  ui.intensityOut.textContent = `${Math.round(ui.intensity.value * 100)} %`;
  ui.reverbOut.textContent = `${Math.round(ui.reverb.value * 100)} %`;
  applyMix();
}
[ui.speed, ui.intensity, ui.reverb].forEach((el) => el.addEventListener("input", syncOutputs));
$("studio").addEventListener("change", () => applyMix());
ui.showIntro.addEventListener("change", computeExcerpt);

// Début and Fin each trim their own edge (custom duration); the other edge
// stays put. To move the whole excerpt, drag the selection on the waveform.
function setStart(t) {
  sel.start = Math.max(0, Math.min(t, sel.end - minExcerpt()));
  ui.duration.value = "custom";
  computeExcerpt();
  relaunchIfPlaying();
}
bindTimeField(ui.startTime, () => sel.start, setStart);
bindTimeField(ui.endTime, () => sel.end, (t) => {
  sel.end = Math.min(buffer.duration, Math.max(t, sel.start + minExcerpt()));
  ui.duration.value = "custom";
  computeExcerpt();
  relaunchIfPlaying();
});
bindTimeField(ui.posTime, () => +ui.pos.value, seekTo);

ui.start.addEventListener("input", () => {
  if (buffer) setStart(+ui.start.value);
});
// The Fin slider trims the end, like the Fin field (custom duration).
ui.end.addEventListener("input", () => {
  if (!buffer) return;
  sel.end = Math.min(buffer.duration, Math.max(+ui.end.value, sel.start + minExcerpt()));
  ui.duration.value = "custom";
  computeExcerpt();
  relaunchIfPlaying();
});
ui.duration.addEventListener("change", () => {
  applyPreset();
  relaunchIfPlaying();
});

function syncRate() {
  ui.rateOut.textContent = `${rate().toFixed(2)}×`;
  computeExcerpt();
}
ui.rate.addEventListener("input", () => {
  applyRate();
  syncRate();
});
ui.keepPitch.addEventListener("change", applyRate);
ui.rate.addEventListener("dblclick", () => {
  ui.rate.value = 1;
  ui.rate.dispatchEvent(new Event("input"));
});
syncRate();

ui.play.addEventListener("click", async () => {
  unlockPlayer();
  await ctx.resume();
  if (playing) {
    if (ctx.currentTime >= playStartCtx) cursor = player.currentTime; // resume here next time
    stopSource();
    syncCursor();
  } else if (buffer) startSource();
});
ui.exportBtn.addEventListener("click", startExport);
ui.cancel.addEventListener("click", cancelExport);

async function loadFile(file) {
  if (!file) return;
  ui.fileName.textContent = "Décodage…";
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    setBuffer(buf, file.name);
    trackName = fileBaseName(file.name);
    trackInfo = describeTrack(file.name.replace(/\.[^.]+$/, ""));
    findLyrics();
  } catch (e) {
    ui.fileName.textContent = "Fichier illisible. Essaie un mp3, m4a ou wav.";
  }
}
ui.file.addEventListener("change", () => loadFile(ui.file.files[0]));

// ---------- Publication TikTok ----------
// The local server drives a Chromium window (api/tiktok.js); this page sends the
// exported video and follows the progress. It clicks "Post" itself when "auto" is
// ticked; otherwise posting is left to the user, in TikTok. With "Publier sur
// TikTok à la fin de l'export", every export is posted this way in the background.
let lastExport = null;
const captionInput = $("caption");

// "Publier sur TikTok à la fin de l'export": on by default, remembered per browser.
const autoTikTok = $("autoTikTok");
try { autoTikTok.checked = localStorage.getItem("orbite-auto-tiktok") !== "0"; } catch (_) {}
autoTikTok.addEventListener("change", () => {
  try { localStorage.setItem("orbite-auto-tiktok", autoTikTok.checked ? "1" : "0"); } catch (_) {}
});

// English caption with the song and artist, refilled after each export (editable).
function defaultCaption() {
  const { song, artist } = trackInfo;
  const name = song && artist ? `${song} – ${artist}` : song;
  return `${name ? `${name} (8D Audio)` : "8D Audio"} 🎧 Put your headphones on for the full 8D experience #8daudio #8d #viral #fyp`;
}

function tiktokMessage(text, isError) {
  const el = $("tiktokMsg");
  el.textContent = text;
  el.classList.toggle("error", !!isError);
}

async function tiktokPost(action, body, type) {
  const res = await fetch(`/api/tiktok/${action}`, {
    method: "POST",
    headers: { "X-Orbite": "1", ...(type ? { "Content-Type": type } : {}) },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

// Polls the server until the job reaches one of the given states.
let tiktokPoll = 0;
async function waitTikTok(states) {
  const id = ++tiktokPoll;
  for (;;) {
    const job = await (await fetch("/api/tiktok/status")).json();
    if (id !== tiktokPoll) return job; // a newer wait took over
    tiktokMessage(job.message, job.state === "error");
    if (states.includes(job.state)) return job;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// auto: clicks "Post" itself (always true right after an export), else the "Publier automatiquement" box.
async function prepareOnTikTok({ auto = $("autoPost").checked } = {}) {
  if (!lastExport) return;
  const btn = $("tiktokBtn");
  btn.disabled = true;
  try {
    tiktokMessage("Envoi de la vidéo au serveur local…");
    const caption = captionInput.value.trim();
    await tiktokPost(`prepare?caption=${encodeURIComponent(caption)}${auto ? "&auto=1" : ""}`, lastExport, lastExport.type);
    const job = await waitTikTok(["ready", "published", "check", "error", "idle"]);
    btn.disabled = false;
    // Manual mode: keep following, the window closes itself once the user has posted.
    if (job.state === "ready") waitTikTok(["published", "check", "error", "idle"]).catch(() => {});
  } catch (e) {
    tiktokMessage(e.message || "Erreur pendant la préparation sur TikTok.", true);
  } finally {
    btn.disabled = false;
  }
}
$("tiktokBtn").addEventListener("click", () => prepareOnTikTok());

// ---------- Import par lien ----------
const URL_HINT = "Lien direct audio, Dropbox, YouTube ou Spotify. YouTube et Spotify passent par le serveur local.";
const SERVER_AUDIO_HOSTS = /(^|\.)youtube\.com$|^youtu\.be$|(^|\.)youtube-nocookie\.com$|^open\.spotify\.com$/;
const YOUTUBE_AUDIO_ENDPOINT = "/api/youtube-audio";

function urlMessage(text, isError) {
  const el = $("urlMsg");
  el.textContent = text;
  el.classList.toggle("error", !!isError);
}

// Rewrites share links into URLs that serve the raw file with CORS headers.
function normalizeAudioUrl(raw) {
  const u = new URL(raw.trim());
  if (!/^https?:$/.test(u.protocol)) throw new Error("protocol");
  const host = u.hostname.replace(/^www\./, "");
  if (SERVER_AUDIO_HOSTS.test(host)) return u.toString();
  if (host === "dropbox.com") {
    u.hostname = "dl.dropboxusercontent.com";
    u.searchParams.delete("dl");
  }
  const drive = host === "drive.google.com" && u.pathname.match(/\/file\/d\/([^/]+)/);
  if (drive) return `https://drive.usercontent.google.com/download?id=${drive[1]}&export=download`;
  return u.toString();
}

async function loadUrl(raw) {
  let url;
  let viaServer = false;
  try {
    url = normalizeAudioUrl(raw);
    viaServer = SERVER_AUDIO_HOSTS.test(new URL(url).hostname.replace(/^www\./, ""));
  } catch (e) {
    urlMessage("Lien invalide.", true);
    return;
  }
  const btn = $("urlBtn");
  btn.disabled = true;
  urlMessage(/open\.spotify\.com/.test(url) ? "Recherche du morceau Spotify sur YouTube…" : "Téléchargement…");
  try {
    const requestUrl = viaServer
      ? `${YOUTUBE_AUDIO_ENDPOINT}?url=${encodeURIComponent(url)}`
      : url;
    const res = await fetch(requestUrl);
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !type.startsWith("audio/")) {
      const detail = (await res.text()).trim();
      throw new Error(detail || `HTTP ${res.status}`);
    }
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    const ytTitle = viaServer ? decodeURIComponent(res.headers.get("x-audio-title") || "") : "";
    const name = viaServer ? ytTitle || "youtube-audio" : decodeURIComponent(new URL(raw).pathname.split("/").pop() || "audio");
    setBuffer(buf, name);
    trackName = viaServer ? fileBaseName(`${name}.mp3`) : fileBaseName(name);
    trackInfo = viaServer
      ? describeTrack(name, decodeURIComponent(res.headers.get("x-audio-artist") || ""))
      : describeTrack(name.replace(/\.[^.]+$/, ""));
    findLyrics();
    urlMessage(URL_HINT);
  } catch (e) {
    urlMessage(e instanceof TypeError
      ? "Le site qui héberge ce fichier bloque son chargement depuis une autre page. Essaie un lien Dropbox ou un autre hébergeur."
      : e.message || "Impossible de lire ce fichier audio.", true);
  } finally {
    btn.disabled = false;
  }
}

$("pasteBtn").addEventListener("click", async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) return urlMessage("Le presse-papiers est vide.", true);
    ui.url.value = text;
    loadUrl(text);
  } catch (_) {
    urlMessage("Accès au presse-papiers refusé. Colle le lien avec ⌘V.", true);
    ui.url.focus();
  }
});

$("urlForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (ui.url.value.trim()) loadUrl(ui.url.value);
});
["dragenter", "dragover"].forEach((ev) => ui.drop.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => ui.drop.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.remove("over"); }));
ui.drop.addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));

// ---------- Boot ----------
syncOutputs();
requestAnimationFrame(frame);
makeDemo().then((buf) => { if (!buffer) setBuffer(buf, "Son démo chargé"); });
