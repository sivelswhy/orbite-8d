"use strict";

const youtubedl = require("youtube-dl-exec");
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

module.exports = function youtubeAudio(req, res) {
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

  const process = youtubedl.exec(url, {
    noPlaylist: true,
    noWarnings: true,
    format: "bestaudio/best",
    extractAudio: true,
    audioFormat: "mp3",
    audioQuality: "0",
    output: "-",
    ffmpegLocation: ffmpegPath,
  }, { stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  let errorOutput = "";
  let responded = false;

  process.stdout.on("data", (chunk) => output.push(chunk));
  process.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });
  process.on("error", (error) => {
    if (responded) return;
    responded = true;
    const message = error.code === "ENOENT"
      ? "YouTube converter binary is not available"
      : "Unable to start audio conversion";
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message);
  });
  process.on("close", (code) => {
    if (responded) return;
    if (code === 0) {
      responded = true;
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Type": "audio/mpeg",
        "Content-Disposition": "attachment; filename=\"youtube-audio.mp3\"",
      });
      return res.end(Buffer.concat(output));
    }
    responded = true;
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(errorOutput.trim() || "Unable to download this YouTube audio");
  });
  req.on("close", () => { if (!process.killed) process.kill(); });
};
