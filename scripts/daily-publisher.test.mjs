import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  acceptPost, checkDeployment, createClient, deployEntry, ensureDailyEntry,
  postBody, publishDaily, saveState, selectAccounts, validateMetadata, validateVideo,
} from "./lib/daily-publisher.mjs";

const exec = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const metadata = {
  title: "a useful tool", solution: "none", date: "2026-09-11", note: "A teacher's idea.",
  caption: "Day 11: We built something useful.", youtubeTitle: "Day 11", madeForKids: false,
};
const instagramUrl = "https://www.instagram.com/reel/TEST123/";
const youtubeUrl = "https://www.youtube.com/watch?v=TEST123";
const mediaUrl = "https://media.example.test/day-11.mp4";
const siteFile = "src/content/daily/2026-09-11.md";
function freshState() {
  return {
    version: 1, videoHash: "video-hash", metadata: { ...metadata }, requestId: "request-id",
    accounts: { instagram: { id: "ig", name: "teacher" }, youtube: { id: "yt", name: "Teacher" } },
  };
}
function post(ig = "published", yt = "published", status = "published") {
  return {
    _id: "post-id", status, metadata: { dailyVideoHash: "video-hash" }, mediaItems: [{ url: mediaUrl }],
    platforms: [
      { platform: "instagram", accountId: "ig", status: ig, ...(ig === "published" ? { platformPostUrl: instagramUrl } : {}) },
      { platform: "youtube", accountId: "yt", status: yt, ...(yt === "published" ? { platformPostUrl: youtubeUrl } : { errorMessage: "YouTube error" }) },
    ],
  };
}
function harness(state = freshState(), responses = [post()]) {
  const calls = [];
  const snapshots = [];
  const entries = [];
  const client = {
    async upload() { calls.push("upload"); return mediaUrl; },
    async request(endpoint, options) {
      calls.push({ endpoint, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error(`Unexpected API request: ${endpoint}`);
      return { post: response };
    },
  };
  return {
    state, calls, snapshots, entries, client,
    run: (extra = {}) => publishDaily({
      state, client, save: async () => { snapshots.push(structuredClone(state)); },
      ensureEntry: async (...args) => { entries.push(args); return siteFile; },
      file: "/fake/video.mp4", size: 100, wait: async () => {}, maxPolls: 2, log: () => {}, ...extra,
    }),
  };
}
async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "daily-publisher-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("metadata rejects invalid dates, titles, solutions, captions and audience flags", () => {
  validateMetadata(metadata, []);
  for (const date of ["2026-02-30", "2026-13-01", "not-a-date"]) {
    assert.throws(() => validateMetadata({ ...metadata, date }, []), /real date/);
  }
  assert.throws(() => validateMetadata({ ...metadata, title: " " }, []), /title/);
  assert.throws(() => validateMetadata({ ...metadata, solution: "missing" }, []), /Unknown solution/);
  assert.throws(() => validateMetadata({ ...metadata, caption: "x".repeat(2201) }, []), /caption/);
  assert.throws(() => validateMetadata({ ...metadata, youtubeTitle: "x".repeat(101) }, []), /YouTube title/);
  assert.throws(() => validateMetadata({ ...metadata, youtubeTitle: "<video>" }, []), /YouTube title/);
  assert.throws(() => validateMetadata({ ...metadata, madeForKids: "false" }, []), /made-for-kids/);
});

test("video validation handles phone rotation and rejects non-Shorts media", () => {
  const info = { streams: [{ codec_type: "video", width: 1080, height: 1920 }], format: { duration: "60" } };
  assert.deepEqual(validateVideo(info, 100, ".mp4"), { width: 1080, height: 1920, duration: 60 });
  const rotated = { streams: [{ codec_type: "video", width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }], format: { duration: "60" } };
  assert.equal(validateVideo(rotated, 100, ".mov").height, 1920);
  assert.throws(() => validateVideo(info, 300_000_001, ".mp4"), /300 MB/);
  assert.throws(() => validateVideo(info, 100, ".webm"), /MP4 or MOV/);
  assert.throws(() => validateVideo({ ...info, format: { duration: "91" } }, 100, ".mp4"), /3–90/);
  assert.throws(() => validateVideo({ ...info, streams: [{ codec_type: "video", width: 1920, height: 1080 }] }, 100, ".mp4"), /portrait/);
});

