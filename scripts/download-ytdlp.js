"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const target = path.join(__dirname, "../bin/yt-dlp");
const source = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

function download(url, destination) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return download(response.headers.location, destination).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`yt-dlp download failed with HTTP ${response.statusCode}`));
      }
      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    }).on("error", reject);
  });
}

fs.mkdirSync(path.dirname(target), { recursive: true });
download(source, target)
  .then(() => fs.chmodSync(target, 0o755))
  .then(() => console.log(`Downloaded yt-dlp to ${target}`))
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
