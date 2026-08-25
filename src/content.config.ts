import { defineCollection } from "astro:content";
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

export const collections = { solutions };
