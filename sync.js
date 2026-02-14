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

async function createItem({ title, link, publishedISO, summary }) {
  await notion.pages.create({
    parent: { database_id: DATABASE_ID },
    properties: {
      Title: { title: [{ text: { content: title } }] },
      Link: { url: link },
      Published: { date: { start: publishedISO } },
      Summary: { rich_text: [{ text: { content: summary } }] },
    },
  });
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
    const summary = stripHtml(it["content:encoded"] || it.description || "");

    const exists = await existsByLink(link);
    if (exists) {
      console.log(`skip: ${title}`);
      continue;
    }

    await createItem({ title, link, publishedISO, summary });
    console.log(`added: ${title}`);
  }

  console.log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
