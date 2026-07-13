import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const TOPICS_PATH = path.join("prompts", "info-topics.json");
const TOPIC_BATCH_SIZE = 50;
const TIME_ZONE = "Asia/Seoul";
const PUBLIC_POST_IMAGE_ROOT = "/assets/img/posts/blog";
const THUMBNAIL_OUTPUT_NAME = "preview.png";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  throw new Error("OPENAI_API_KEY is required.");
}

const client = new OpenAI({ apiKey });

const today = new Date();
const date = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(today);

async function readTopicPool() {
  const raw = await fs.readFile(TOPICS_PATH, "utf8");
  const pool = JSON.parse(raw.replace(/^\uFEFF/, ""));

  if (!Array.isArray(pool.topics)) {
    throw new Error(`${TOPICS_PATH} must contain a topics array.`);
  }

  if (pool.priorityKeywords === undefined) {
    pool.priorityKeywords = [];
  }

  if (!Array.isArray(pool.priorityKeywords)) {
    throw new Error(`${TOPICS_PATH} priorityKeywords must be an array when provided.`);
  }

  return pool;
}

function topicTitle(item) {
  if (typeof item === "string") {
    return item;
  }

  return String(item?.title ?? item?.keyword ?? "").trim();
}

function parseJsonArray(text) {
  const withoutFence = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  return JSON.parse(withoutFence);
}

async function requestNewTopics(previousTopics) {
  const response = await client.responses.create({
    model: "gpt-5-mini",
    input: [
      "한국어 생활 정보형 검색 질문 블로그 주제 50개를 JSON 배열로만 작성해라.",
      "각 항목은 반드시 객체여야 하며, title, slug, thumbnail 키를 포함해라.",
      "thumbnail은 title과 subtitle 키를 가진 객체여야 한다.",
      "slug는 lowercase ASCII kebab-case로 작성하고 80자 이하로 유지해라.",
      "thumbnail.title은 썸네일에 들어갈 짧은 한국어 제목, thumbnail.subtitle은 썸네일에 들어갈 짧은 한국어 부제목으로 작성해라.",
      "마크다운이나 설명 문장은 넣지 마라.",
      "주제는 사람들이 실제로 검색할 만한 구체적인 질문형 문장이어야 한다.",
      "법령, 정책, 지원금, 요금제, 환불, 서비스 변경, 신청 조건, 생활 행정, 여행 규칙, 업무/계약 노하우를 고르게 섞어라.",
      "시간이 지나면 바뀔 수 있어 현재 기준 확인이 필요한 주제를 우선해라.",
      "제목에는 가능하면 현재 기준, 2026년, 가능한가, 조건, 방법, 차이, 안 될 때 같은 롱테일 검색 의도를 반영해라.",
      "최근에 사용한 아래 주제와 의미가 겹치지 않게 작성해라.",
      JSON.stringify(previousTopics, null, 2)
    ].join("\n\n")
  });

  const topics = parseJsonArray(response.output_text);

  if (!Array.isArray(topics) || topics.length < TOPIC_BATCH_SIZE) {
    throw new Error("The topic refresh response must be a JSON array with at least 50 items.");
  }

  return topics.slice(0, TOPIC_BATCH_SIZE).map((item) => {
    if (typeof item === "string") {
      return { title: item };
    }

    return {
      title: String(item.title ?? item.topic ?? "").trim(),
      slug: String(item.slug ?? "").trim(),
      thumbnail: {
        title: String(item.thumbnail?.title ?? item.thumbnailTitle ?? "").trim(),
        subtitle: String(item.thumbnail?.subtitle ?? item.subtitle ?? "").trim()
      }
    };
  });
}

function normalizePriorityKeyword(item) {
  if (typeof item === "string") {
    return { keyword: item, used: false };
  }

  if (item && typeof item === "object") {
    return {
      ...item,
      keyword: String(item.keyword ?? item.title ?? "").trim(),
      used: Boolean(item.used || item.usedAt)
    };
  }

  return { keyword: "", used: false };
}