test("account selection refuses ambiguous, inactive or wrong-platform IDs", () => {
  const accounts = [{ _id: "ig", platform: "instagram", isActive: true }, { _id: "yt", platform: "youtube", isActive: true }];
  assert.equal(selectAccounts(accounts).youtube.id, "yt");
  assert.throws(() => selectAccounts([...accounts, { ...accounts[0], _id: "ig2" }]), /found 2/);
  assert.equal(selectAccounts([...accounts, { ...accounts[0], _id: "ig2" }], { instagram: "ig2" }).instagram.id, "ig2");
  assert.throws(() => selectAccounts(accounts, { instagram: "yt" }), /found 0/);
  assert.throws(() => selectAccounts([{ ...accounts[0], isActive: false }, accounts[1]]), /found 0/);
});

test("request targets only Instagram Reels and public YouTube with explicit audience", () => {
  const state = { ...freshState(), mediaUrl };
  const body = postBody(state);
  assert.equal(body.publishNow, true);
  assert.deepEqual(body.platforms.map((target) => target.platform), ["instagram", "youtube"]);
  assert.deepEqual(body.platforms[0].platformSpecificData, { shareToFeed: true });
  assert.deepEqual(body.platforms[1].platformSpecificData, { title: "Day 11", visibility: "public", madeForKids: false });
  assert.equal(body.mediaItems[0].url, mediaUrl);
  assert.equal(body.metadata.dailyVideoHash, state.videoHash);
});

test("publishes once, saves before submission, and passes the Instagram URL to the website", async () => {
  const h = harness();
  await h.run();
  assert.equal(h.calls[0], "upload");
  assert.equal(h.calls[1].endpoint, "/posts");
  assert.equal(h.calls[1].options.requestId, "request-id");
  assert.equal(h.snapshots[1].submitStarted, true);
  assert.equal(h.snapshots[1].postId, undefined);
  assert.deepEqual(h.entries, [[instagramUrl, metadata]]);
  assert.equal(h.state.siteFile, siteFile);
  assert.equal(h.state.postId, "post-id");
});

test("rerunning published video only reads its existing post and checks its website entry", async () => {
  const state = { ...freshState(), mediaUrl, submitStarted: true, postId: "post-id", siteFile };
  const h = harness(state);
  await h.run();
  assert.deepEqual(h.calls, [{ endpoint: "/posts/post-id", options: undefined }]);
  assert.equal(h.entries.length, 1);
});

test("Instagram success still creates the website entry when YouTube fails", async () => {
  const h = harness(freshState(), [post("published", "failed", "partial")]);
  await assert.rejects(h.run(), /youtube: YouTube error/);
  assert.equal(h.state.siteFile, siteFile);
  assert.equal(h.state.postId, "post-id");
});

test("Instagram failure creates no website entry and preserves YouTube success", async () => {
  const h = harness(freshState(), [post("failed", "published", "partial")]);
  await assert.rejects(h.run(), /instagram: failed/);
  assert.equal(h.entries.length, 0);
  assert.equal(h.state.post.platforms[1].status, "published");
});

test("retry uses the existing-post endpoint, never a new create or upload", async () => {
  const state = { ...freshState(), mediaUrl, submitStarted: true, postId: "post-id" };
  const h = harness(state, [post("published", "failed", "partial"), post()]);
  await h.run({ retryFailed: true });
  assert.deepEqual(h.calls.map((call) => call.endpoint), ["/posts/post-id", "/posts/post-id/retry"]);
  assert.equal(h.state.post.status, "published");
});

test("scheduled transient failures are polled, not treated as permanent failures", async () => {
  const h = harness(freshState(), [post("pending", "pending", "scheduled"), post()]);
  await h.run();
  assert.equal(h.state.siteFile, siteFile);
});

test("published without a permalink keeps polling and never passes an empty URL", async () => {
  const missing = post();
  delete missing.platforms[0].platformPostUrl;
  const h = harness(freshState(), [missing, post()]);
  await h.run();
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0][0], instagramUrl);
});

