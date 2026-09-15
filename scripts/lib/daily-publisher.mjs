import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";

const exec = promisify(execFile);
export const platforms = ["instagram", "youtube", "tiktok"];

export function validateMetadata(metadata, solutions) {
  if (!metadata.title?.trim()) throw new Error("A website title is required.");
  const date = new Date(`${metadata.date}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(metadata.date) || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== metadata.date) {
    throw new Error("Use a real date in YYYY-MM-DD format.");
  }
  if (metadata.solution !== "none" && !solutions.includes(metadata.solution)) {
    throw new Error(`Unknown solution: ${metadata.solution}. Choose ${solutions.join(", ")}, or none.`);
  }
  if (!metadata.caption?.trim() || [...metadata.caption].length > 2200) {
    throw new Error("The caption must contain 1–2,200 characters (Instagram's limit).");
  }
  if (!metadata.youtubeTitle?.trim() || [...metadata.youtubeTitle].length > 100 || /[<>\r\n]/.test(metadata.youtubeTitle)) {
    throw new Error("The YouTube title must be one line, 1–100 characters, without < or >.");
  }
  if (typeof metadata.madeForKids !== "boolean") {
    throw new Error("Specify --made-for-kids true or false (whether the video is directed at children).");
  }
}

export function validateVideo(info, size, extension) {
  if (![".mp4", ".mov"].includes(extension)) throw new Error("Use an MP4 or MOV video.");
  if (!size || size > 300_000_000) throw new Error("The video must be nonempty and at most 300 MB.");
  const stream = info.streams?.find((item) => item.codec_type === "video");
  const duration = Number(info.format?.duration ?? stream?.duration);
  if (!stream || !Number.isFinite(duration) || duration < 3 || duration > 90) {
    throw new Error("Use a 3–90 second video, within Zernio's documented Reel limit.");
  }
  const rotation = Number(stream.side_data_list?.find((item) => item.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0);
  const rotated = Math.abs(rotation) % 180 === 90;
  const width = rotated ? stream.height : stream.width;
  const height = rotated ? stream.width : stream.height;
  if (!(height > width && width > 0)) throw new Error("Use a portrait video for Reels and Shorts (9:16 recommended).");
  return { width, height, duration };
}

export async function inspectVideo(file, size) {
  let stdout;
  try {
    ({ stdout } = await exec("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { timeout: 30_000 }));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Install FFmpeg (including ffprobe) to validate video dimensions and duration.");
    throw new Error("ffprobe could not read this video. Check that it is a valid MP4 or MOV.");
  }
  return validateVideo(JSON.parse(stdout), size, path.extname(file).toLowerCase());
}

export function validateThumbnail(info, size, extension) {
  const codec = { ".jpg": "mjpeg", ".jpeg": "mjpeg", ".png": "png" }[extension];
  if (!codec) throw new Error("Use a JPG or PNG thumbnail image.");
  if (!size || size > 8_000_000) throw new Error("The thumbnail must be nonempty and at most 8 MB.");
  const stream = info.streams?.find((item) => item.codec_type === "video");
  if (stream?.codec_name !== codec || !(stream.width > 0 && stream.height > 0)) {
    throw new Error("The thumbnail must be a valid JPG or PNG image matching its filename extension.");
  }
  return { width: stream.width, height: stream.height };
}

export async function inspectThumbnail(file) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error("The thumbnail path must be a file.");
  if (!info.size || info.size > 8_000_000) throw new Error("The thumbnail must be nonempty and at most 8 MB.");
  let stdout;
  try {
    ({ stdout } = await exec("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], { timeout: 30_000 }));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Install FFmpeg (including ffprobe) to validate the thumbnail.");
    throw new Error("ffprobe could not read the thumbnail. Use a valid JPG or PNG image.");
  }
  const dimensions = validateThumbnail(JSON.parse(stdout), info.size, path.extname(file).toLowerCase());
  return { file, size: info.size, hash: await hashFile(file), ...dimensions };
}

export async function prepareThumbnail(previous, input, inspect = inspectThumbnail) {
  const thumbnail = input === undefined ? previous?.thumbnail ?? null
    : !input.trim() || input.trim().toLowerCase() === "none" ? null : await inspect(path.resolve(input));
  const thumbnailChanged = (thumbnail?.hash ?? null) !== (previous?.thumbnail?.hash ?? null);
  if (thumbnailChanged && (previous?.submitStarted || previous?.postId)) {
    throw new Error("This video was already submitted. Its thumbnail cannot be added, changed or removed by resubmitting; edit the cover in Instagram and TikTok instead.");
  }
  // An already uploaded cover can be reused even if its local file was moved or deleted.
  if (thumbnail && input === undefined && !previous?.thumbnailUrl && !previous?.submitStarted && !previous?.postId) {
    const current = await inspect(thumbnail.file);
    if (current.hash !== thumbnail.hash) throw new Error("The saved thumbnail file changed. Pass --thumbnail explicitly to select the new image before publishing.");
  }
  return { thumbnail, thumbnailChanged };
}

export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function saveState(file, state) {
  await writeFile(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

export function selectAccounts(accounts, configured = {}) {
  return Object.fromEntries(platforms.map((platform) => {
    const matches = accounts.filter((account) => account.platform === platform && account.isActive !== false && account.enabled !== false &&
      (!configured[platform] || account._id === configured[platform]));
    if (matches.length !== 1) {
      throw new Error(`Expected one active ${platform} account; found ${matches.length}. Connect it in Zernio, run --accounts, and set ZERNIO_${platform.toUpperCase()}_ACCOUNT_ID in .env.publish.`);
    }
    return [platform, { id: matches[0]._id, name: matches[0].username || matches[0].displayName || matches[0]._id }];
  }));
}

// TikTok forbids defaulting its interaction toggles and only accepts privacy levels the creator allows,
// so the settings come from Zernio's creator-info endpoint. Every interaction the creator permits is enabled.
export function tiktokSettings(info) {
  if (!info?.privacyLevels?.some((level) => level.value === "PUBLIC_TO_EVERYONE")) {
    throw new Error("TikTok does not allow public posts from this account right now. Check the account's privacy settings in the TikTok app.");
  }
  if (info.creator?.canPostMore === false) throw new Error("TikTok reports this account cannot post more right now (daily API posting limit). Try again later.");
  const toggles = info.postingLimits?.interactionSettings ?? {};
  return Object.fromEntries(["allow_comment", "allow_duet", "allow_stitch"].map((name) => [name, toggles[name]?.enabled !== false]));
}

// Progress saved before TikTok support has only Instagram and YouTube accounts; it keeps those targets.
export function targetPlatforms(state) {
  return platforms.filter((platform) => state.accounts[platform]);
}

export function postBody(state) {
  return {
    content: state.metadata.caption,
    mediaItems: [{ type: "video", url: state.mediaUrl }],
    platforms: targetPlatforms(state).map((platform) => ({
      platform,
      accountId: state.accounts[platform].id,
      platformSpecificData: platform === "instagram" ? {
        shareToFeed: true,
        ...(state.thumbnailUrl ? { instagramThumbnail: state.thumbnailUrl } : {}),
      } : platform === "youtube" ? {
        title: state.metadata.youtubeTitle,
        visibility: "public",
        madeForKids: state.metadata.madeForKids,
      } : {
        tiktokSettings: {
          privacy_level: "PUBLIC_TO_EVERYONE",
          ...state.tiktok,
          ...(state.thumbnailUrl ? { video_cover_image_url: state.thumbnailUrl } : {}),
          content_preview_confirmed: true,
          express_consent_given: true,
        },
      },
    })),
    publishNow: true,
    metadata: { dailyVideoHash: state.videoHash },
  };
}

export function createClient(apiKey, fetchImpl = fetch) {
  if (!apiKey) throw new Error("Set ZERNIO_API_KEY in .env.publish first. See scripts/PUBLISHING.md.");
  return {
    async request(endpoint, { method = "GET", body, requestId } = {}) {
      const response = await fetchImpl(`https://zernio.com/api/v1${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(requestId ? { "x-request-id": requestId } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(method === "GET" ? 60_000 : 15 * 60_000),
        redirect: "error",
      });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(`Zernio HTTP ${response.status}: ${data.error || data.message || "Request failed"}`);
        error.status = response.status;
        error.data = data;
        throw error;
      }
      // 207 is a partial/failed publish, not proof of success. The caller checks each target.
      return data;
    },
    async upload(file, size) {
      const contentType = {
        ".mov": "video/quicktime", ".mp4": "video/mp4",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
      }[path.extname(file).toLowerCase()];
      if (!contentType) throw new Error("Unsupported media file extension.");
      const { uploadUrl, publicUrl } = await this.request("/media/presign", {
        method: "POST", body: { filename: path.basename(file), contentType, size },
      });
      if (new URL(uploadUrl).protocol !== "https:" || new URL(publicUrl).protocol !== "https:") {
        throw new Error("Zernio returned an invalid upload URL.");
      }
      // The storage URL is signed: never forward the Zernio API key to it.
      const stream = createReadStream(file);
      try {
        const response = await fetchImpl(uploadUrl, {
          method: "PUT", headers: { "Content-Type": contentType, "Content-Length": String(size) },
          body: stream, duplex: "half", signal: AbortSignal.timeout(15 * 60_000), redirect: "error",
        });
        if (!response.ok) throw new Error(`Media upload failed (HTTP ${response.status}).`);
      } finally {
        stream.destroy();
      }
      return publicUrl;
    },
  };
}

