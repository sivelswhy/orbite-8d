"use strict";

const { Readable } = require("stream");

const VIDKRAKEN_API = "https://vidkraken.com/api/v2/download";

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createVidKrakenDownload(url, apiKey) {
  const createResponse = await fetch(VIDKRAKEN_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, format: "mp3" }),
  });
  const createData = await createResponse.json().catch(() => ({}));
  if (!createResponse.ok || !createData.jobId) {
    throw new Error(createData.error || createData.message || `VidKraken HTTP ${createResponse.status}`);
  }

  for (let attempt = 0; attempt < 50; attempt++) {
    await wait(1000);
    const statusResponse = await fetch(`${VIDKRAKEN_API}/${encodeURIComponent(createData.jobId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const statusData = await statusResponse.json().catch(() => ({}));
    if (!statusResponse.ok) {
      throw new Error(statusData.error || statusData.message || `VidKraken HTTP ${statusResponse.status}`);
    }
    if (statusData.status === "COMPLETED" && statusData.downloadUrl) return statusData.downloadUrl;
    if (["FAILED", "ERROR", "CANCELLED"].includes(statusData.status)) {
      throw new Error(statusData.error || statusData.message || "VidKraken download failed");
    }
  }
  throw new Error("VidKraken download timed out");
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

  const apiKey = process.env.VIDKRAKEN_API_KEY;
  if (!apiKey) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("VIDKRAKEN_API_KEY is not configured");
  }

  try {
    const downloadUrl = await createVidKrakenDownload(url, apiKey);
    const audioResponse = await fetch(downloadUrl);
    if (!audioResponse.ok || !audioResponse.body) throw new Error("VidKraken file unavailable");
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Type": "audio/mpeg",
      "Content-Disposition": "attachment; filename=\"youtube-audio.mp3\"",
    });
    return Readable.fromWeb(audioResponse.body).pipe(res);
  } catch (error) {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(error.message || "VidKraken download failed");
  }
};
