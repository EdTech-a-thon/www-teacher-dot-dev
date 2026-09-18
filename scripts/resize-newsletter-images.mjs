#!/usr/bin/env node
// Newsletter pictures are often added straight from a camera or screen capture,
// 2000px wide or more. Astro serves images inside the Markdown body at their
// full size with no srcset, so any picture bigger than 1200px on its longest
// side is shrunk in place. The newsletter column is never wider than about
// 700px, so 1200px stays sharp on high-density screens. Pictures that are
// already small enough are left alone, so this is safe to rerun each issue.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const maxSide = 1200;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const imagesDir = path.resolve(
  root,
  process.argv[2] ?? "src/content/newsletters/images",
);

const kb = (bytes) => `${Math.round(bytes / 1024)}KB`;

for (const name of (await readdir(imagesDir)).sort()) {
  if (!/\.(jpe?g|png|webp)$/i.test(name)) continue;

  const file = path.join(imagesDir, name);
  const input = await readFile(file);
  const { width, height, format, isPalette } = await sharp(input).metadata();
  if (Math.max(width, height) <= maxSide) continue;

  // rotate() applies the EXIF orientation before the metadata is dropped.
  let image = sharp(input)
    .rotate()
    .resize(maxSide, maxSide, { fit: "inside" });
  if (format === "jpeg") image = image.jpeg({ quality: 82, mozjpeg: true });
  // A palette PNG saved as full colour can end up bigger than the original.
  else if (format === "png") image = image.png({ compressionLevel: 9, palette: isPalette });
  else image = image.webp({ quality: 82 });

  const { data, info } = await image.toBuffer({ resolveWithObject: true });
  await writeFile(file, data);
  console.log(
    `${name}: ${width}x${height} ${kb(input.length)} -> ${info.width}x${info.height} ${kb(data.length)}`,
  );
}