export function acceptPost(state, post) {
  if (!post?._id || !Array.isArray(post.platforms)) throw new Error("Zernio did not return a post ID and platform results.");
  for (const platform of targetPlatforms(state)) {
    const target = post.platforms.find((item) => item.platform === platform);
    const accountId = typeof target?.accountId === "object" ? target.accountId?._id : target?.accountId;
    if (!target || (accountId && accountId !== state.accounts[platform].id)) {
      throw new Error(`The returned post does not match the selected ${platform} account.`);
    }
  }
  state.postId = post._id;
  state.post = {
    status: post.status,
    platforms: post.platforms.map(({ platform, status, platformPostUrl, errorMessage }) => ({ platform, status, platformPostUrl, errorMessage })),
  };
}

export async function publishDaily({ state, save, client, file, size, ensureEntry, retryFailed = false, resumePost,
  wait = setTimeout, maxPolls = 120, log = console.log }) {
  if (resumePost) {
    if (!state.submitStarted || state.postId) throw new Error("--resume-post is only for a previous submission whose post ID was lost.");
    const { post } = await client.request(`/posts/${encodeURIComponent(resumePost)}`);
    // Do not attach a random dashboard post to this website entry.
    if (post?.metadata?.dailyVideoHash !== state.videoHash ||
        !post.mediaItems?.some((item) => item.url === state.mediaUrl)) {
      throw new Error("That post's video does not match this saved run.");
    }
    acceptPost(state, post);
    await save();
  }
  if (!state.postId) {
    if (state.submitStarted) {
      throw new Error("The last publish has an unknown outcome. Check Zernio for the post, then rerun with --resume-post <post-id>. Refusing to submit again and risk duplicates.");
    }
    if (state.accounts.tiktok && !state.tiktok) {
      log("Checking TikTok posting settings…");
      state.tiktok = tiktokSettings(await client.request(`/accounts/${encodeURIComponent(state.accounts.tiktok.id)}/tiktok/creator-info?mediaType=video`));
      await save();
    }
    if (state.thumbnail && !state.thumbnailUrl) {
      log("Uploading Instagram/TikTok cover image to Zernio…");
      state.thumbnailUrl = await client.upload(state.thumbnail.file, state.thumbnail.size);
      await save();
    }
    if (!state.mediaUrl) {
      log("Uploading video to Zernio…");
      state.mediaUrl = await client.upload(file, size);
      await save();
    }
    state.submitStarted = true;
    await save(); // Save before sending: a lost HTTP response must not cause a duplicate.
    log(`Publishing to ${targetPlatforms(state).join(", ")}…`);
    let data;
    try {
      data = await client.request("/posts", { method: "POST", body: postBody(state), requestId: state.requestId });
    } catch (error) {
      const existingId = error.data?.details?.existingPostId ?? error.data?.existingPostId;
      if (error.status === 409 && existingId) {
        data = await client.request(`/posts/${encodeURIComponent(existingId)}`);
        if (data.post?.metadata?.dailyVideoHash !== state.videoHash) throw error;
      } else {
        // Validation/auth/rate-limit rejections did not create a post. Network/5xx outcomes are ambiguous.
        if ([400, 401, 402, 403, 404, 413, 422, 429].includes(error.status)) {
          state.submitStarted = false;
          await save();
        }
        throw error;
      }
    }
    acceptPost(state, data.post ?? data.existingPost);
    await save();
    for (const warning of data.warnings ?? []) log(`Zernio warning: ${warning}`);
  } else {
    const { post } = await client.request(`/posts/${encodeURIComponent(state.postId)}`);
    acceptPost(state, post);
    await save();
  }

  if (retryFailed && ["failed", "partial"].includes(state.post.status)) {
    log("Retrying failed targets on the existing Zernio post…");
    const { post } = await client.request(`/posts/${encodeURIComponent(state.postId)}/retry`, { method: "POST" });
    acceptPost(state, post);
    await save();
  }

  let entryChecked = false;
  for (let attempt = 0; attempt <= maxPolls; attempt++) {
    const targets = targetPlatforms(state).map((platform) => state.post.platforms.find((item) => item.platform === platform));

    const instagram = targets[0];
    if (instagram.status === "published" && instagram.platformPostUrl && !entryChecked) {
      state.siteFile = await ensureEntry(instagram.platformPostUrl, state.metadata);
      entryChecked = true;
      await save();
      log(`Website entry: ${state.siteFile}`);
    }
    // TikTok resolves its public URL minutes after publishing; only Instagram's is needed (for the website entry).
    if (targets.every((item) => item.status === "published" && (item.platformPostUrl || item.platform === "tiktok")) && state.siteFile) return;

    const settled = targets.every((item) => ["published", "failed", "cancelled"].includes(item.status));
    if (settled && targets.some((item) => ["failed", "cancelled"].includes(item.status))) {
      const errors = targets.filter((item) => item.status !== "published").map((item) => `${item.platform}: ${item.errorMessage || item.status}`).join("\n");
      throw new Error(`${errors}\nSuccessful posts are saved. Fix the issue in Zernio, then rerun with --retry-failed (cancelled posts need attention in Zernio).`);
    }
    if (attempt === maxPolls) throw new Error(`Still waiting for publication/permalinks (${state.postId}). Rerun the same command to check again; it will not create another post.`);
    if (attempt % 6 === 0) log(`Waiting: ${targets.map((item) => `${item.platform} ${item.status}`).join(", ")}…`);
    await wait(10_000);
    const { post } = await client.request(`/posts/${encodeURIComponent(state.postId)}`);
    acceptPost(state, post);
    await save();
  }
}

