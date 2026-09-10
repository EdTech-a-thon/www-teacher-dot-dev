#!/usr/bin/env node
// Adds a day to the "solving a teacher's problem every single day" page. Run
// it with the Reel's link and it asks for everything else:
//
//   npm run daily -- https://www.instagram.com/reel/ABC123/
//
// Any answer can be given as a flag instead, which skips that question:
//
//   npm run daily -- <link> --title "..." --solution math-library --date 2026-09-10 --note "..."
//
// Use --solution none for a Reel that isn't about a solution. The script writes
// src/content/daily/<date>.md. Once that file is committed and deployed, the
// day appears on /daily, on the homepage, and in the linked solution's popup.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dailyDir = path.join(root, "src/content/daily");
const solutionsDir = path.join(root, "src/content/solutions");
const reelPattern =
  /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:[\w.]+\/)?(reels?|p|tv)\/([\w-]+)/i;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    title: { type: "string" },
    solution: { type: "string" },
    date: { type: "string" },
    note: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(
    "Usage: npm run daily -- <instagram reel link> [--title ...] [--solution <id>|none] [--date YYYY-MM-DD] [--note ...]",
  );
  process.exit(0);
}

let rl;
let lines;
function fail(message) {
  console.error(`\n${message}`);
  rl?.close();
  process.exit(1);
}

// Reading lines through an iterator keeps any typed or pasted ahead of the
// question instead of dropping them.
async function ask(question) {
  if (!stdin.isTTY) fail(`Missing an answer for: ${question.trim()}`);
  if (!rl) {
    rl = createInterface({ input: stdin, output: stdout });
    lines = rl[Symbol.asyncIterator]();
  }
  rl.setPrompt(question);
  rl.prompt();
  const { value, done } = await lines.next();
  if (done) fail("Cancelled, nothing was saved.");
  return value.trim();
}

function frontmatterField(text, key) {
  const value = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(text)?.[1].trim() ?? "";
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

async function readMarkdown(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".md"));
  return Promise.all(
    names.map(async (name) => ({
      id: name.slice(0, -".md".length),
      text: await readFile(path.join(dir, name), "utf8"),
    })),
  );
}

const now = new Date();
const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
  .map((n) => String(n).padStart(2, "0"))
  .join("-");

// 1. The Reel link, stripped of share tracking like ?igsh=...
const link = positionals[0] ?? (await ask("Instagram Reel link: "));
const match = reelPattern.exec(link);
if (!match) fail(`"${link}" doesn't look like an Instagram Reel link.`);
const kind = match[1].toLowerCase() === "reels" ? "reel" : match[1].toLowerCase();
const instagramUrl = `https://www.instagram.com/${kind}/${match[2]}/`;

const existing = await readMarkdown(dailyDir);
const duplicate = existing.find(({ text }) => text.includes(`/${match[2]}/`));
if (duplicate) fail(`That Reel is already on the site: src/content/daily/${duplicate.id}.md`);

// 2. The day it was posted.
const date = values.date ?? ((await ask(`Date posted (Enter for ${today}): `)) || today);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`"${date}" isn't a date like ${today}.`);

// 3. What was built. The homepage shows it as "We built a math facts drill
// website.", so the title is stored with its first letter capitalized.
const answer =
  values.title ??
  (await ask('What did you build? It finishes "We built …", like "a math facts drill website": '));
if (!answer) fail("A title is required.");
const title = answer[0].toUpperCase() + answer.slice(1);

// 4. The solution this Reel is about, if any.
const solutions = (await readMarkdown(solutionsDir))
  .map(({ id, text }) => ({
    id,
    title: frontmatterField(text, "title"),
    completedAt: frontmatterField(text, "completedAt"),
  }))
  .sort((a, b) => b.completedAt.localeCompare(a.completedAt));

let solution;
if (values.solution !== undefined) {
  if (values.solution !== "none") {
    solution = solutions.find(({ id }) => id === values.solution);
    if (!solution) {
      fail(
        `No solution called "${values.solution}". Choose one of: ${solutions.map(({ id }) => id).join(", ")}`,
      );
    }
  }
} else {
  console.log("\nWhich solution is this Reel about?");
  solutions.forEach(({ title: name }, index) => console.log(`  ${index + 1}. ${name}`));
  const choice = await ask("Number, or Enter if it isn't about a solution yet: ");
  if (choice) {
    solution = solutions[Number(choice) - 1];
    if (!solution) fail(`"${choice}" isn't one of the numbers above.`);
  }
}

// 5. An optional sentence or two for the day's page.
const note = values.note ?? (await ask("\nA sentence or two about it (optional, Enter to skip): "));
rl?.close();

// Two Reels on the same day get -2, -3, ... on the end.
const ids = new Set(existing.map(({ id }) => id));
let id = date;
for (let n = 2; ids.has(id); n += 1) id = `${date}-${n}`;

// JSON strings are valid YAML, so quotes and colons in a title are safe.
const contents = [
  "---",
  `title: ${JSON.stringify(title)}`,
  `date: ${JSON.stringify(date)}`,
  `instagramUrl: ${JSON.stringify(instagramUrl)}`,
  ...(solution ? [`solution: ${JSON.stringify(solution.id)}`] : []),
  "---",
  "",
  ...(note ? [note, ""] : []),
];
const file = path.join(dailyDir, `${id}.md`);
await writeFile(file, contents.join("\n"));

console.log(`\nCreated ${path.relative(root, file)}`);
console.log(`It will be at /daily/${id} once it's committed and deployed.`);
