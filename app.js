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
  showLyrics: $("showLyrics"), lyricsOffset: $("lyricsOffset"), lyricsOffsetOut: $("lyricsOffsetOut"),
  start: $("start"), startTime: $("startTime"), endTime: $("endTime"), duration: $("duration"), excerptInfo: $("excerptInfo"),
  rate: $("rate"), rateOut: $("rateOut"), keepPitch: $("keepPitch"),
  pos: $("pos"), posTime: $("posTime"),
  play: $("play"), exportBtn: $("export"), cancel: $("cancel"),
  progress: $("progress"), progressBar: $("progressBar"), progressText: $("progressText"),
  download: $("download"), format: $("format"),
};

// ---------- Audio graph ----------
// source ─┬─ lowpass ─────────────────────────────── bass (centre) ─┐
//         └─ highpass ─┬─ panner (HRTF) ─ gain(intensité) ─┐       ├─ master ─┬─ destination
//                      └─ gain(1 - intensité) ─────────────┴─ mix ─┤          └─ recDest
//                                                 mix ─ convolver ─┘
const ctx = new (window.AudioContext || window.webkitAudioContext)();
const CROSSOVER = 120;

const lowpass = new BiquadFilterNode(ctx, { type: "lowpass", frequency: CROSSOVER, Q: 0.7 });
const highpass = new BiquadFilterNode(ctx, { type: "highpass", frequency: CROSSOVER, Q: 0.7 });
const panner = new PannerNode(ctx, {
  panningModel: "HRTF", distanceModel: "inverse", refDistance: 1, rolloffFactor: 0,
  channelCount: 1, channelCountMode: "explicit",
});
const pannedGain = new GainNode(ctx);
const centerGain = new GainNode(ctx);
const mix = new GainNode(ctx);
const convolver = new ConvolverNode(ctx, { buffer: makeImpulse(2.8, 2.5) });
const wetGain = new GainNode(ctx);
const bassGain = new GainNode(ctx, { gain: 1 });
const master = new GainNode(ctx, { gain: 0.9 });
const analyser = new AnalyserNode(ctx, { fftSize: 2048, smoothingTimeConstant: 0.6 });
const recDest = ctx.createMediaStreamDestination();

lowpass.connect(bassGain).connect(master);
highpass.connect(panner).connect(pannedGain).connect(mix);
highpass.connect(centerGain).connect(mix);
mix.connect(master);
mix.connect(convolver).connect(wetGain).connect(master);
master.connect(ctx.destination);
master.connect(recDest);

