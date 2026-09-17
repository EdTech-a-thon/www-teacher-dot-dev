import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

// The bundled tab script carries a blockquote template of its own, so counting
// only works against a concrete permalink.
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

test('solution social content plays Reels inline and links out, never leaking private fields', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'teacher-social-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'src/content/solutions'), { recursive: true });
  await mkdir(path.join(dir, 'src/pages'), { recursive: true });
  await mkdir(path.join(dir, 'src/components'), { recursive: true });
  await symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  await copyFile(path.join(root, 'src/content.config.ts'), path.join(dir, 'src/content.config.ts'));
  await copyFile(path.join(root, 'src/components/SocialPosts.astro'), path.join(dir, 'src/components/SocialPosts.astro'));
  await copyFile(path.join(root, 'src/components/ReelTabs.astro'), path.join(dir, 'src/components/ReelTabs.astro'));
  // Instagram posts are played inline by ReelTabs; everything else links out.
  await writeFile(path.join(dir, 'src/pages/index.astro'), `---
import { getCollection } from 'astro:content';
import ReelTabs from '../components/ReelTabs.astro';
import SocialPosts from '../components/SocialPosts.astro';
const rows = await getCollection('solutions');
const reels = (row) => row.data.crmSocialPosts
  .filter((post) => post.platform === 'instagram')
  .map((post, index) => ({ url: post.url, label: \`Reel \${index + 1}\`, title: row.data.title, href: '' }));
---
{rows.map(row => (
  <>
    <ReelTabs reels={reels(row)} name={row.data.title} />
    <SocialPosts posts={row.data.crmSocialPosts} />
  </>
))}
`);
  const content = path.join(dir, 'src/content/solutions/example.md');
  const instagram = 'https://www.instagram.com/p/Test123/';
  const tiktok = 'https://www.tiktok.com/@teacher/video/123456789';
  const fields = [
    { platform: 'instagram', url: instagram, group: 'a1b2c3d4', body: 'PRIVATE DM' },
    { platform: 'tiktok', url: tiktok, group: 'a1b2c3d4', notes: 'PRIVATE NOTES' },
  ];
  await writeFile(content, `---\ntitle: Example solution\ncompletedAt: "2026-09-01"\ncrmSocialPosts: ${JSON.stringify(fields)}\n---\n`);
  const build = () => exec(process.execPath, [path.join(root, 'node_modules/astro/bin/astro.mjs'), 'build', '--root', dir], {
    cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, ASTRO_TELEMETRY_DISABLED: '1' },
  });
  await build();
  const html = await readFile(path.join(dir, 'dist/index.html'), 'utf8');
  assert.match(html, /Watch the reel/);
  assert.match(html, /Also watch/);
  // The Reel's permalink is the embed target and the no-JS fallback link.
  assert.ok(html.includes(`data-instgrm-permalink="${instagram}"`), 'Instagram embed');
  assert.ok(html.includes(`href="${instagram}"`), 'Instagram fallback link');
  assert.ok(html.includes(`href="${tiktok}"`), 'TikTok link');
  // Instagram's own embed.js swaps in the player, so nothing ships an iframe.
  assert.equal(html.includes('<iframe'), false, 'No iframes are served');
  assert.equal(html.includes('See it on social'), false);
  assert.equal(html.includes('PRIVATE'), false);

  // Unconnected posts stay separate, each offered on its own terms.
  await writeFile(content, `---\ntitle: Example solution\ncompletedAt: "2026-09-01"\ncrmSocialPosts: ${JSON.stringify(
    fields.map(({ group, ...rest }) => rest),
  )}\n---\n`);
  await build();
  const separate = await readFile(path.join(dir, 'dist/index.html'), 'utf8');
  assert.equal(countOf(separate, `data-instgrm-permalink="${instagram}"`), 1);
  assert.equal((separate.match(/Watch on TikTok/g) || []).length, 1);
  assert.equal(separate.includes('PRIVATE'), false);

  // A fabricated cluster tag is refused rather than silently rendered.
  await writeFile(content, '---\ntitle: Bad group\ncompletedAt: "2026-09-01"\ncrmSocialPosts: [{"platform":"tiktok","url":"https://www.tiktok.com/@teacher/video/1","group":"../etc"}]\n---\n');
  await assert.rejects(build());

  // The actual content schema refuses a non-content/credential URL at build time.
  await writeFile(content, '---\ntitle: Unsafe\ncompletedAt: "2026-09-01"\ncrmSocialPosts: [{"platform":"instagram","url":"https://instagram.com/direct/t/123/"}]\n---\n');
  await assert.rejects(build());
});