async function pickTopic() {
  const pool = await readTopicPool();
  pool.priorityKeywords = pool.priorityKeywords.map(normalizePriorityKeyword);

  const priorityKeyword = pool.priorityKeywords.find((item) => item.keyword && !item.used && !item.usedAt);

  if (priorityKeyword) {
    priorityKeyword.used = true;
    priorityKeyword.usedAt = new Date().toISOString();

    await fs.writeFile(`${TOPICS_PATH}`, `${JSON.stringify(pool, null, 2)}\n`, "utf8");

    return priorityKeyword;
  }

  let topic = pool.topics.find((item) => !item.usedAt);

  if (!topic) {
    const previousTopics = [
      ...pool.priorityKeywords.map(topicTitle),
      ...pool.topics.map(topicTitle)
    ].filter(Boolean);
    pool.generatedAt = new Date().toISOString();
    pool.topics = await requestNewTopics(previousTopics);
    topic = pool.topics[0];
  }

  topic.usedAt = new Date().toISOString();

  await fs.writeFile(`${TOPICS_PATH}`, `${JSON.stringify(pool, null, 2)}\n`, "utf8");

  return topic;
}

const selectedTopic = await pickTopic();
const topic = topicTitle(selectedTopic);

const promptTemplate = await fs.readFile(
  path.join("prompts", "info-post.prompt.md"),
  "utf8"
);

const prompt = promptTemplate.replace("{{TOPIC}}", topic);

const response = await client.responses.create({
  model: "gpt-5-mini",
  input: prompt
});

const content = response.output_text;

function sanitizeEnglishSlug(value) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/['`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

function frontMatterValue(markdown, key) {
  const frontMatter = markdown.match(/^---\s*\n([\s\S]*?)\n---/);

  if (!frontMatter) {
    return "";
  }

  const line = frontMatter[1]
    .split("\n")
    .find((item) => item.startsWith(`${key}:`));

  if (!line) {
    return "";
  }

  return line
    .slice(key.length + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
}

function upsertFrontMatterValue(markdown, key, value) {
  const frontMatter = markdown.match(/^---\s*\n([\s\S]*?)\n---/);

  if (!frontMatter) {
    return markdown;
  }

  const lines = frontMatter[1].split("\n");
  const line = `${key}: ${value}`;
  const currentIndex = lines.findIndex((item) => item.startsWith(`${key}:`));

  if (currentIndex >= 0) {
    lines[currentIndex] = line;
  } else {
    const titleIndex = lines.findIndex((item) => item.startsWith("title:"));
    lines.splice(titleIndex >= 0 ? titleIndex + 1 : 0, 0, line);
  }

  return `---\n${lines.join("\n")}\n---${markdown.slice(frontMatter[0].length)}`;
}

function yamlDoubleQuoted(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function upsertFrontMatterBlock(markdown, key, blockLines) {
  const frontMatter = markdown.match(/^---\s*\n([\s\S]*?)\n---/);

  if (!frontMatter) {
    return markdown;
  }

  const lines = frontMatter[1].split("\n");
  const nextLines = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith(`${key}:`)) {
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        index += 1;
      }
      continue;
    }

    nextLines.push(lines[index]);
  }

  const insertAfterKeys = ["tags:", "categories:", "date:", "slug:", "title:"];
  const insertIndex = nextLines.findLastIndex((line) =>
    insertAfterKeys.some((prefix) => line.startsWith(prefix))
  );

  nextLines.splice(insertIndex >= 0 ? insertIndex + 1 : 0, 0, ...blockLines);

  return `---\n${nextLines.join("\n")}\n---${markdown.slice(frontMatter[0].length)}`;
}