function makeImpulse(seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

function applyMix() {
  const k = +ui.intensity.value;
  const r = +ui.reverb.value;
  const t = ctx.currentTime;
  pannedGain.gain.setTargetAtTime(k, t, 0.05);
  centerGain.gain.setTargetAtTime(1 - k, t, 0.05);
  wetGain.gain.setTargetAtTime(r * 0.8, t, 0.05);
  mix.gain.setTargetAtTime(1 - r * 0.35, t, 0.05);
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
let playStartCtx = 0; // ctx time when the music starts (after the intro)
let introLength = 0; // seconds of intro card shown before the music, for the current playback
let introTimer = null;
let onExcerptEnd = null;
let cursor = null; // where "Écouter" resumes (track seconds); null = start of the excerpt
const INTRO_SECONDS = 1.5;
let excerpt = { start: 0, length: 30 };
let sel = { start: 0, end: 30 }; // chosen range in seconds; excerpt is derived from it

function stopSource() {
  clearTimeout(introTimer);
  player.pause();
  onExcerptEnd = null;
  playing = false;
  ui.play.textContent = "▶ Écouter";
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
  introLength = !live && fromStart && ui.showIntro.checked ? INTRO_SECONDS : 0;
  playStartCtx = ctx.currentTime + introLength;
  applyRate();
  player.currentTime = from;
  onExcerptEnd = onEnd || (() => {});
  introTimer = setTimeout(() => player.play().catch(() => {}), introLength * 1000);
  playing = true;
  ui.play.textContent = "■ Stop";
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
  ui.start.max = Math.max(0, total - excerpt.length).toFixed(1);
  ui.start.value = sel.start;
  showTime(ui.startTime, sel.start);
  showTime(ui.endTime, sel.end);
  $("customOpt").textContent = `Personnalisée (${fmt(excerpt.length)})`;
  ui.excerptInfo.textContent =
    `Extrait : ${fmt(excerpt.start)} → ${fmt(excerpt.start + excerpt.length)} sur ${fmt(total)} · ` +
    `vidéo de ${fmt(excerpt.length / rate())}${rate() === 1 ? "" : ` à ${rate().toFixed(2)}×`}` +
    (ui.showIntro.checked ? ` + ${String(INTRO_SECONDS).replace(".", ",")} s d'intro` : "");
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
    .replace(/\s*[([][^)\]]*\b(official|video|audio|lyrics?|clip|visuali[sz]er|hd|4k|remaster(ed)?|mv)\b[^)\]]*[)\]]/gi, "")
    .replace(/_+/g, " ").replace(/\s+/g, " ").trim();
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
  buffer = buf;
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = URL.createObjectURL(bufferToWav(buf));
  player.src = playerUrl;
  sel = { start: 0, end: 0 };
  cursor = null;
  setLyrics([], "");
  $("lyricsText").value = "";
  updateDurationOptions();
  ui.fileName.textContent = name;
  levels = computeLevels(buf);
  applyPreset();
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
const HANDLE_COLOR = "#ffd23f";
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
  if (!levels || !buffer) return;

  const total = buffer.duration;
  const x0 = (excerpt.start / total) * w;
  const x1 = ((excerpt.start + excerpt.length) / total) * w;
  waveG.fillStyle = "rgba(139, 123, 255, .14)";
  waveG.fillRect(x0, 0, x1 - x0, h);

  // dB grid
  waveG.font = `${10 * dpr}px Outfit, system-ui, sans-serif`;
  waveG.textBaseline = "middle";
  for (const db of [-6, -18, -36]) {
    const r = 1 - db / DB_FLOOR;
    for (const y of [h / 2 - (r * h) / 2, h / 2 + (r * h) / 2]) {
      waveG.fillStyle = "rgba(255, 255, 255, .06)";
      waveG.fillRect(0, Math.round(y), w, dpr);
    }
    waveG.fillStyle = "rgba(154, 152, 179, .6)";
    waveG.fillText(`${db} dB`, 4 * dpr, h / 2 - (r * h) / 2 + 6 * dpr);
  }

  const barW = w / levels.length;
  const grad = waveG.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#3de0d0");
  grad.addColorStop(0.5, "#8b7bff");
  grad.addColorStop(1, "#3de0d0");
  for (let i = 0; i < levels.length; i++) {
    const x = i * barW;
    const r = 1 - levels[i] / DB_FLOOR;
    const bh = Math.max(dpr, r * (h - 4 * dpr));
    waveG.fillStyle = x + barW >= x0 && x <= x1 ? grad : "#3a3a55";
    waveG.fillRect(x, (h - bh) / 2, Math.max(dpr, barW - dpr * 0.5), bh);
  }

  // iPhone-style trim frame: two handles joined by top and bottom borders.
  const hw = HANDLE_W * dpr;
  const border = 3 * dpr;
  const left = Math.max(0, Math.min(x0, w - 2 * hw));
  const right = Math.min(w, Math.max(x1, left + 2 * hw));
  waveG.fillStyle = HANDLE_COLOR;
  waveG.fillRect(left, 0, right - left, border);
  waveG.fillRect(left, h - border, right - left, border);
  for (const x of [left, right - hw]) {
    waveG.beginPath();
    if (waveG.roundRect) waveG.roundRect(x, 0, hw, h, 4 * dpr);
    else waveG.rect(x, 0, hw, h);
    waveG.fill();
    waveG.fillStyle = "rgba(0, 0, 0, .55)";
    waveG.fillRect(x + hw / 2 - dpr, h / 2 - 8 * dpr, 2 * dpr, 16 * dpr);
    waveG.fillStyle = HANDLE_COLOR;
  }

  if (playing || cursor !== null) {
    const t = playing ? playPosition() : cursor;
    waveG.fillStyle = playing ? "#3de0d0" : "rgba(61,224,208,0.6)";
    waveG.fillRect(Math.round((t / total) * w), 0, 2 * dpr, h);
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
    sel.end = sel.start + len;
  }
  computeExcerpt();
}

