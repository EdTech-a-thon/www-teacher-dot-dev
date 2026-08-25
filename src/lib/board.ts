import { getCollection } from "astro:content";
import type { ImageMetadata } from "astro";

export function normalizeUrl(url: string | null | undefined): string {
  const u = url?.trim() ?? "";
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

export function youtubeId(url: string | null | undefined): string {
  const u = url?.trim() ?? "";
  if (!u) return "";
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = re.exec(u);
    if (m) return m[1];
  }
  return "";
}

export function youtubeEmbedUrl(url: string): string {
  const id = youtubeId(url);
  return id ? `https://www.youtube-nocookie.com/embed/${id}` : "";
}

export function youtubeThumb(url: string): string {
  const id = youtubeId(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : "";
}

export interface GalleryItem {
  key: string;
  name: string;
  oneLiner: string;
  descriptionHtml: string;
  link: string;
  videoEmbed: string;
  videoThumb: string;
  screenshot?: ImageMetadata;
  builtBy: string;
  date: string;
}

const GALLERY_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function formatGalleryDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "";
  return `${GALLERY_MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

export async function getSolutionGallery(): Promise<GalleryItem[]> {
  const rows = await getCollection("solutions");
  return rows
    .map((row) => ({
      key: row.id,
      name: row.data.title,
      oneLiner: row.data.oneLiner,
      descriptionHtml: row.rendered?.html ?? "",
      link: normalizeUrl(row.data.solutionUrl),
      videoEmbed: youtubeEmbedUrl(row.data.showcaseVideo),
      videoThumb: youtubeThumb(row.data.showcaseVideo),
      screenshot: row.data.screenshot,
      builtBy: row.data.builtBy,
      date: formatGalleryDate(row.data.completedAt),
      sortKey: row.data.completedAt,
    }))
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
    .map(({ sortKey, ...item }) => item);
}
