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

test("accepts only Spotify track URLs", () => {
  const { getSpotifyTrackId } = require("../api/youtube-audio");
  assert.equal(getSpotifyTrackId("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc"), "4cOdK2wGLETKBW3PvgPWqT");
  assert.equal(getSpotifyTrackId("https://open.spotify.com/intl-fr/track/4cOdK2wGLETKBW3PvgPWqT"), "4cOdK2wGLETKBW3PvgPWqT");
  assert.equal(getSpotifyTrackId("https://open.spotify.com/album/4cOdK2wGLETKBW3PvgPWqT"), null);
  assert.equal(getSpotifyTrackId("https://evil.com/track/4cOdK2wGLETKBW3PvgPWqT"), null);
});

test("reads title and main artist from the Spotify embed page", () => {
  const { parseSpotifyEmbed } = require("../api/youtube-audio");
  const data = { props: { pageProps: { state: { data: { entity: { name: "Song", artists: [{ name: "A" }, { name: "B" }] } } } } } };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
  assert.deepEqual(parseSpotifyEmbed(html), { title: "A - Song", artist: "A", track: "Song" });
  assert.throws(() => parseSpotifyEmbed("<html></html>"));
});
