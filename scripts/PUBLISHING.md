# Daily video publishing

One command publishes your original video to **Instagram Reels, YouTube and
TikTok**, then passes the published Instagram link to `scripts/new-daily.mjs`. Add
`--deploy` to build the website, commit just that day's entry, and push `main`,
triggering the site's existing automatic deployment.

## One-time setup

1. In [Zernio](https://zernio.com), connect your Instagram **Business or Creator**
   account, your YouTube channel and your TikTok account. Create an API key with
   access to all three.
2. Copy `.env.publish.example` to `.env.publish` and fill in `ZERNIO_API_KEY`.
   This file is gitignored; do not put your key in a command, commit, or chat.
3. Run:

   ```bash
   npm run publish-daily -- --accounts
   ```

   If there is exactly one active account per platform, it is selected
   automatically. Otherwise, set the account IDs in `.env.publish`.
4. Install Node **22.12+** and **FFmpeg** (the command uses `ffprobe`).
5. To use `--deploy`, first commit/merge the publisher implementation onto `main`,
   tracking `origin/main`. Your working tree must be clean except for the daily
   entry this run creates. Git authentication and commit identity must already work.

`.env.publish` is loaded by the CLI only, not by the website. Existing shell
environment variables take precedence. No new npm dependencies are needed.

## Everyday use

Keep the original video outside the repository (or in the gitignored
`.daily-publish/` folder), so it is not accidentally committed or treated as an
unrelated untracked file by `--deploy`.

```bash
npm run publish-daily -- /path/to/day-11.mp4 --deploy
```

The command asks for:

- A website title completing **“We built …”**.
- A solution ID, or `none`.
- An optional website note.
- An Instagram/TikTok caption (Enter uses the website title).
- A separate YouTube title (Enter uses the website title).
- Whether the video is **directed at children**, for YouTube's made-for-kids flag.
- An optional **thumbnail image** for the Instagram Reel and TikTok cover (Enter skips it).
  A video aimed at teachers is not automatically child-directed because it is
  about education; choose the flag for the video's actual audience.

Then it previews the accounts, video, caption, public visibility, and website
changes, and asks you to type `yes`. Nothing is uploaded before confirmation.
The date defaults to today in your computer's local timezone.

Instagram's caption and YouTube's title are asked separately. You can skip those
questions with `--caption` (or `--caption-file`) and `--youtube-title`. The Instagram
caption is also TikTok's caption and YouTube's description. With `--yes`, both
default to the website title if their flags are omitted.

### TikTok

TikTok posts are **public**. TikTok's API requires explicit values for the
comment, duet and stitch toggles, so just before publishing the command reads
Zernio's creator-info endpoint and allows each interaction your TikTok account
permits (turn one off in the TikTok app to disable it). The two consent flags
TikTok requires (`content_preview_confirmed` and `express_consent_given`) are
sent as `true`: this command's preview and `yes` confirmation are your review of
the post. TikTok's own duration, size and caption limits are looser than the
checks below, so nothing extra is validated.

TikTok reports the post as `published` a little before it exposes the video's
public link, so the command does not wait for the TikTok URL. When it is still
missing at the end of a run, find the video in Zernio or the TikTok app.

### Fully unattended

```bash
npm run publish-daily -- /path/to/day-11.mp4 \
  --title "a math facts drill website" \
  --solution math-library \
  --date 2026-09-11 \
  --note "A quick way to practice multiplication facts." \
  --caption-file /path/to/caption.txt \
  --youtube-title "Day 11: A math facts drill website" \
  --made-for-kids false \
  --thumbnail /path/to/cover.jpg \
  --yes --deploy
```

Use a real solution ID listed by the interactive command (or `none`); the
`math-library` name above is illustrative. `--caption "Your caption"` is also
supported. With `--yes`, missing title, solution, or audience flags are errors;
the note defaults to empty and the caption defaults to the title.

### Preview without posting

```bash
npm run publish-daily -- /path/to/day-11.mp4 \
  --title "a math facts drill website" --solution none \
  --made-for-kids false --yes --dry-run
```

`--dry-run` validates the video and website metadata locally and shows the
preview. It makes **no API calls, uploads, posts, or file writes**, and does not
need an API key. It cannot check account authorization or platform-side rules.
With `--deploy --dry-run`, it also checks local Git readiness but does not build,
commit, or push.

## Video requirements

The command checks MP4/MOV format, a nonempty file up to **300 MB**, portrait
orientation, and **3–90 seconds**, matching the shared limits in Zernio's current
Instagram documentation. Recommended export: **1080 × 1920, H.264 video, AAC audio**.
Phone rotation metadata is taken into account. There is no transcoding or
platform music selection: captions, voiceover, music and subtitles should
already be baked into the original video, with appropriate rights for all three
platforms.

A single video is automatically a Reel on Instagram (also shared to the main
feed). YouTube determines Shorts classification from the video's shape and
length; there is no “Shorts” API flag. TikTok posts the same file as a video
post. This tool uploads publicly. Normal platform
processing, moderation and copyright checks still apply; Zernio reporting
`published` does not guarantee playback is immediately ready or restrictions
cannot be added later.

The website continues to use its existing Instagram embed. It does not host a
second copy of the video or add a YouTube player.

## Thumbnails

`--thumbnail /path/to/cover.jpg` sets the **Instagram Reel cover and the TikTok
cover** (the same uploaded image is passed to both). Pass `--thumbnail none` (or
press Enter at the prompt) to let Instagram and TikTok use a frame of the video
instead.

**YouTube Shorts cannot take a custom thumbnail through the API.** Zernio's
documentation states plainly that “custom thumbnails are not supported for Shorts
through the API”, so this command does not send one to YouTube; the same image
cannot serve all three. YouTube picks a frame automatically; to override it,
open the Short in YouTube Studio or the YouTube app and edit it there. A video
over 3 minutes or in landscape would be a regular video rather than a Short and
could take a cover, but such a video is outside what this command accepts.

The image must be **JPG or PNG**, nonempty, and at most **8 MB**. The command
checks the real image data, not just the filename, so a renamed or mislabelled
file is rejected before anything is uploaded. Instagram recommends **1080 × 1920**
(9:16); other sizes are accepted and cropped by Instagram.

The cover is uploaded before the video, so a failure here costs nothing. Once the
post has been submitted, the cover is frozen: rerunning with a different
`--thumbnail` is refused rather than silently ignored or republished. Change a
published cover in the Instagram or TikTok app.

## Safe retries and recovery

Progress is stored in `.daily-publish/<video-sha256>.json`, including the original
metadata, account IDs, media and cover URLs, Zernio post ID, platform statuses and
website filename. API keys and account tokens are not stored there. The video hash makes
the same video recognizable even if you rename it or run again tomorrow.

**Keep this directory and back it up privately.** Deleting it, changing machines
without copying it, or re-encoding the video removes the local duplicate guard.
Zernio's server-side duplicate protection has limited time windows and is not a
substitute for this state. Saved caption/media URLs may be sensitive; the folder
is gitignored and created with owner-only permissions where supported.

- **Slow publishing / timeout after getting a post ID:** rerun the same command.
  It checks the existing post instead of creating another one. The command polls
  every 10 seconds for up to 20 minutes after submission (individual API calls
  have their own timeouts).
- **Instagram succeeds but YouTube or TikTok fails:** the website entry is still
  created; `--deploy` still publishes that entry. The command exits unsuccessfully
  and reports the failing platform's error. Fix the problem (for example, reconnect
  the account) and rerun with `--retry-failed`. Zernio's retry endpoint skips
  published targets.
