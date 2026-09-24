"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const youtubeAudio = require("./api/youtube-audio");
const tiktok = require("./api/tiktok");

const root = __dirname;
const port = Number(process.env.PORT || 8000);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
};

http.createServer((req, res) => {
  if (req.url.startsWith("/api/youtube-audio")) return youtubeAudio(req, res);
  if (req.url.startsWith("/api/tiktok/")) return tiktok(req, res);

  const requested = decodeURIComponent(req.url.split("?")[0]);
  const relative = requested === "/" ? "/index.html" : requested;
  const file = path.resolve(root, `.${relative}`);
  if (!file.startsWith(`${root}${path.sep}`)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) {
      res.writeHead(error && error.code !== "ENOENT" ? 500 : 404);
      return res.end("Not found");
    }
    const headers = {
      "Content-Type": contentTypes[path.extname(file)] || "application/octet-stream",
      "Accept-Ranges": "bytes",
      // Local dev server: always serve the files on disk, never a cached mix of old and new.
      "Cache-Control": "no-store",
    };
    // Byte ranges: Safari will not play a <video> without them.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    fs.createReadStream(file).pipe(res);
  });
// Only this Mac: the TikTok routes publish on the user's account.
}).listen(port, "127.0.0.1", () => {
  console.log(`Orbite 8D: http://localhost:${port}`);
});
