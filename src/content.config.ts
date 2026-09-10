import { defineCollection, reference } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const solutions = defineCollection({
  loader: glob({ base: "./src/content/solutions", pattern: "**/*.md" }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      oneLiner: z.string().default(""),
      builtBy: z.string().default(""),
      completedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      solutionUrl: z.string().default(""),
      showcaseVideo: z.string().default(""),
      screenshot: image().optional(),
      problems: z.array(z.string()).default([]),
    }),
});

const newsletters = defineCollection({
  loader: glob({ base: "./src/content/newsletters", pattern: "**/*.md" }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      subject: z.string().default(""),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      preview: z.string(),
      thumbnail: image(),
      thumbnailAlt: z.string().default(""),
      issueNumber: z.number().int().positive().optional(),
    }),
});

// One entry per Instagram Reel in the "solving a teacher's problem every single
// day" series. Create a new one with `npm run daily`. A solution can have many
// Reels, and a Reel doesn't need a solution.
const daily = defineCollection({
  loader: glob({ base: "./src/content/daily", pattern: "**/*.md" }),
  schema: z.object({
    title: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    instagramUrl: z
      .string()
      .regex(
        /^https:\/\/(?:www\.)?instagram\.com\/(?:[\w.]+\/)?(?:reels?|p|tv)\/[\w-]+/,
        "Expected an Instagram Reel link",
      ),
    solution: reference("solutions").optional(),
  }),
});

export const collections = { solutions, newsletters, daily };