test("poll timeout keeps the post ID for a safe rerun", async () => {
  const h = harness(freshState(), [post("processing", "processing", "publishing")]);
  await assert.rejects(h.run({ maxPolls: 0 }), /Still waiting/);
  assert.equal(h.state.postId, "post-id");
  assert.equal(h.state.siteFile, undefined);
});

test("lost publish response blocks a second create even long after idempotency expires", async () => {
  const h = harness(freshState(), [new Error("Connection lost")]);
  await assert.rejects(h.run(), /Connection lost/);
  assert.equal(h.state.submitStarted, true);
  const resumed = harness(h.state, []);
  await assert.rejects(resumed.run(), /unknown outcome/);
  assert.equal(resumed.calls.length, 0);
});

test("validation rejection can be retried without uploading the same media again", async () => {
  const error = Object.assign(new Error("Bad request"), { status: 400 });
  const h = harness(freshState(), [error]);
  await assert.rejects(h.run(), /Bad request/);
  assert.equal(h.state.submitStarted, false);
  assert.equal(h.state.mediaUrl, mediaUrl);
  const resumed = harness(h.state);
  await resumed.run();
  assert.equal(resumed.calls.some((call) => call === "upload"), false);
});

test("lost-response recovery verifies the original video before attaching a post", async () => {
  const state = { ...freshState(), mediaUrl, submitStarted: true };
  const h = harness(state, [post(), post()]);
  await h.run({ resumePost: "post-id" });
  assert.equal(h.calls.every((call) => call.endpoint === "/posts/post-id"), true);
  assert.equal(h.state.siteFile, siteFile);
  const wrong = post();
  wrong.metadata.dailyVideoHash = "another-video";
  const rejected = harness({ ...freshState(), mediaUrl, submitStarted: true }, [wrong]);
  await assert.rejects(rejected.run({ resumePost: "wrong-id" }), /does not match/);
  assert.equal(rejected.state.postId, undefined);
});

test("existingPost idempotency response is accepted", async () => {
  const h = harness();
  h.client.request = async () => ({ existingPost: post() });
  await h.run();
  assert.equal(h.state.postId, "post-id");
});

test("content-dedup conflict recovers the existing post from details.existingPostId", async () => {
  const error = Object.assign(new Error("Duplicate"), { status: 409, data: { details: { existingPostId: "post-id" } } });
  const h = harness(freshState(), [error, post()]);
  await h.run();
  assert.equal(h.state.siteFile, siteFile);
  assert.equal(h.calls.at(-1).endpoint, "/posts/post-id");
});

test("HTTP 207 is decoded for the workflow, and API errors retain status without the key", async () => {
  const calls = [];
  const client = createClient("secret-key", async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ post: post("published", "failed", "partial") }), { status: 207 });
  });
  const data = await client.request("/posts", { method: "POST", body: {}, requestId: "request-id" });
  assert.equal(data.post.status, "partial");
  assert.equal(calls[0].url, "https://zernio.com/api/v1/posts");
  assert.equal(calls[0].options.headers["x-request-id"], "request-id");
  const failed = createClient("secret-key", async () => new Response(JSON.stringify({ error: "Expired token" }), { status: 401 }));
  await assert.rejects(failed.request("/accounts"), (error) => error.status === 401 && !error.message.includes("secret-key"));
});

test("presigned upload uses correct fields and never forwards the API key to storage", async (t) => {
  const dir = await temporary(t);
  const file = path.join(dir, "video.mp4");
  await writeFile(file, "video");
  const calls = [];
  const client = createClient("secret-key", async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/media/presign")) return new Response(JSON.stringify({ uploadUrl: "https://storage.example.test/signed", publicUrl: mediaUrl }));
    let bytes = "";
    for await (const chunk of options.body) bytes += chunk;
    assert.equal(bytes, "video");
    return new Response(null, { status: 200 });
  });
  assert.equal(await client.upload(file, 5), mediaUrl);
  assert.deepEqual(JSON.parse(calls[0].options.body), { filename: "video.mp4", contentType: "video/mp4", size: 5 });
  assert.deepEqual(calls[1].options.headers, { "Content-Type": "video/mp4", "Content-Length": "5" });
});