export async function ensureDailyEntry(root, instagramUrl, metadata) {
  const match = /^https:\/\/(?:www\.)?instagram\.com\/(?:[\w.]+\/)?(?:reels?|p|tv)\/([\w-]+)\/?(?:[?#].*)?$/.exec(instagramUrl);
  if (!match) throw new Error("The published Instagram URL is not a supported Reel permalink.");
  const dir = path.join(root, "src/content/daily");
  async function findEntry() {
    for (const name of await readdir(dir)) {
      if (name.endsWith(".md") && (await readFile(path.join(dir, name), "utf8")).includes(`/${match[1]}/`)) {
        return `src/content/daily/${name}`;
      }
    }
  }
  // Recover from an interruption after new-daily wrote the file but before progress was saved.
  const existing = await findEntry();
  if (existing) return existing;
  await exec(process.execPath, [path.join(root, "scripts/new-daily.mjs"), instagramUrl,
    "--title", metadata.title, "--solution", metadata.solution, "--date", metadata.date, "--note", metadata.note], { cwd: root });
  const created = await findEntry();
  if (!created) throw new Error("new-daily.mjs finished but its entry could not be found.");
  return created;
}

export async function checkDeployment(root, siteFile) {
  const git = async (...args) => (await exec("git", args, { cwd: root })).stdout.trim();
  if (await git("branch", "--show-current") !== "main" || await git("rev-parse", "--abbrev-ref", "@{upstream}") !== "origin/main") {
    throw new Error("--deploy requires branch main tracking origin/main. Merge the publisher changes there first.");
  }
  const status = (await exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root })).stdout;
  if (status.split("\n").filter(Boolean).some((line) => !siteFile || line.slice(3) !== siteFile)) {
    throw new Error("--deploy requires a clean working tree except for this run's daily entry. Commit or stash other work first.");
  }
  const ahead = (await git("rev-list", "@{upstream}..HEAD")).split("\n").filter(Boolean);
  // A previous run may have committed the entry and then failed to push.
  if (ahead.length && (ahead.length !== 1 || !siteFile || await git("diff-tree", "--no-commit-id", "--name-only", "-r", ahead[0]) !== siteFile)) {
    throw new Error("--deploy will not push unrelated local commits. Push or resolve them yourself first.");
  }
}

export async function deployEntry(root, siteFile, log = console.log) {
  if (!/^src\/content\/daily\/\d{4}-\d{2}-\d{2}(?:-\d+)?\.md$/.test(siteFile)) throw new Error("Unexpected website entry path.");
  await checkDeployment(root, siteFile);
  log("Building the website before committing…");
  await exec("npm", ["run", "build"], { cwd: root, timeout: 120_000 });
  await checkDeployment(root, siteFile);
  const { stdout } = await exec("git", ["status", "--porcelain=v1", "--", siteFile], { cwd: root });
  if (stdout.trim()) {
    await exec("git", ["add", "--", siteFile], { cwd: root });
    await exec("git", ["commit", "--only", "-m", `feat: add daily video ${path.basename(siteFile, ".md")}\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>`, "--", siteFile], { cwd: root });
  }
  await checkDeployment(root, siteFile);
  await exec("git", ["push", "origin", "HEAD:main"], { cwd: root, timeout: 120_000 });
  log("Pushed the daily entry to main. Your host will deploy it; deployment completion has not been checked.");
}
