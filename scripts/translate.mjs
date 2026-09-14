#!/usr/bin/env node
// Holt österreichische Schlagzeilen per RSS, übersetzt neue Titel natürlich
// ins Arabische (Claude API) und schreibt das Ergebnis nach public/data/news.json.

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

// Fallback-Kategorie anhand der ORF-Subdomain, falls der Feed-Eintrag
// selbst keine <category> mitliefert.
const CATEGORY_BY_HOST = {
  "sport.orf.at": "Sport",
  "science.orf.at": "Wissenschaft",
  "help.orf.at": "Verbraucher",
  "religion.orf.at": "Religion",
  "fm4.orf.at": "Kultur",
  "tirol.orf.at": "Bundesländer",
  "wien.orf.at": "Bundesländer",
  "ooe.orf.at": "Bundesländer",
  "ktn.orf.at": "Bundesländer",
  "stmk.orf.at": "Bundesländer",
  "salzburg.orf.at": "Bundesländer",
  "vorarlberg.orf.at": "Bundesländer",
  "noe.orf.at": "Bundesländer",
  "burgenland.orf.at": "Bundesländer",
};

// Deutsche Kategoriebezeichnung -> arabische Bezeichnung für die Filter-Chips.
const CATEGORY_AR = {
  Politik: "سياسة",
  Wirtschaft: "اقتصاد",
  Chronik: "حوادث",
  Ausland: "العالم",
  Sport: "رياضة",
  Kultur: "ثقافة",
  Wissenschaft: "علوم",
  Religion: "دين",
  Netzpolitik: "تكنولوجيا",
  Coronavirus: "صحة",
  Gesundheit: "صحة",
  Bundesländer: "الأقاليم",
  Verbraucher: "مستهلك",
  Österreich: "النمسا",
};

function categoryFromLink(link) {
  try {
    const host = new URL(link).hostname;
    return CATEGORY_BY_HOST[host] || "Österreich";
  } catch {
    return "Österreich";
  }
}

function idFor(link) {
  return createHash("sha1").update(link).digest("hex").slice(0, 16);
}

async function loadExisting(outputPath) {
  try {
    const raw = await readFile(outputPath, "utf8");
    const json = JSON.parse(raw);
    const map = new Map();
    for (const item of json.items || []) map.set(item.id, item);
    return map;
  } catch {
    return new Map();
  }
}

async function fetchFeed() {
  const parser = new Parser({ customFields: { item: ["category"] } });
  const feed = await parser.parseURL(RSS_URL);
  return feed.items
    .map((item) => {
      const link = (item.link || "").trim();
      const title_de = (item.title || "").trim();
      const pubDate = item.pubDate
        ? new Date(item.pubDate).toISOString()
        : new Date().toISOString();
      const rawCategory =
        (Array.isArray(item.categories) && item.categories[0]) ||
        item.category ||
        categoryFromLink(link);
      const category_de = String(rawCategory).trim() || "Österreich";
      return {
        id: idFor(link),
        title_de,
        link,
        pubDate,
        category_de,
        category_ar: CATEGORY_AR[category_de] || "عام",
      };
    })
    .filter((item) => item.title_de && item.link);
}

function extractJsonArray(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  return JSON.parse(candidate);
}

async function translateBatch(client, titles) {
  const system = [
    "أنت محرر أخبار عربي محترف متخصص في الشؤون النمساوية والأوروبية.",
    "مهمتك إعادة صياغة عناوين أخبار ألمانية إلى عناوين عربية صحفية طبيعية،",
    "كما لو كتبها محرر عربي أصلي وليس مترجم آلي: بأسلوب سلس ومختصر ومناسب لعنوان خبري،",
    "وليس ترجمة حرفية كلمة بكلمة. حافظ على الأسماء والأماكن والمؤسسات بصيغتها العربية الشائعة.",
    "أعد الإجابة حصراً كمصفوفة JSON من النصوص المترجمة، بنفس الترتيب وبنفس عدد العناصر المُدخلة،",
    "بدون أي شرح أو نص إضافي أو ترقيم.",
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
  return arr;
}

async function translateAll(items) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const results = new Map();

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
    const titles = chunk.map((item) => item.title_de);
    try {
      const translated = await translateBatch(client, titles);
      chunk.forEach((item, idx) => results.set(item.id, translated[idx]));
    } catch (err) {
      console.error(
        `Batch-Übersetzung fehlgeschlagen (${err.message}), versuche Einzelübersetzung.`,
      );
      for (const item of chunk) {
        try {
          const [single] = await translateBatch(client, [item.title_de]);
          results.set(item.id, single);
        } catch (itemErr) {
          console.error(`Übersetzung fehlgeschlagen für "${item.title_de}":`, itemErr.message);
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
  const needsTranslation = fetched.filter(
    (item) => !(existing.get(item.id)?.title_ar),
  );
  console.log(`${needsTranslation.length} neue/unübersetzte Meldungen.`);

  const translations = needsTranslation.length
    ? await translateAll(needsTranslation)
    : new Map();

  const merged = fetched
    .map((item) => {
      const prev = existing.get(item.id);
      const title_ar = translations.get(item.id) || prev?.title_ar || null;
      return { ...item, title_ar };
    })
    .filter((item) => item.title_ar);

  merged.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const trimmed = merged.slice(0, MAX_ITEMS);

  const output = {
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
