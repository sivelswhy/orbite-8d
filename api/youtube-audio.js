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

// open.spotify.com/track/<id> (also /intl-fr/track/<id>) → the track id, else null.
function getSpotifyTrackId(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "open.spotify.com") return null;
    const match = url.pathname.match(/^(?:\/intl-[\w-]+)?\/track\/([A-Za-z0-9]{22})\/?$/);
    return match ? match[1] : null;
  } catch (_) {
    return null;
  }
}

// Spotify audio is DRM-protected: only the title and artists are read (from
// the public embed page), then the same song is searched on YouTube.
function parseSpotifyEmbed(html) {
  const json = html.match(/<script id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/);
  const entity = json && JSON.parse(json[1]).props?.pageProps?.state?.data?.entity;
  if (!entity || !entity.name) throw new Error("Morceau Spotify introuvable.");
  const artist = (entity.artists || [])[0]?.name || "";
  return { title: artist ? `${artist} - ${entity.name}` : entity.name, artist, track: entity.name };
}

async function getSpotifyTrack(id) {
  const res = await fetch(`https://open.spotify.com/embed/track/${id}`);
  if (!res.ok) throw new Error(`Spotify : HTTP ${res.status}`);
  return parseSpotifyEmbed(await res.text());
}

function getParam(req, name) {
  return new URL(req.url, "http://localhost").searchParams.get(name);
}

// yt-dlp and ffmpeg come from YTDLP_PATH / FFMPEG_PATH, else from the PATH
// (brew install yt-dlp ffmpeg, pipx install yt-dlp, …).
function getYtdlpArgs(url, outputDir) {
  const args = [
    "--no-playlist", "--no-warnings", "--no-progress", "--no-part",
    "--format", "bestaudio/best",
    "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0",
    "--print", "after_move:%(title)s\t%(track|)s\t%(artist|)s\t%(uploader|)s",
    "--output", path.join(outputDir, "audio.%(ext)s"),
  ];
  if (process.env.FFMPEG_PATH) args.push("--ffmpeg-location", process.env.FFMPEG_PATH);
  if (process.env.YTDLP_COOKIES) args.push("--cookies", process.env.YTDLP_COOKIES);
  args.push("--", url);
  return args;
}

// yt-dlp prints "title<TAB>track<TAB>artist<TAB>uploader". Music videos have
// track/artist; otherwise the page parses "Artist - Song" from the title and
// falls back to the channel name.
function parseInfo(line) {
  const [title = "", track = "", artist = "", uploader = ""] = line.split("\t").map((v) => (v === "NA" ? "" : v.trim()));
  const mainArtist = artist.split(",")[0].trim();
  if (track && mainArtist) return { title: `${mainArtist} - ${track}`, artist: mainArtist };
  return { title, artist: mainArtist || uploader };
}

function sendText(res, status, text) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function youtubeAudio(req, res) {
  if (req.method !== "GET") return sendText(res, 405, "Method not allowed");

  let url = getParam(req, "url");
  let spotify = null;
  const spotifyId = url && getSpotifyTrackId(url);
  if (spotifyId) {
    try {
      spotify = await getSpotifyTrack(spotifyId);
    } catch (error) {
      return sendText(res, 502, error.message);
    }
    url = `ytsearch1:${spotify.artist} ${spotify.track} audio`;
  } else if (!url || !isYouTubeUrl(url)) {
    return sendText(res, 400, "A valid HTTPS YouTube or Spotify track URL is required");
  }

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbite-ytdlp-"));
  const cleanup = () => fs.rm(outputDir, { recursive: true, force: true }, () => {});
  const ytdlp = spawn(process.env.YTDLP_PATH || "yt-dlp", getYtdlpArgs(url, outputDir), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let info = "";
  let errorOutput = "";
  ytdlp.stdout.on("data", (chunk) => { info += chunk.toString(); });
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
    const meta = spotify || parseInfo(info.trim().split("\n").pop() || "");
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "audio/mpeg",
      "Content-Length": fs.statSync(file).size,
      "X-Audio-Title": encodeURIComponent(meta.title),
      "X-Audio-Artist": encodeURIComponent(meta.artist),
    });
    fs.createReadStream(file).on("close", cleanup).on("error", () => res.destroy()).pipe(res);
  });
  res.on("close", () => { if (ytdlp.exitCode === null) ytdlp.kill(); });
}

module.exports = youtubeAudio;
module.exports.getYtdlpArgs = getYtdlpArgs;
module.exports.parseInfo = parseInfo;
module.exports.isYouTubeUrl = isYouTubeUrl;
module.exports.getSpotifyTrackId = getSpotifyTrackId;
module.exports.parseSpotifyEmbed = parseSpotifyEmbed;