test("post account mismatch is refused, including populated account objects", () => {
  const wrong = post();
  wrong.platforms[0].accountId = { _id: "wrong" };
  assert.throws(() => acceptPost(freshState(), wrong), /does not match/);
});

test("state writes are atomic and retain original metadata", async (t) => {
  const dir = await temporary(t);
  const file = path.join(dir, "state.json");
  await saveState(file, freshState());
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), freshState());
  assert.deepEqual(await readdir(dir), ["state.json"]);
});

test("new-daily integration writes real Markdown exactly once and recovers an unsaved result", async (t) => {
  const dir = await temporary(t);
  await mkdir(path.join(dir, "scripts"));
  await mkdir(path.join(dir, "src/content/daily"), { recursive: true });
  await mkdir(path.join(dir, "src/content/solutions"));
  await copyFile(path.join(root, "scripts/new-daily.mjs"), path.join(dir, "scripts/new-daily.mjs"));
  const first = await ensureDailyEntry(dir, instagramUrl, metadata);
  assert.equal(first, siteFile);
  const text = await readFile(path.join(dir, first), "utf8");
  assert.match(text, /title: "A useful tool"/);
  assert.match(text, /instagramUrl: "https:\/\/www.instagram.com\/reel\/TEST123\/"/);
  assert.match(text, /A teacher's idea/);
  assert.equal(await ensureDailyEntry(dir, instagramUrl, metadata), first);
  assert.equal((await readdir(path.join(dir, "src/content/daily"))).length, 1);
  const second = await ensureDailyEntry(dir, "https://www.instagram.com/reel/OTHER/", metadata);
  assert.equal(second, "src/content/daily/2026-09-11-2.md");
});

test("deployment commits only the entry, pushes locally, and refuses unrelated changes", async (t) => {
  const dir = await temporary(t);
  const remote = path.join(dir, "remote.git");
  const repo = path.join(dir, "site");
  await mkdir(repo);
  const git = async (...args) => (await exec("git", args, { cwd: repo })).stdout.trim();
  await exec("git", ["init", "--bare", remote]);
  await git("init", "-b", "main");
  await git("config", "user.name", "Publisher Test");
  await git("config", "user.email", "publisher@example.test");
  await git("config", "commit.gpgsign", "false");
  await git("config", "core.hooksPath", path.join(dir, "no-hooks"));
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ scripts: { build: "node -e \"process.exit(0)\"" } }));
  await git("add", "package.json");
  await git("commit", "-m", "Fixture");
  await git("remote", "add", "origin", remote);
  await git("push", "-u", "origin", "main");
  await checkDeployment(repo);
  await writeFile(path.join(repo, "unrelated.txt"), "Do not commit me");
  await assert.rejects(checkDeployment(repo), /clean working tree/);
  await rm(path.join(repo, "unrelated.txt"));
  await mkdir(path.join(repo, "src/content/daily"), { recursive: true });
  await writeFile(path.join(repo, siteFile), "A fixture entry");
  await deployEntry(repo, siteFile, () => {});
  assert.equal(await git("status", "--porcelain"), "");
  assert.equal(await git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"), siteFile);
  assert.equal(await git("rev-parse", "HEAD"), await git("rev-parse", "origin/main"));
  assert.match(await git("log", "-1", "--format=%B"), /Co-Authored-By: Claude Code/);
  const firstCommit = await git("rev-parse", "HEAD");
  await deployEntry(repo, siteFile, () => {});
  assert.equal(await git("rev-parse", "HEAD"), firstCommit);
  await writeFile(path.join(repo, "unrelated.txt"), "Unrelated commit");
  await git("add", "unrelated.txt");
  await git("commit", "-m", "Unrelated");
  await assert.rejects(checkDeployment(repo, siteFile), /unrelated local commits/);
});

test("help is usable without credentials and describes the publication boundary", async () => {
  const { stdout } = await exec(process.execPath, [path.join(root, "scripts/publish-daily.mjs"), "--help"]);
  assert.match(stdout, /--deploy/);
  assert.match(stdout, /--dry-run/);
});
