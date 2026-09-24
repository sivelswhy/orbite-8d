const test = require("node:test");
const assert = require("node:assert/strict");

const { getYtdlpArgs, isYouTubeUrl } = require("../api/youtube-audio");

test("accepts only HTTPS YouTube URLs", () => {
  assert.equal(isYouTubeUrl("https://www.youtube.com/watch?v=abc"), true);
  assert.equal(isYouTubeUrl("https://youtu.be/abc"), true);
  assert.equal(isYouTubeUrl("http://youtube.com/watch?v=abc"), false);
  assert.equal(isYouTubeUrl("https://evil-youtube.com/watch?v=abc"), false);
});

test("yt-dlp converts to MP3 in the given directory and ends options before the URL", () => {
  const args = getYtdlpArgs("https://youtu.be/abc", "/tmp/out");
  assert.deepEqual(args.slice(-2), ["--", "https://youtu.be/abc"]);
  assert.ok(args.includes("--extract-audio"));
  assert.equal(args[args.indexOf("--audio-format") + 1], "mp3");
  assert.equal(args[args.indexOf("--output") + 1], "/tmp/out/audio.%(ext)s");
});

test("uses track and artist for music videos, the title otherwise", () => {
  const { parseInfo } = require("../api/youtube-audio");
  assert.deepEqual(parseInfo("Rick Astley - Never Gonna Give You Up (Official Video)\tNever Gonna Give You Up\tRick Astley\tRick Astley"),
    { title: "Rick Astley - Never Gonna Give You Up", artist: "Rick Astley" });
  assert.deepEqual(parseInfo("Me at the zoo\tNA\tNA\tjawed"), { title: "Me at the zoo", artist: "jawed" });
  assert.deepEqual(parseInfo("Song\t\tA, B\tChannel"), { title: "Song", artist: "A" });
});
