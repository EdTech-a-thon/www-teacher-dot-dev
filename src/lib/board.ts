import { getCollection } from "astro:content";
import type { ImageMetadata } from "astro";
import { getDailyEntries } from "./daily";

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
  socialPosts: { platform: "instagram" | "tiktok"; url: string; group: string }[];
  reels: { day: number; href: string; label: string }[];
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
  const [rows, dailyEntries] = await Promise.all([
    getCollection("solutions"),
    getDailyEntries(),
  ]);
  const socialBySolution = new Map<string, GalleryItem["socialPosts"]>();
  const reelsBySolution = new Map<string, GalleryItem["reels"]>();
  for (const entry of [...dailyEntries].reverse()) {
    if (!entry.solution) continue;
    const reels = reelsBySolution.get(entry.solution.key) ?? [];
    reels.push({
      day: entry.day,
      href: `/daily/${entry.id}`,
      label: `Day ${entry.day} · ${entry.shortDateLabel}`,
    });
    reelsBySolution.set(entry.solution.key, reels);
    const shortcode = /^https:\/\/www\.instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)\/$/.exec(entry.instagramUrl)?.[1];
    if (shortcode) {
      const social = socialBySolution.get(entry.solution.key) ?? [];
      social.push({ platform: "instagram", url: `https://www.instagram.com/p/${shortcode}/`, group: "" });
      socialBySolution.set(entry.solution.key, social);
    }
  }

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
      reels: reelsBySolution.get(row.id) ?? [],
      socialPosts: [...new Map([
        ...row.data.crmSocialPosts,
        ...(socialBySolution.get(row.id) ?? []),
      ].map((post) => [post.url, post])).values()],
      sortKey: row.data.completedAt,
    }))
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
    .map(({ sortKey, ...item }) => item);
}