- **Progress saved before TikTok support:** a video whose progress file has no
  TikTok account keeps its original Instagram + YouTube targets when rerun. Publish
  it to TikTok by hand if wanted; do not delete the progress file.
- **Website build, commit or push fails:** social progress is kept. Fix the local
  problem and rerun with `--deploy`. An already committed daily entry can be pushed
  on the next run without creating another commit. The script refuses to push
  unrelated changes or unrelated unpushed commits.
- **Lost response during the initial publish:** the script deliberately refuses
  to submit a new post, since the first request may have published. Locate the
  post in Zernio and rerun the original command with `--resume-post <Zernio-post-id>`.
  The command verifies that post's saved video hash and media URL. If Zernio
  confirms no post exists, inspect the saved JSON before clearing only its
  `submitStarted` flag; do not delete the whole progress file or clear it while
  the original request may still be running.
- **Changed metadata after submission:** the command stops rather than silently
  ignoring changes or publishing another copy. Rerun without the changed flags;
  edit published metadata in Zernio/the platform and website Markdown separately.
  Before submission (including a definite validation rejection), you can correct
  metadata with flags and reuse the uploaded media.
- **Killed process / stale lock:** ordinary exits, Ctrl-C and SIGTERM remove the
  lock. SIGKILL or a machine crash may leave `.daily-publish/lock`. Read its PID
  and verify no publisher is running before deleting **only that lock file**.
  Run this tool from one machine at a time; locks are local, not distributed.

No live posts are made by the automated tests. Run `npm test` for mocked API,
recovery and temporary-repository tests; `npm run build` checks the website.

## Deployment boundary

Without `--deploy`, the command creates local Markdown only. With it, the command
builds, commits only `src/content/daily/<date>.md` (including same-day suffixes),
and pushes `HEAD:main` to `origin`. It does not force-push or commit unrelated
work. Git hooks and remote branch protections still apply. A successful push
**triggers** your hosting provider's deployment; this command does not monitor
that deployment or claim that the live site has finished updating.

## API references

- [Full Zernio documentation](https://docs.zernio.com/llms-full.txt)
- [Media uploads](https://docs.zernio.com/guides/media-uploads)
- [Create post](https://docs.zernio.com/posts/create-post)
- [Idempotency](https://docs.zernio.com/guides/idempotency)
- [Instagram](https://docs.zernio.com/platforms/instagram)
- [YouTube](https://docs.zernio.com/platforms/youtube)
- [TikTok](https://docs.zernio.com/platforms/tiktok)

- [Retry failed post](https://docs.zernio.com/posts/retry-post)