function yamlInlineListItems(value) {
  const match = value.match(/^\s*\[(.*)\]\s*$/);

  if (!match) {
    return [];
  }

  return match[1]
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function yamlStringList(items) {
  return `[${items.map(yamlDoubleQuoted).join(", ")}]`;
}

function normalizeFrontMatterStringList(markdown, key) {
  const frontMatter = markdown.match(/^---\s*\n([\s\S]*?)\n---/);

  if (!frontMatter) {
    return markdown;
  }

  const lines = frontMatter[1].split("\n");
  const lineIndex = lines.findIndex((line) => line.startsWith(`${key}:`));

  if (lineIndex < 0) {
    return markdown;
  }

  const items = yamlInlineListItems(lines[lineIndex].slice(key.length + 1));

  if (!items.length) {
    return markdown;
  }

  lines[lineIndex] = `${key}: ${yamlStringList(items)}`;

  return `---\n${lines.join("\n")}\n---${markdown.slice(frontMatter[0].length)}`;
}

async function requestEnglishSlug(markdown) {
  const title = frontMatterValue(markdown, "title");
  const slugResponse = await client.responses.create({
    model: "gpt-5-mini",
    input: [
      "Create one SEO-friendly English URL slug for a Korean informational blog post.",
      "Return only lowercase ASCII kebab-case, with no markdown or explanation.",
      "Keep it under 80 characters.",
      `Topic: ${topic}`,
      `Title: ${title}`
    ].join("\n")
  });

  return sanitizeEnglishSlug(slugResponse.output_text);
}

async function uniqueDraftPath(baseSlug) {
  let suffix = 1;

  while (true) {
    const slug = suffix === 1 ? baseSlug : `${baseSlug}-${suffix}`;
    const filepath = path.join("_drafts", `${date}-${slug}.md`);
    const exists = await fs
      .stat(filepath)
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      return { filepath, slug };
    }

    suffix += 1;
  }
}

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${command} ${commandArgs.join(" ")} failed with exit code ${code}\n${stderr || stdout}`
        )
      );
    });
  });
}

async function generateThumbnail({ slug, title, subtitle }) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "info-blog-thumbnail-input-"));
  const inputPath = path.join(tempDir, "thumbnail-input.json");

  try {
    await fs.writeFile(
      inputPath,
      `${JSON.stringify({ slug, title, subtitle }, null, 2)}\n`,
      "utf8"
    );

    await run(process.execPath, [
      path.join("scripts", "generate-thumbnail.mjs"),
      "--input",
      inputPath,
      "--output-name",
      THUMBNAIL_OUTPUT_NAME
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  return `${PUBLIC_POST_IMAGE_ROOT}/${slug}/${THUMBNAIL_OUTPUT_NAME}`;
}

async function generatePostThumbnail({ markdown, slug }) {
  const thumbnail = selectedTopic.thumbnail ?? {};
  const subtitle = String(thumbnail.subtitle ?? selectedTopic.subtitle ?? "").trim();

  if (!subtitle) {
    return null;
  }

  const title = String(thumbnail.title ?? frontMatterValue(markdown, "title") ?? topic).trim();
  const path = await generateThumbnail({ slug, title, subtitle });

  return {
    path,
    alt: `${title} 썸네일`
  };
}

function plainTextSummary(markdown) {
  const body = markdown.replace(/^---\s*\n[\s\S]*?\n---/, "").trim();
  const firstParagraph = body
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .replace(/```[\s\S]*?```/g, "")
        .replace(/^#+\s+/gm, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_`>#-]/g, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .find(Boolean);

  return (firstParagraph || topic).slice(0, 280);
}

async function writeGitHubOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  const lines = [];

  for (const [key, value] of Object.entries(outputs)) {
    const text = String(value ?? "");
    const delimiter = `EOF_${key.toUpperCase()}`;

    if (text.includes("\n")) {
      lines.push(`${key}<<${delimiter}`, text, delimiter);
    } else {
      lines.push(`${key}=${text}`);
    }
  }

  await fs.appendFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, "utf8");
}

let slug = sanitizeEnglishSlug(selectedTopic.slug || frontMatterValue(content, "slug"));

if (!slug) {
  slug = await requestEnglishSlug(content);
}

if (!slug) {
  throw new Error("The generated post must have a non-empty English slug.");
}

const draft = await uniqueDraftPath(slug);
let outputContent = upsertFrontMatterValue(content, "slug", `"${draft.slug}"`);
outputContent = normalizeFrontMatterStringList(outputContent, "categories");
outputContent = normalizeFrontMatterStringList(outputContent, "tags");
const generatedThumbnail = await generatePostThumbnail({
  markdown: outputContent,
  slug: draft.slug
});

if (generatedThumbnail) {
  outputContent = upsertFrontMatterBlock(outputContent, "image", [
    "image:",
    `  path: ${generatedThumbnail.path}`,
    `  alt: ${yamlDoubleQuoted(generatedThumbnail.alt)}`
  ]);
}

await fs.mkdir("_drafts", { recursive: true });
await fs.writeFile(draft.filepath, outputContent, "utf8");

console.log(`Selected topic: ${topic}`);
console.log(`English slug: ${draft.slug}`);
console.log(`Generated thumbnail: ${generatedThumbnail ? generatedThumbnail.path : "skipped"}`);
console.log(`Created draft: ${draft.filepath}`);

await writeGitHubOutputs({
  topic,
  title: frontMatterValue(outputContent, "title"),
  slug: draft.slug,
  draft_path: draft.filepath.replaceAll("\\", "/"),
  summary: plainTextSummary(outputContent)
});
