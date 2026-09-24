"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const YOUTUBE_HOSTS = new Set(["youtube.com", "youtu.be", "youtube-nocookie.com"]);

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return url.protocol === "https:" && [...YOUTUBE_HOSTS].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch (_) {
    return false;
  }
}

function getParam(req, name) {
  if (req.query && req.query[name]) return req.query[name];
  const parsed = new URL(req.url, "http://localhost");
  return parsed.searchParams.get(name);
}

// yt-dlp and ffmpeg come from YTDLP_PATH / FFMPEG_PATH, else from the PATH
// (brew install yt-dlp ffmpeg, pipx install yt-dlp, …).
function getYtdlpArgs(url, outputDir) {
  const args = [
    "--no-playlist", "--no-warnings", "--no-progress", "--no-part",
    "--format", "bestaudio/best",
    "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0",
    "--print", "after_move:%(title)s",
    "--output", path.join(outputDir, "audio.%(ext)s"),
  ];
  if (process.env.FFMPEG_PATH) args.push("--ffmpeg-location", process.env.FFMPEG_PATH);
  if (process.env.YTDLP_COOKIES) args.push("--cookies", process.env.YTDLP_COOKIES);
  args.push("--", url);
  return args;
}

function sendText(res, status, text) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function youtubeAudio(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Expose-Headers": "X-Audio-Title",
    });
    return res.end();
  }

  if (req.method !== "GET") return sendText(res, 405, "Method not allowed");

  const url = getParam(req, "url");
  if (!url || !isYouTubeUrl(url)) return sendText(res, 400, "A valid HTTPS YouTube URL is required");

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbite-ytdlp-"));
  const cleanup = () => fs.rm(outputDir, { recursive: true, force: true }, () => {});
  const ytdlp = spawn(process.env.YTDLP_PATH || "yt-dlp", getYtdlpArgs(url, outputDir), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let title = "";
  let errorOutput = "";
  ytdlp.stdout.on("data", (chunk) => { title += chunk.toString(); });
  ytdlp.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });
  ytdlp.on("error", (error) => {
    cleanup();
    sendText(res, 500, error.code === "ENOENT"
      ? "yt-dlp est introuvable. Installe-le (brew install yt-dlp ffmpeg) ou définis YTDLP_PATH."
      : error.message);
  });
  ytdlp.on("close", (code) => {
    if (res.writableEnded || res.destroyed) return cleanup();
    const file = path.join(outputDir, "audio.mp3");
    if (code !== 0 || !fs.existsSync(file)) {
      cleanup();
      return sendText(res, 502, errorOutput.trim() || "yt-dlp download failed");
    }
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "X-Audio-Title",
      "Cache-Control": "no-store",
      "Content-Type": "audio/mpeg",
      "Content-Length": fs.statSync(file).size,
      "Content-Disposition": "attachment; filename=\"youtube-audio.mp3\"",
      "X-Audio-Title": encodeURIComponent(title.trim().split("\n").pop() || ""),
    });
    fs.createReadStream(file).on("close", cleanup).on("error", () => res.destroy()).pipe(res);
  });
  res.on("close", () => { if (ytdlp.exitCode === null) ytdlp.kill(); });
}

module.exports = youtubeAudio;
module.exports.getYtdlpArgs = getYtdlpArgs;
module.exports.isYouTubeUrl = isYouTubeUrl;
