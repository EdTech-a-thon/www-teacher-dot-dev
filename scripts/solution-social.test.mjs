import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');

test('solution social content builds compact external links, never embeds or private fields', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'teacher-social-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'src/content/solutions'), { recursive: true });
  await mkdir(path.join(dir, 'src/pages'), { recursive: true });
  await mkdir(path.join(dir, 'src/components'), { recursive: true });
  await symlink(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  await writeFile(path.join(dir, 'package.json'), '{"type":"module"}');
  await copyFile(path.join(root, 'src/content.config.ts'), path.join(dir, 'src/content.config.ts'));
  await copyFile(path.join(root, 'src/components/SocialPosts.astro'), path.join(dir, 'src/components/SocialPosts.astro'));
  await writeFile(path.join(dir, 'src/pages/index.astro'), `---
import { getCollection } from 'astro:content';
import SocialPosts from '../components/SocialPosts.astro';
const rows = await getCollection('solutions');
---
{rows.map(row => <SocialPosts posts={row.data.crmSocialPosts} />)}
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
  assert.match(html, /Watch the reels/);
  assert.ok(html.includes(`href="${instagram}"`), 'Instagram link');
  assert.ok(html.includes(`href="${tiktok}"`), 'TikTok link');
  assert.equal(html.includes('<iframe'), false, 'Social posts are never embedded');
  assert.equal(html.includes('See it on social'), false);
  assert.equal(html.includes('PRIVATE'), false);
  assert.equal(html.includes('<script'), false, 'No social scripts needed');

  // Unconnected posts stay separate, each offered on its own terms.
  await writeFile(content, `---\ntitle: Example solution\ncompletedAt: "2026-09-01"\ncrmSocialPosts: ${JSON.stringify(
    fields.map(({ group, ...rest }) => rest),
  )}\n---\n`);
  await build();
  const separate = await readFile(path.join(dir, 'dist/index.html'), 'utf8');
  assert.equal((separate.match(/Watch on Instagram/g) || []).length, 1);
  assert.equal((separate.match(/Watch on TikTok/g) || []).length, 1);

  // A fabricated cluster tag is refused rather than silently rendered.
  await writeFile(content, '---\ntitle: Bad group\ncompletedAt: "2026-09-01"\ncrmSocialPosts: [{"platform":"tiktok","url":"https://www.tiktok.com/@teacher/video/1","group":"../etc"}]\n---\n');
  await assert.rejects(build());

  // The actual content schema refuses a non-content/credential URL at build time.
  await writeFile(content, '---\ntitle: Unsafe\ncompletedAt: "2026-09-01"\ncrmSocialPosts: [{"platform":"instagram","url":"https://instagram.com/direct/t/123/"}]\n---\n');
  await assert.rejects(build());
});