wave.addEventListener("pointerdown", (e) => {
  if (!buffer || waveWrap.classList.contains("disabled")) return;
  const { t } = waveTime(e);
  const hit = waveHit(e);
  // Tapping outside the frame moves the whole selection to start there.
  waveDrag = { mode: hit || "move", offset: hit === "move" ? t - sel.start : 0 };
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
wave.addEventListener("pointerup", () => {
  if (!waveDrag) return;
  waveDrag = null;
  relaunchIfPlaying();
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
// Every clip plays once in a shuffled order, then the list is reshuffled.
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

function nextRandomScene() {
  if (!queue.length) {
    queue = shuffle(scenes);
    if (queue[0] === current) queue.push(queue.shift()); // never the same clip twice in a row
  }
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
  if (v.readyState < 2) return;
  // Videos are exactly 1080×1920: at rest they are drawn 1:1 (sharpest); only the bass pump zooms.
  const zoom = 1 + bass * 0.03;
  const w = W * zoom, h = H * zoom;
  g.imageSmoothingQuality = "high";
  g.globalAlpha = alpha;
  g.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
  g.globalAlpha = 1;
}

// Video full-frame with a slight bass "pump", darkened a little for the overlay.
function drawScene(bass) {
  g.fillStyle = "#000";
  g.fillRect(0, 0, W, H);
  drawVideo(sceneVideo(current), bass, 1);
  if (fading) {
    const k = 1 - (performance.now() - fading.start) / CROSSFADE_MS;
    if (k > 0) drawVideo(fading.video, bass, k);
    else { fading.video.pause(); fading = null; }
  }
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

async function findLyrics() {
  const id = ++lyricsRequest;
  const { song, artist } = trackInfo;
  if (!song) return setLyrics([], "Pas de titre de morceau : colle des paroles LRC ci-dessous.");
  lyricsMessage(`Recherche des paroles de « ${song} »…`);
  try {
    const params = new URLSearchParams(artist ? { track_name: song, artist_name: artist } : { q: song });
    const res = await fetch(`https://lrclib.net/api/search?${params}`);
    const results = (await res.json()).filter((r) => r.syncedLyrics && parseLrc(r.syncedLyrics).length > 3);
    if (id !== lyricsRequest) return; // another track was loaded meanwhile
    if (!results.length) return setLyrics([], `Aucune parole synchronisée trouvée pour « ${song} ». Tu peux en coller ci-dessous.`);
    // Closest duration to the loaded track = most likely the same version.
    const best = results.sort((a, b) => Math.abs(a.duration - buffer.duration) - Math.abs(b.duration - buffer.duration))[0];
    const lines = parseLrc(best.syncedLyrics);
    setLyrics(lines, `Paroles : ${best.trackName} – ${best.artistName} (${lines.length} lignes). Si elles sont décalées, ajuste le décalage.`);
    $("lyricsText").value = best.syncedLyrics;
  } catch (_) {
    if (id === lyricsRequest) setLyrics([], "Impossible de joindre lrclib.net. Tu peux coller des paroles ci-dessous.");
  }
}

function syncLyricsOffset() {
  const v = +ui.lyricsOffset.value;
  ui.lyricsOffsetOut.textContent = `${v > 0 ? "+" : ""}${v.toFixed(1)} s`;
}
ui.lyricsOffset.addEventListener("input", syncLyricsOffset);
ui.lyricsOffset.addEventListener("dblclick", () => { ui.lyricsOffset.value = 0; syncLyricsOffset(); });
syncLyricsOffset();

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

function drawLyrics() {
  if (!ui.showLyrics.checked || !lyrics.length || !playing || ctx.currentTime < playStartCtx) return;
  const now = playPosition() + +ui.lyricsOffset.value;
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

function drawOverlay(bass) {
  if (ui.showLogo.checked) drawLogo(W - 100, 100);
  drawLyrics();
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
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  const target = readBass();
  bassLevel += (target - bassLevel) * (target > bassLevel ? 0.5 : 0.12);

  const introLeft = playing ? playStartCtx - ctx.currentTime : 0;
  if (playing && introLeft <= 0) {
    angle += (dt * Math.PI * 2) / +ui.speed.value;
    const x = Math.sin(angle), z = -Math.cos(angle), y = 0.15 * Math.sin(angle * 0.5);
    const at = ctx.currentTime;
    panner.positionX.setTargetAtTime(x, at, 0.015);
    panner.positionY.setTargetAtTime(y, at, 0.015);
    panner.positionZ.setTargetAtTime(z, at, 0.015);
  }

  drawScene(bassLevel);
  drawOverlay(bassLevel);
  if (introLength && introLeft > 0) drawIntro(introLength - introLeft, introLength);
  checkExcerptEnd();
  if (recording) updateProgress();
  requestAnimationFrame(frame);
}

// ---------- Export ----------
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
ui.format.textContent = mime ? `${ext.toUpperCase()} 1080×1920` : "export non pris en charge par ce navigateur";
if (!mime) ui.exportBtn.disabled = true;

let recording = null;

function updateProgress() {
  if (ctx.currentTime < playStartCtx) {
    ui.progressText.textContent = "Enregistrement de l'intro…";
    return;
  }
  const done = Math.max(0, player.currentTime - excerpt.start);
  const p = Math.min(1, done / excerpt.length);
  ui.progressBar.style.width = `${(p * 100).toFixed(1)}%`;
  ui.progressText.textContent = `Enregistrement… ${fmt(done / rate())} / ${fmt(excerpt.length / rate())}`;
}

async function startExport() {
  if (!buffer || recording) return;
  unlockPlayer();
  await ctx.resume();
  await document.fonts.ready;
  if (ui.download.href) URL.revokeObjectURL(ui.download.href);
  ui.download.hidden = true;
  $("tiktok").hidden = true;
  lastExport = null;

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
    if (cancelled) return;
    const blob = new Blob(chunks, { type: mime.split(";")[0] });
    const base = trackName.replace(/[^\p{L}\p{N}\- ]/gu, "").trim().replace(/\s+/g, "-");
    ui.download.href = URL.createObjectURL(blob);
    ui.download.download = `${base}-8d.${ext}`;
    ui.download.textContent = `Télécharger la vidéo (${(blob.size / 1e6).toFixed(1)} Mo)`;
    ui.download.hidden = false;
    lastExport = blob;
    captionInput.value = defaultCaption();
    $("tiktok").hidden = false;
  };

  setBusy(true);
  rec.start(1000);
  startSource(() => { if (rec.state !== "inactive") rec.stop(); });
}

function cancelExport() {
  if (!recording) return;
  recording.cancelled = true;
  stopSource();
  if (recording.rec.state !== "inactive") recording.rec.stop();
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
  waveWrap.classList.toggle("disabled", busy);
  ui.duration.disabled = busy;
  ui.rate.disabled = busy;
  ui.pos.disabled = busy;
  if (!busy) ui.progressBar.style.width = "0";
}

document.addEventListener("visibilitychange", () => {
  if (recording && document.hidden) {
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
ui.showIntro.addEventListener("change", computeExcerpt);

// Début: with a preset duration the excerpt moves (same length); with a custom
// one only its start changes. Fin always trims (custom duration).
bindTimeField(ui.startTime, () => sel.start, (t) => {
  if (ui.duration.value === "custom" || ui.duration.value === "full") {
    sel.start = Math.max(0, Math.min(t, sel.end - minExcerpt()));
    ui.duration.value = "custom";
  } else {
    const len = sel.end - sel.start;
    sel.start = Math.max(0, Math.min(t, buffer.duration - len));
    sel.end = sel.start + len;
  }
  computeExcerpt();
  relaunchIfPlaying();
});
bindTimeField(ui.endTime, () => sel.end, (t) => {
  sel.end = Math.min(buffer.duration, Math.max(t, sel.start + minExcerpt()));
  ui.duration.value = "custom";
  computeExcerpt();
  relaunchIfPlaying();
});
bindTimeField(ui.posTime, () => +ui.pos.value, seekTo);

// The slider moves the whole selection, keeping its length.
ui.start.addEventListener("input", () => {
  const len = sel.end - sel.start;
  sel.start = +ui.start.value;
  sel.end = sel.start + len;
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
// exported video and follows the progress. Posting is left to the user, in TikTok.
let lastExport = null;
const captionInput = $("caption");

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

async function prepareOnTikTok() {
  if (!lastExport) return;
  const btn = $("tiktokBtn");
  btn.disabled = true;
  try {
    tiktokMessage("Envoi de la vidéo au serveur local…");
    const caption = captionInput.value.trim();
    await tiktokPost(`prepare?caption=${encodeURIComponent(caption)}`, lastExport, lastExport.type);
    const job = await waitTikTok(["ready", "error"]);
    btn.disabled = false;
    // Keep following: the window closes itself once the user has posted.
    if (job.state === "ready") waitTikTok(["published", "check", "error", "idle"]).catch(() => {});
  } catch (e) {
    tiktokMessage(e.message || "Erreur pendant la préparation sur TikTok.", true);
  } finally {
    btn.disabled = false;
  }
}
$("tiktokBtn").addEventListener("click", prepareOnTikTok);

// ---------- Import par lien ----------
const URL_HINT = "Lien direct audio, Dropbox ou YouTube. YouTube est converti en MP3 par le serveur local.";
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
  if (/(^|\.)youtube\.com$|^youtu\.be$|(^|\.)youtube-nocookie\.com$/.test(host)) return u.toString();
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
  let isYouTube = false;
  try {
    url = normalizeAudioUrl(raw);
    isYouTube = /(^|\.)youtube\.com$|^youtu\.be$|(^|\.)youtube-nocookie\.com$/
      .test(new URL(url).hostname.replace(/^www\./, ""));
  } catch (e) {
    urlMessage("Lien invalide.", true);
    return;
  }
  const btn = $("urlBtn");
  btn.disabled = true;
  urlMessage("Téléchargement…");
  try {
    const requestUrl = isYouTube
      ? `${YOUTUBE_AUDIO_ENDPOINT}?url=${encodeURIComponent(url)}`
      : url;
    const res = await fetch(requestUrl);
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !type.startsWith("audio/")) {
      const detail = (await res.text()).trim();
      throw new Error(detail || `HTTP ${res.status}`);
    }
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    const ytTitle = isYouTube ? decodeURIComponent(res.headers.get("x-audio-title") || "") : "";
    const name = isYouTube ? ytTitle || "youtube-audio" : decodeURIComponent(new URL(raw).pathname.split("/").pop() || "audio");
    setBuffer(buf, name);
    trackName = isYouTube ? fileBaseName(`${name}.mp3`) : fileBaseName(name);
    trackInfo = isYouTube
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
