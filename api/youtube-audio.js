"use strict";

const { spawn } = require("child_process");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");

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

function getUrl(req) {
  if (req.query && req.query.url) return req.query.url;
  const parsed = new URL(req.url, "http://localhost");
  return parsed.searchParams.get("url");
}

module.exports = async function youtubeAudio(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    return res.end();
  }

  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Method not allowed");
  }

  const url = getUrl(req);
  if (!url || !isYouTubeUrl(url)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("A valid HTTPS YouTube URL is required");
  }

  const ytdlpPath = path.join(__dirname, "../bin/yt-dlp");
  const ytdlp = spawn(ytdlpPath, [
    "--no-playlist", "--no-warnings", "--format", "bestaudio/best",
    "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0",
    "--ffmpeg-location", ffmpegPath, "--output", "-", url,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  let errorOutput = "";
  ytdlp.stdout.on("data", (chunk) => output.push(chunk));
  ytdlp.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });
  ytdlp.on("error", (error) => {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(error.code === "ENOENT" ? "yt-dlp binary is not available" : error.message);
  });
  ytdlp.on("close", (code) => {
    if (res.writableEnded) return;
    if (code !== 0) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(errorOutput.trim() || "yt-dlp download failed");
    }
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Type": "audio/mpeg",
      "Content-Disposition": "attachment; filename=\"youtube-audio.mp3\"",
    });
    res.end(Buffer.concat(output));
  });
  req.on("close", () => { if (!ytdlp.killed) ytdlp.kill(); });
};
