import { Client } from "@notionhq/client";
import { XMLParser } from "fast-xml-parser";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID = process.env.DATABASE_ID;

const RSS_URL = "https://v2.velog.io/rss/@pigpgw";

if (!NOTION_TOKEN || !DATABASE_ID) {
  console.error("Missing env: NOTION_TOKEN / DATABASE_ID");
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });
const parser = new XMLParser({ ignoreAttributes: false });

function stripHtml(html = "") {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

function getFirstImageFromHtml(html = "") {
  const m = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
  return m?.[1] || null;
}

function normalizeImageUrl(url) {
  if (!url) return null;
  // Notion sometimes can't render hotlinked images; use a public proxy.
  const stripped = url.replace(/^https?:\/\//i, "");
  return `https://images.weserv.nl/?url=${encodeURIComponent(stripped)}`;
}

async function getThumbnailFromUrl(url) {
  try {
    const html = await fetch(url, {
      headers: { "User-Agent": "velog-notion-sync" },
    }).then((r) => r.text());

    const og = html.match(
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i
    )?.[1];

    return og || getFirstImageFromHtml(html);
  } catch {
    return null;
  }
}

async function existsByLink(link) {
  const res = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: "Link",
      url: { equals: link },
    },
    page_size: 1,
  });
  return res.results.length > 0;
}

function getUrlProp(page, name) {
  return page?.properties?.[name]?.url ?? null;
}

function getTitleProp(page, name) {
  const t = page?.properties?.[name]?.title ?? [];
  return t.map((x) => x?.plain_text || "").join("");
}

async function createItem({ title, link, publishedISO, summary, thumbnail }) {
  const properties = {
    Title: { title: [{ text: { content: title } }] },
    Link: { url: link },
    Published: { date: { start: publishedISO } },
    Summary: { rich_text: [{ text: { content: summary } }] },
  };

  if (thumbnail) properties.Thumbnail = { url: thumbnail };

  const payload = {
    parent: { database_id: DATABASE_ID },
    properties,
  };

  if (thumbnail) {
    payload.cover = { type: "external", external: { url: thumbnail } };
  }

  await notion.pages.create(payload);
}

async function backfillThumbnails() {
  let cursor = undefined;
  let total = 0;

  while (true) {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      filter: {
        property: "Thumbnail",
        url: { is_empty: true },
      },
      start_cursor: cursor,
      page_size: 50,
    });

    for (const page of res.results) {
      const link = getUrlProp(page, "Link");
      if (!link) continue;

      const title = getTitleProp(page, "Title") || link;
      const rawThumb = await getThumbnailFromUrl(link);
      const thumbnail = normalizeImageUrl(rawThumb);
      if (!thumbnail) {
        console.log(`no thumb: ${title}`);
        continue;
      }

      await notion.pages.update({
        page_id: page.id,
        properties: {
          Thumbnail: { url: thumbnail },
        },
        cover: { type: "external", external: { url: thumbnail } },
      });

      total += 1;
      console.log(`thumb added: ${title}`);
    }

    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

  console.log(`backfill done: ${total}`);
}

function isTruthy(v) {
  return ["1", "true", "yes", "y", "on"].includes(String(v).toLowerCase());
}

async function main() {
  const xml = await fetch(RSS_URL).then((r) => r.text());
  const data = parser.parse(xml);

  const itemsRaw = data?.rss?.channel?.item ?? [];
  const items = Array.isArray(itemsRaw) ? itemsRaw : [itemsRaw];

  console.log(`RSS items: ${items.length}`);

  // 최신 20개만 확인
  for (const it of items.slice(0, 20)) {
    const title = it.title ?? "(no title)";
    const link = it.link;
    const pubDate = it.pubDate;

    if (!link || !pubDate) continue;

    const publishedISO = new Date(pubDate).toISOString();
    const contentHtml = it["content:encoded"] || it.description || "";
    const summary = stripHtml(contentHtml);

    const exists = await existsByLink(link);
    if (exists) {
      console.log(`skip: ${title}`);
      continue;
    }

    const rawThumb = getFirstImageFromHtml(contentHtml) || (await getThumbnailFromUrl(link));
    const thumbnail = normalizeImageUrl(rawThumb);

    await createItem({ title, link, publishedISO, summary, thumbnail });
    console.log(`added: ${title}`);
  }

  const backfill = process.env.BACKFILL_THUMBNAILS;
  console.log(`BACKFILL_THUMBNAILS=${backfill ?? ""}`);
  if (isTruthy(backfill)) {
    await backfillThumbnails();
  }

  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
