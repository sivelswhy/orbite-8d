"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const youtubeAudio = require("./api/youtube-audio");

const root = __dirname;
const port = Number(process.env.PORT || 8000);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

http.createServer((req, res) => {
  if (req.url.startsWith("/api/youtube-audio")) return youtubeAudio(req, res);

  const requested = decodeURIComponent(req.url.split("?")[0]);
  const relative = requested === "/" ? "/index.html" : requested;
  const file = path.resolve(root, `.${relative}`);
  if (!file.startsWith(`${root}${path.sep}`)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500);
      return res.end("Not found");
    }
    res.writeHead(200, {
      "Content-Type": contentTypes[path.extname(file)] || "application/octet-stream",
      // Local dev server: always serve the files on disk, never a cached mix of old and new.
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}).listen(port, () => {
  console.log(`Orbite 8D: http://localhost:${port}`);
});
