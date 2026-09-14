#!/usr/bin/env node
// Holt österreichische Schlagzeilen per RSS, lässt Claude sie kategorisieren
// und natürlich ins Arabische übersetzen, und schreibt das Ergebnis nach
// public/data/news.json.

import Parser from "rss-parser";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const RSS_URL = process.env.ORF_RSS_URL || "https://rss.orf.at/news.xml";
const OUTPUT_PATH = process.env.NEWS_OUTPUT_PATH || "public/data/news.json";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 60);
const BATCH_SIZE = 20;

// Der ORF-Schlagzeilen-Feed liefert keine brauchbare <category> pro Eintrag
// und die Links unterscheiden sich meist nicht nach Themen-Subdomain, daher
// lässt das Modell jede Schlagzeile in eine dieser festen Kategorien
// einordnen (gemeinsam mit der Übersetzung, in einem API-Call).
const ALLOWED_CATEGORIES = [
  "Politik",
  "Wirtschaft",
  "Chronik",
  "Ausland",
  "Sport",
  "Kultur",
  "Wissenschaft",
  "Gesundheit",
  "Sonstiges",
];

const CATEGORY_AR = {
  Politik: "سياسة",
  Wirtschaft: "اقتصاد",
  Chronik: "حوادث",
  Ausland: "العالم",
  Sport: "رياضة",
  Kultur: "ثقافة",
  Wissenschaft: "علوم",
  Gesundheit: "صحة",
  Sonstiges: "عام",
};

// Erhöhen, wenn sich Prompt/Ausgabeschema ändern, damit bereits
// zwischengespeicherte Einträge einmalig neu klassifiziert/übersetzt werden.
const SCHEMA_VERSION = 2;

function idFor(link) {
  return createHash("sha1").update(link).digest("hex").slice(0, 16);
}

async function loadExisting(outputPath) {
  try {
    const raw = await readFile(outputPath, "utf8");
    const json = JSON.parse(raw);
    if (json.schemaVersion !== SCHEMA_VERSION) return new Map();
    const map = new Map();
    for (const item of json.items || []) map.set(item.id, item);
    return map;
  } catch {
    return new Map();
  }
}

async function fetchFeed() {
  const parser = new Parser();
  const feed = await parser.parseURL(RSS_URL);
  return feed.items
    .map((item) => {
      const link = (item.link || "").trim();
      const title_de = (item.title || "").trim();
      const pubDate = item.pubDate
        ? new Date(item.pubDate).toISOString()
        : new Date().toISOString();
      return { id: idFor(link), title_de, link, pubDate };
    })
    .filter((item) => item.title_de && item.link);
}

function extractJsonArray(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  return JSON.parse(candidate);
}

async function classifyAndTranslateBatch(client, titles) {
  const system = [
    "أنت محرر أخبار عربي محترف متخصص في الشؤون النمساوية والأوروبية.",
    "لكل عنوان خبري ألماني مُدخل، أنجز مهمتين:",
    "1) صنّفه ضمن إحدى الفئات التالية بالضبط (بالألمانية كما هي):",
    `   ${ALLOWED_CATEGORIES.join(", ")}`,
    "2) أعد صياغته كعنوان عربي صحفي طبيعي وسلس، كما لو كتبه محرر عربي أصلي،",
    "   وليس ترجمة حرفية كلمة بكلمة. حافظ على الأسماء والأماكن والمؤسسات",
    "   بصيغتها العربية الشائعة.",
    "أعد الإجابة حصراً كمصفوفة JSON بنفس الترتيب وبنفس عدد العناصر المُدخلة،",
    'كل عنصر بالشكل: {"category":"...", "title_ar":"..."}، بدون أي شرح إضافي.',
  ].join(" ");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: "user", content: JSON.stringify(titles) }],
  });

  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();

  const arr = extractJsonArray(text);
  if (!Array.isArray(arr) || arr.length !== titles.length) {
    throw new Error("Unerwartetes Antwortformat vom Übersetzungsmodell");
  }
  return arr.map((entry) => ({
    category_de: ALLOWED_CATEGORIES.includes(entry?.category)
      ? entry.category
      : "Sonstiges",
    title_ar: String(entry?.title_ar || "").trim(),
  }));
}

async function classifyAndTranslateAll(items) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const results = new Map();

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    const titles = chunk.map((item) => item.title_de);
    try {
      const classified = await classifyAndTranslateBatch(client, titles);
      chunk.forEach((item, idx) => results.set(item.id, classified[idx]));
    } catch (err) {
      console.error(
        `Batch fehlgeschlagen (${err.message}), versuche Einzelverarbeitung.`,
      );
      for (const item of chunk) {
        try {
          const [single] = await classifyAndTranslateBatch(client, [item.title_de]);
          results.set(item.id, single);
        } catch (itemErr) {
          console.error(`Fehlgeschlagen für "${item.title_de}":`, itemErr.message);
        }
      }
    }
  }
  return results;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY ist nicht gesetzt. Abbruch.");
    process.exit(1);
  }

  console.log(`Lade Feed von ${RSS_URL} ...`);
  const fetched = await fetchFeed();
  console.log(`${fetched.length} Meldungen im Feed gefunden.`);

  const existing = await loadExisting(OUTPUT_PATH);
  const needsWork = fetched.filter((item) => !existing.get(item.id)?.title_ar);
  console.log(`${needsWork.length} neue/unverarbeitete Meldungen.`);

  const processed = needsWork.length
    ? await classifyAndTranslateAll(needsWork)
    : new Map();

  const merged = fetched
    .map((item) => {
      const prev = existing.get(item.id);
      const result = processed.get(item.id) ||
        (prev ? { category_de: prev.category_de, title_ar: prev.title_ar } : null);
      if (!result?.title_ar) return null;
      return {
        ...item,
        category_de: result.category_de,
        category_ar: CATEGORY_AR[result.category_de] || "عام",
        title_ar: result.title_ar,
      };
    })
    .filter(Boolean);

  merged.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const trimmed = merged.slice(0, MAX_ITEMS);

  const output = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: RSS_URL,
    count: trimmed.length,
    items: trimmed,
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`${trimmed.length} Meldungen gespeichert in ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
