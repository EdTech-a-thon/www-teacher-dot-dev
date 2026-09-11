#!/usr/bin/env node
// Publish a local video to Instagram and YouTube, then run new-daily.mjs.
// See scripts/PUBLISHING.md for setup, unattended runs and recovery.
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  checkDeployment, createClient, deployEntry, ensureDailyEntry, hashFile, inspectVideo,
  platforms, publishDaily, saveState, selectAccounts, validateMetadata,
} from "./lib/daily-publisher.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = path.join(root, ".daily-publish");
let rl;
let lines;

async function ask(question) {
  if (!stdin.isTTY) throw new Error(`Missing an answer for: ${question.trim()} Pass the corresponding flag for unattended use.`);
  if (!rl) {
    rl = createInterface({ input: stdin, output: stdout });
    lines = rl[Symbol.asyncIterator]();
  }
  rl.setPrompt(question);
  rl.prompt();
  const { value, done } = await lines.next();
  if (done) throw new Error("Cancelled.");
  return value.trim();
}

async function readState(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function lock() {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, "lock");
  let handle;
  try { handle = await open(file, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error("Another publisher owns .daily-publish/lock. If it was killed, verify its PID is no longer running before removing only the lock file. See scripts/PUBLISHING.md.");
  }
  const cleanup = () => { try { unlinkSync(file); } catch {} };
  process.once("exit", cleanup);
  process.once("SIGINT", () => process.exit(130));
  process.once("SIGTERM", () => process.exit(143));
  await handle.writeFile(`${process.pid}\n`);
  await handle.close();
  return () => { cleanup(); process.removeListener("exit", cleanup); };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      title: { type: "string" }, solution: { type: "string" }, date: { type: "string" },
      note: { type: "string" }, caption: { type: "string" }, "caption-file": { type: "string" },
      "youtube-title": { type: "string" }, "made-for-kids": { type: "string" },
      "dry-run": { type: "boolean" }, yes: { type: "boolean", short: "y" },
      deploy: { type: "boolean" }, accounts: { type: "boolean" },
      "retry-failed": { type: "boolean" }, "resume-post": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(`Usage: npm run publish-daily -- <video.mp4> [options]

Publishes to Instagram Reels and YouTube, then creates the website entry.
Missing metadata is prompted for. Saved progress is reused for the same video.

  --title TEXT            Website title, completing "We built …"
  --solution ID|none      Solution to link on the website
  --date YYYY-MM-DD       Local date (defaults to today on a new run)
  --note TEXT             Optional website paragraph
  --caption TEXT         Caption shared by Instagram and YouTube
  --caption-file FILE    Read the caption from a UTF-8 text file instead
  --youtube-title TEXT   YouTube title (defaults to the website title)
  --made-for-kids BOOL   true or false; whether the video targets children
  --dry-run              Local preview only: no API calls, uploads or writes
  --yes, -y              Skip confirmation and optional prompts; required fields still need flags
  --deploy               Build, commit ONLY the daily entry, push main to trigger site deploy
  --accounts             List connected Instagram/YouTube accounts; no publishing
  --retry-failed         Retry failed targets on the existing post; skip published targets
  --resume-post ID       Recover a lost publish response using its Zernio post ID

Setup and examples: scripts/PUBLISHING.md`);
    return;
  }
  if (positionals.length > 1) throw new Error("Pass exactly one video file.");
  if (values.caption !== undefined && values["caption-file"] !== undefined) throw new Error("Use --caption OR --caption-file, not both.");
  if (values["made-for-kids"] !== undefined && !["true", "false"].includes(values["made-for-kids"])) {
    throw new Error("--made-for-kids must be true or false.");
  }
  if (values.accounts && (positionals.length || values["dry-run"])) throw new Error("Run --accounts separately, without a video or --dry-run.");
  try { loadEnvFile(path.join(root, ".env.publish")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  if (values.accounts) {
    const { accounts } = await createClient(process.env.ZERNIO_API_KEY).request("/accounts");
    for (const account of accounts.filter((item) => platforms.includes(item.platform))) {
      console.log(`${account.platform}\t${account._id}\t${account.username || account.displayName || ""}\t${account.isActive === false || account.enabled === false ? "unavailable" : "active"}`);
    }
    return;
  }

  const file = path.resolve(positionals[0] ?? await ask("Video file: "));
  const info = await stat(file);
  if (!info.isFile()) throw new Error("The video path must be a file.");
  const video = await inspectVideo(file, info.size);
  const videoHash = await hashFile(file);
  const stateFile = path.join(stateDir, `${videoHash}.json`);
  const release = values["dry-run"] ? () => {} : await lock();
  try {
    const previous = await readState(stateFile);
    if (previous && (previous.version !== 1 || previous.videoHash !== videoHash)) throw new Error("Unrecognized saved progress. Do not delete it: inspect it before trying another publish.");
    const saved = previous?.metadata;
    const solutions = (await readdir(path.join(root, "src/content/solutions"))).filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3));
    const required = async (value, question) => {
      if (value !== undefined) return value;
      if (values.yes) throw new Error(`Missing required metadata: ${question}`);
      return ask(question);
    };
    const title = (await required(values.title ?? saved?.title, 'Website title (finishes "We built …"): ')).trim();
    if (values.solution === undefined && !saved && !values.yes) console.log(`Solutions: ${solutions.join(", ")}`);
    const solution = (await required(values.solution ?? saved?.solution, "Solution ID, or none: ")).trim();
    const now = new Date();
    const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
    const date = values.date ?? saved?.date ?? today;
    const note = values.note ?? saved?.note ?? (values.yes ? "" : await ask("Website note (optional, Enter to skip): "));
    let caption = values["caption-file"] !== undefined ? (await readFile(path.resolve(values["caption-file"]), "utf8")).trim() : values.caption ?? saved?.caption;
    if (caption === undefined) caption = values.yes ? title : (await ask("Social caption (Enter to use title): ")) || title;
    const youtubeTitle = values["youtube-title"] ?? saved?.youtubeTitle ?? title;
    const kids = await required(values["made-for-kids"] ?? (saved ? String(saved.madeForKids) : undefined), "Is this video directed at children? (true/false; teacher-facing content is false): ");
    if (!["true", "false"].includes(kids)) throw new Error("Answer true or false for made-for-kids.");
    const metadata = { title, solution, date, note, caption, youtubeTitle, madeForKids: kids === "true" };
    validateMetadata(metadata, solutions);
    const metadataChanged = saved && Object.keys(metadata).some((key) => metadata[key] !== saved[key]);
    if (metadataChanged && (previous.submitStarted || previous.postId)) {
      throw new Error("This video already has submitted metadata. Rerun without changing those flags; edit published captions in Zernio and website entries separately.");
    }
    if (values["resume-post"] && !previous) throw new Error("--resume-post requires saved progress for this video.");
    if (values["retry-failed"] && !previous?.postId) throw new Error("--retry-failed requires a saved Zernio post ID.");
    const configured = {
      instagram: process.env.ZERNIO_INSTAGRAM_ACCOUNT_ID,
      youtube: process.env.ZERNIO_YOUTUBE_ACCOUNT_ID,
    };
    if (previous && platforms.some((platform) => configured[platform] && configured[platform] !== previous.accounts[platform].id)) {
      throw new Error("Configured accounts changed since this video was submitted. Restore the original account IDs before resuming.");
    }
    if (values.deploy) await checkDeployment(root, previous?.siteFile);
    const client = values["dry-run"] ? undefined : createClient(process.env.ZERNIO_API_KEY);
    const accounts = previous?.accounts ?? (values["dry-run"] ? Object.fromEntries(platforms.map((platform) => [platform, {
      id: configured[platform] || "(auto-detect on publish)", name: configured[platform] || "(auto-detect on publish)",
    }])) : selectAccounts((await client.request("/accounts")).accounts, configured));

    console.log(`\nVideo: ${file}\n${video.width} × ${video.height}, ${video.duration.toFixed(1)} seconds, ${(info.size / 1_000_000).toFixed(1)} MB`);
    for (const platform of platforms) {
      const account = accounts[platform];
      console.log(`${platform}: ${account.name}${account.name === account.id ? "" : ` (${account.id})`}`);
    }
    console.log(`Website: ${title}\nDate: ${date}\nSolution: ${solution}\nNote: ${note || "(none)"}\nYouTube title: ${youtubeTitle}\nYouTube: PUBLIC, made for kids: ${metadata.madeForKids}\n\nCaption:\n${caption}`);
    console.log(`\nWebsite publishing: ${values.deploy ? "build, commit daily entry and push main" : "create local entry only (add --deploy to push)"}`);
    if (previous) console.log(`Resuming saved progress${previous.postId ? `: ${previous.postId}` : ""}.`);
    if (values["dry-run"]) { console.log("\nDry run complete. No API calls, files written, uploads or posts."); return; }
    if (!values.yes && (await ask("\nProceed with these uploads/posts and website changes? Type yes: ")).toLowerCase() !== "yes") {
      console.log("Cancelled. Nothing uploaded or published."); return;
    }
    rl?.close();
    const state = previous ? { ...previous, metadata, requestId: metadataChanged ? randomUUID() : previous.requestId }
      : { version: 1, videoHash, metadata, accounts, requestId: randomUUID() };
    const save = () => saveState(stateFile, state);
    await save();
    console.log(`Progress: ${path.relative(root, stateFile)} (keep this file for safe retries)`);
    let publishError;
    try {
      await publishDaily({ state, save, client, file, size: info.size,
        ensureEntry: (url, data) => ensureDailyEntry(root, url, data),
        retryFailed: values["retry-failed"], resumePost: values["resume-post"],
      });
    } catch (error) { publishError = error; }
    for (const target of state.post?.platforms ?? []) {
      console.log(`${target.platform}: ${target.status}${target.platformPostUrl ? ` — ${target.platformPostUrl}` : ""}`);
    }
    if (state.siteFile) {
      console.log(`Website: ${state.siteFile}`);
      if (values.deploy) {
        try { await deployEntry(root, state.siteFile); }
        catch (error) { throw new Error(`${publishError ? `${publishError.message}\n` : ""}Website deployment failed: ${error.message}\nSocial progress is saved. Fix the issue and rerun with --deploy.`); }
      } else console.log("The website entry is local; commit and push it, or rerun with --deploy.");
    }
    if (publishError) throw publishError;
    console.log("\nInstagram and YouTube report published; the website entry is ready.");
  } finally { release(); }
}

try { await main(); }
catch (error) { console.error(`\n${error.message}`); process.exitCode = 1; }
finally { rl?.close(); }
