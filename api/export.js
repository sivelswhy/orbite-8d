"use strict";

// Fast export helpers: the page renders the video faster than real time
// (WebCodecs) and ffmpeg does the audio work the browser cannot do offline.
//   POST /api/export/stretch?rate=1.2  WAV → WAV, tempo changed, pitch kept
//   POST /api/export/mux               [u32 LE WAV size][WAV][H.264 Annex B, 30 fps] → MP4

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_BODY = 1024 * 1024 * 1024;
const FPS = 30;

function sendText(res, status, text) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error("Body too large")); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getStretchArgs(input, output, rate) {
  return ["-y", "-v", "error", "-i", input, "-filter:a", `atempo=${rate}`, "-c:a", "pcm_s16le", output];
}

function getMuxArgs(video, audio, output) {
  return [
    "-y", "-v", "error",
    // Raw H.264 has no timestamps. The frame rate written in the stream by the
    // browser's encoder can be anything (Safari's made the video race ahead of
    // the sound), so frame N is stamped at N/30 s whatever it says.
    // (No -shortest: with generated timestamps it drops the audio.)
    "-fflags", "+genpts", "-framerate", String(FPS), "-f", "h264", "-i", video,
    "-i", audio,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "copy", "-bsf:v", `setts=pts=N/(${FPS}*TB):dts=N/(${FPS}*TB)`,
    "-c:a", "aac", "-b:a", "256k",
    "-movflags", "+faststart",
    output,
  ];
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let errorOutput = "";
    ff.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });
    ff.on("error", (error) => reject(new Error(error.code === "ENOENT"
      ? "ffmpeg est introuvable. Installe-le (brew install ffmpeg) ou définis FFMPEG_PATH."
      : error.message)));
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(errorOutput.trim() || `ffmpeg exited with ${code}`))));
  });
}

function sendFile(res, file, type, cleanup) {
  res.writeHead(200, { "Cache-Control": "no-store", "Content-Type": type, "Content-Length": fs.statSync(file).size });
  fs.createReadStream(file).on("close", cleanup).on("error", () => res.destroy()).pipe(res);
}

async function exportRoute(req, res) {
  if (req.method !== "POST") return sendText(res, 405, "Method not allowed");
  const { pathname, searchParams } = new URL(req.url, "http://localhost");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbite-export-"));
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }, () => {});
  try {
    const body = await readBody(req);
    if (pathname === "/api/export/stretch") {
      const rate = Number(searchParams.get("rate"));
      if (!(rate >= 0.5 && rate <= 2)) throw Object.assign(new Error("rate must be between 0.5 and 2"), { status: 400 });
      const input = path.join(dir, "in.wav"), output = path.join(dir, "out.wav");
      fs.writeFileSync(input, body);
      await runFfmpeg(getStretchArgs(input, output, rate));
      return sendFile(res, output, "audio/wav", cleanup);
    }
    if (pathname === "/api/export/mux") {
      const wavSize = body.length >= 4 ? body.readUInt32LE(0) : 0;
      if (!wavSize || 4 + wavSize >= body.length) throw Object.assign(new Error("Malformed body"), { status: 400 });
      const audio = path.join(dir, "audio.wav"), video = path.join(dir, "video.h264"), output = path.join(dir, "out.mp4");
      fs.writeFileSync(audio, body.subarray(4, 4 + wavSize));
      fs.writeFileSync(video, body.subarray(4 + wavSize));
      await runFfmpeg(getMuxArgs(video, audio, output));
      return sendFile(res, output, "video/mp4", cleanup);
    }
    cleanup();
    sendText(res, 404, "Not found");
  } catch (error) {
    cleanup();
    sendText(res, error.status || 500, error.message);
  }
}

module.exports = exportRoute;
module.exports.getStretchArgs = getStretchArgs;
module.exports.getMuxArgs = getMuxArgs;
