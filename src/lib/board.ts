import { getCollection } from "astro:content";
import type { ImageMetadata } from "astro";
import { getDailyEntries, instagramPermalink } from "./daily";

export function normalizeUrl(url: string | null | undefined): string {
  const u = url?.trim() ?? "";
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

// One tab in the reel switcher on an app's page.
export interface GalleryReel {
  // Instagram permalink, which is both the embed source and the fallback link.
  url: string;
  // What the tab button says, e.g. "Day 12".
  label: string;
  // The Reel's own title, shown under the embed.
  title: string;
  // The day page for this Reel, when the Reel came from the daily series.
  href: string;
}

export interface GalleryItem {
  key: string;
  name: string;
  oneLiner: string;
  descriptionHtml: string;
  link: string;
  screenshot?: ImageMetadata;
  builtBy: string;
  date: string;
  socialPosts: { platform: "instagram" | "tiktok"; url: string; group: string }[];
  reels: GalleryReel[];
  // Lowercased haystack the client-side search matches against.
  searchText: string;
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

// Everything the search box looks at: name, pitch, builders and body copy.
function buildSearchText(parts: (string | undefined)[]): string {
  return parts
    .filter(Boolean)
    .join(" ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export async function getSolutionGallery(): Promise<GalleryItem[]> {
  const [rows, dailyEntries] = await Promise.all([
    getCollection("solutions"),
    getDailyEntries(),
  ]);
  const reelsBySolution = new Map<string, GalleryReel[]>();
  for (const entry of [...dailyEntries].reverse()) {
    if (!entry.solution) continue;
    const reels = reelsBySolution.get(entry.solution.key) ?? [];
    reels.push({
      url: entry.instagramUrl,
      label: `Day ${entry.day}`,
      title: entry.title,
      href: `/daily/${entry.id}`,
    });
    reelsBySolution.set(entry.solution.key, reels);
  }

  return rows
    .map((row) => {
      // Daily Reels first, then any extra Instagram posts the CRM tracks.
      const dailyReels = reelsBySolution.get(row.id) ?? [];
      const seen = new Set(dailyReels.map((reel) => reel.url));
      const extraReels = row.data.crmSocialPosts
        .filter((post) => post.platform === "instagram")
        .map((post) => instagramPermalink(post.url))
        .filter((url) => !seen.has(url))
        .map((url, index) => ({
          url,
          label: `Reel ${dailyReels.length + index + 1}`,
          title: row.data.title,
          href: "",
        }));

      return {
        key: row.id,
        name: row.data.title,
        oneLiner: row.data.oneLiner,
        descriptionHtml: row.rendered?.html ?? "",
        link: normalizeUrl(row.data.solutionUrl),
        screenshot: row.data.screenshot,
        builtBy: row.data.builtBy,
        date: formatGalleryDate(row.data.completedAt),
        sortKey: row.data.completedAt,
        reels: [...dailyReels, ...extraReels],
        socialPosts: row.data.crmSocialPosts,
        searchText: buildSearchText([
          row.data.title,
          row.data.oneLiner,
          row.data.builtBy,
          row.rendered?.html,
        ]),
      };
    })
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
    .map(({ sortKey, ...item }) => item);
}
