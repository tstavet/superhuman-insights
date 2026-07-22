#!/usr/bin/env node
/**
 * Archive X (Twitter) posts as static, login-free pages.
 *
 * Usage:
 *   node scripts/archive-x-post.mjs <url or id> [<url or id> ...]
 *   node scripts/archive-x-post.mjs --text "any text containing x.com/twitter.com status links"
 *
 * For each post this fetches the public syndication JSON (no API key or
 * account needed), downloads media into the repo, and writes:
 *   x/<id>/index.html   – the hosted, reader-facing page
 *   x/<id>/post.json    – the archived data snapshot
 *   x/<id>/*.jpg|mp4    – media files
 * then rebuilds x/index.html (the archive listing).
 *
 * No dependencies. Requires Node 18+.
 */

import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVE_DIR = path.join(ROOT, "x");
const SITE_BASE = process.env.SITE_BASE || "https://tstavet.github.io/superhuman-insights";
const SITE_NAME = process.env.SITE_NAME || "Superhuman AI";
const REPO = process.env.GITHUB_REPOSITORY || "tstavet/superhuman-insights";
const MAX_VIDEO_BYTES = 80 * 1024 * 1024; // skip download above this; keep poster + link

// ---------------------------------------------------------------- utilities

function extractIds(text) {
  const ids = new Set();
  const urlRe = /(?:twitter\.com|x\.com)\/[A-Za-z0-9_]+\/status(?:es)?\/(\d+)/g;
  let m;
  while ((m = urlRe.exec(text))) ids.add(m[1]);
  // bare numeric ids passed as standalone tokens
  for (const tok of text.split(/\s+/)) {
    if (/^\d{6,}$/.test(tok)) ids.add(tok);
  }
  return [...ids];
}

function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Text from the API is HTML-entity-encoded and entity indices count the
// encoded string, so slices are decoded first, then re-escaped for output.
const escText = (s) => esc(decodeEntities(s));

async function fetchWithRetry(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function downloadMedia(url, destDir, baseName) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`media fetch ${res.status} for ${url}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_VIDEO_BYTES) return null;
  const type = res.headers.get("content-type") || "";
  const ext = type.includes("mp4") ? "mp4"
    : type.includes("png") ? "png"
    : type.includes("gif") ? "gif"
    : type.includes("webp") ? "webp"
    : "jpg";
  const file = `${baseName}.${ext}`;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_VIDEO_BYTES) return null;
  await writeFile(path.join(destDir, file), buf);
  return file;
}

// ------------------------------------------------------------- fetch a post

async function fetchPost(id) {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndicationToken(id)}&lang=en`;
  const res = await fetchWithRetry(url);
  if (res.status === 404) throw new Error("post not found (deleted, protected, or wrong id)");
  if (!res.ok) throw new Error(`syndication API returned HTTP ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("post is unavailable (deleted, protected, or not a valid post id)");
  }
  if (!data || data.__typename === "TweetTombstone") {
    throw new Error("post is unavailable (age-restricted, withheld, or deleted)");
  }
  return data;
}

// ----------------------------------------------------- text → rendered HTML

function renderTextHtml(tweet) {
  const cps = Array.from(tweet.text || "");
  const [start, end] = tweet.display_text_range || [0, cps.length];
  const ents = [];
  for (const u of tweet.entities?.urls || []) ents.push({ i: u.indices, type: "url", e: u });
  for (const u of tweet.entities?.user_mentions || []) ents.push({ i: u.indices, type: "mention", e: u });
  for (const u of tweet.entities?.hashtags || []) ents.push({ i: u.indices, type: "hashtag" });
  for (const u of tweet.entities?.symbols || []) ents.push({ i: u.indices, type: "hashtag" });
  for (const u of tweet.entities?.media || []) ents.push({ i: u.indices, type: "media" });
  ents.sort((a, b) => a.i[0] - b.i[0]);

  let out = "";
  let pos = start;
  for (const ent of ents) {
    const [s, t] = ent.i;
    if (s < pos || s >= end) continue;
    out += escText(cps.slice(pos, s).join(""));
    const raw = cps.slice(s, Math.min(t, end)).join("");
    if (ent.type === "url") {
      out += `<a href="${esc(ent.e.expanded_url || ent.e.url)}" rel="noopener">${escText(ent.e.display_url || raw)}</a>`;
    } else if (ent.type === "mention") {
      out += `<a href="https://x.com/${esc(ent.e.screen_name)}" rel="noopener">@${escText(ent.e.screen_name)}</a>`;
    } else if (ent.type === "hashtag") {
      out += `<span class="tag">${escText(raw)}</span>`;
    }
    // media links are stripped; media is shown inline below the text
    pos = Math.min(t, end);
  }
  out += escText(cps.slice(pos, end).join(""));
  return out.replace(/\n/g, "<br>\n");
}

function fmtDate(iso) {
  const d = new Date(iso);
  const time = d.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  const date = d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `${time} UTC · ${date}`;
}

function fmtCount(n) {
  if (n == null) return null;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

// -------------------------------------------------------------- archive one

async function archivePost(id) {
  const raw = await fetchPost(id);
  const dir = path.join(ARCHIVE_DIR, id);
  await mkdir(dir, { recursive: true });

  const post = {
    id,
    url: `https://x.com/${raw.user.screen_name}/status/${id}`,
    author: { name: raw.user.name, screen_name: raw.user.screen_name },
    created_at: raw.created_at,
    archived_at: new Date().toISOString(),
    lang: raw.lang || "en",
    text: decodeEntities(
      Array.from(raw.text || "")
        .slice(...(raw.display_text_range || [0, undefined]))
        .join("")
    ),
    text_html: renderTextHtml(raw),
    stats: { likes: raw.favorite_count ?? null, replies: raw.conversation_count ?? null },
    in_reply_to: raw.in_reply_to_screen_name || null,
    media: [],
    quoted: null,
    avatar: null,
  };

  // strip t.co media links from the plain text — media is shown inline instead
  for (const md of raw.entities?.media || []) {
    if (md.url) post.text = post.text.replace(md.url, "").trim();
  }

  // avatar (try a higher-res variant first)
  const avatarUrl = raw.user.profile_image_url_https || "";
  if (avatarUrl) {
    try {
      post.avatar =
        (await downloadMedia(avatarUrl.replace("_normal.", "_200x200."), dir, "avatar").catch(() => null)) ||
        (await downloadMedia(avatarUrl, dir, "avatar"));
    } catch { /* page still works without an avatar */ }
  }

  // photos
  let n = 0;
  for (const p of raw.photos || []) {
    n++;
    try {
      const file =
        (await downloadMedia(`${p.url}?name=large`, dir, `photo-${n}`).catch(() => null)) ||
        (await downloadMedia(p.url, dir, `photo-${n}`));
      if (file) post.media.push({ type: "photo", file, width: p.width, height: p.height });
    } catch (e) {
      console.warn(`  warning: photo ${n} failed: ${e.message}`);
    }
  }

  // video (best mp4 variant up to 720p; poster always)
  if (raw.video) {
    let poster = null;
    try {
      poster = raw.video.poster ? await downloadMedia(raw.video.poster, dir, "poster") : null;
    } catch { /* keep going */ }
    const mp4s = (raw.video.variants || [])
      .filter((v) => v.type === "video/mp4")
      .map((v) => {
        const m = v.src.match(/\/(\d+)x(\d+)\//);
        return { src: v.src, h: m ? Number(m[2]) : 0 };
      })
      .sort((a, b) => b.h - a.h);
    const pick = mp4s.find((v) => v.h <= 720) || mp4s[mp4s.length - 1];
    let file = null;
    if (pick) {
      try {
        file = await downloadMedia(pick.src, dir, "video");
      } catch (e) {
        console.warn(`  warning: video download failed: ${e.message}`);
      }
    }
    post.media.push({ type: "video", file, poster, original: pick?.src || null });
  }

  // quoted post: snapshot text + author, keep photos too
  if (raw.quoted_tweet) {
    const q = raw.quoted_tweet;
    post.quoted = {
      url: `https://x.com/${q.user.screen_name}/status/${q.id_str}`,
      author: { name: q.user.name, screen_name: q.user.screen_name },
      created_at: q.created_at,
      text_html: renderTextHtml(q),
      media: [],
    };
    let qn = 0;
    for (const p of q.photos || []) {
      qn++;
      try {
        const file =
          (await downloadMedia(`${p.url}?name=large`, dir, `quoted-photo-${qn}`).catch(() => null)) ||
          (await downloadMedia(p.url, dir, `quoted-photo-${qn}`));
        if (file) post.quoted.media.push({ type: "photo", file, width: p.width, height: p.height });
      } catch { /* non-fatal */ }
    }
  }

  await writeFile(path.join(dir, "post.json"), JSON.stringify(post, null, 2));
  await writeFile(path.join(dir, "index.html"), renderPostPage(post));
  return post;
}

// ------------------------------------------------------------ page template

const SHARED_CSS = `
  :root{
    --ink:#141414; --paper:#faf8f4; --panel:#ffffff; --rule:#e4ded3;
    --muted:#6f6a60; --accent:#2f6f4f; --accent-soft:#e7efe9;
    --serif:"Iowan Old Style","Palatino Linotype","Book Antiqua",Georgia,serif;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    --mono:"SFMono-Regular",Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.55;font-size:17px}
  .wrap{max-width:640px;margin:0 auto;padding:0 20px}
  a{color:var(--accent)}
  header.site{padding:26px 0 18px;border-bottom:2px solid var(--ink);display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
  header.site .brand{font-family:var(--serif);font-weight:600;font-size:20px;letter-spacing:-.01em;color:var(--ink);text-decoration:none}
  header.site .sub{font-family:var(--mono);font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
  footer.site{padding:28px 0 56px;color:var(--muted);font-size:13px;border-top:1px solid var(--rule);margin-top:36px}
  footer.site a{color:var(--muted)}
`;

const POST_CSS = `
  .card{background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:24px 22px;margin:30px 0 18px}
  .who{display:flex;align-items:center;gap:12px;margin-bottom:14px}
  .who img{width:48px;height:48px;border-radius:50%;border:1px solid var(--rule)}
  .who .n{font-weight:700;line-height:1.2}
  .who .h{color:var(--muted);font-size:14px;font-family:var(--mono)}
  .reply-to{font-size:13.5px;color:var(--muted);margin:-4px 0 10px}
  .body{font-size:19px;line-height:1.5;white-space:normal;overflow-wrap:break-word}
  .body .tag{color:var(--accent)}
  .media{margin-top:16px;display:grid;gap:8px}
  .media.grid2{grid-template-columns:1fr 1fr}
  .media img,.media video{width:100%;height:auto;border-radius:6px;border:1px solid var(--rule);display:block}
  .quoted{border:1px solid var(--rule);border-radius:8px;padding:14px 16px;margin-top:16px;font-size:15.5px;background:var(--paper)}
  .quoted .qwho{font-size:13.5px;margin-bottom:6px}
  .quoted .qwho b{font-weight:700}
  .quoted .qwho span{color:var(--muted);font-family:var(--mono);font-size:12.5px}
  .meta{margin-top:16px;padding-top:14px;border-top:1px solid var(--rule);font-family:var(--mono);font-size:12.5px;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap}
  .origin{display:block;text-align:center;font-size:14px;margin:18px 0}
  .notice{background:var(--accent-soft);border:1px solid var(--rule);border-radius:6px;padding:12px 16px;font-size:13.5px;color:var(--muted);margin:0 0 8px}
`;

function pageShell({ title, description, ogImage, lang, body, canonicalPath, originUrl }) {
  return `<!DOCTYPE html>
<html lang="${esc(lang || "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${esc(SITE_BASE + canonicalPath)}">
${ogImage ? `<meta property="og:image" content="${esc(SITE_BASE + ogImage)}">` : ""}
<meta name="twitter:card" content="${ogImage ? "summary_large_image" : "summary"}">
<style>${SHARED_CSS}${POST_CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="site">
    <a class="brand" href="../">${esc(SITE_NAME)} · Post Archive</a>
    <span class="sub">Readable without an X account</span>
  </header>
${body}
  <footer class="site">
    <p>This page is a snapshot preserved for ${esc(SITE_NAME)} newsletter readers who don't have an X account.
    All content belongs to the original author${originUrl ? ` — <a href="${esc(originUrl)}" rel="noopener">view the original post on X</a>` : ""}.</p>
  </footer>
</div>
</body>
</html>
`;
}

function renderMedia(media, quoted = false) {
  const photos = media.filter((m) => m.type === "photo" && m.file);
  const videos = media.filter((m) => m.type === "video");
  let html = "";
  if (photos.length) {
    html += `<div class="media${photos.length > 1 ? " grid2" : ""}">`;
    for (const p of photos) {
      html += `<a href="${esc(p.file)}"><img src="${esc(p.file)}" alt="Image from the post" loading="lazy"${p.width ? ` width="${p.width}" height="${p.height}"` : ""}></a>`;
    }
    html += `</div>`;
  }
  for (const v of videos) {
    if (v.file) {
      html += `<div class="media"><video controls preload="metadata"${v.poster ? ` poster="${esc(v.poster)}"` : ""} src="${esc(v.file)}"></video></div>`;
    } else if (v.poster) {
      html += `<div class="media"><a href="${esc(v.original || "#")}" rel="noopener"><img src="${esc(v.poster)}" alt="Video preview — plays on X"></a><p style="font-size:13px;color:var(--muted);margin:4px 0 0">Video too large to archive — preview above links to the source.</p></div>`;
    }
  }
  return html;
}

function renderPostPage(post) {
  const title = `${post.author.name} (@${post.author.screen_name}) on X`;
  const description = post.text.length > 200 ? post.text.slice(0, 197) + "…" : post.text;
  const firstImage =
    post.media.find((m) => m.type === "photo" && m.file)?.file ||
    post.media.find((m) => m.type === "video")?.poster || null;

  let body = `  <article class="card" lang="${esc(post.lang)}">
    <div class="who">
      ${post.avatar ? `<img src="${esc(post.avatar)}" alt="">` : ""}
      <div>
        <div class="n">${esc(post.author.name)}</div>
        <div class="h">@${esc(post.author.screen_name)}</div>
      </div>
    </div>
    ${post.in_reply_to ? `<p class="reply-to">Replying to <a href="https://x.com/${esc(post.in_reply_to)}" rel="noopener">@${esc(post.in_reply_to)}</a></p>` : ""}
    <div class="body">${post.text_html}</div>
    ${renderMedia(post.media)}`;

  if (post.quoted) {
    body += `
    <div class="quoted">
      <div class="qwho"><b>${esc(post.quoted.author.name)}</b> <span>@${esc(post.quoted.author.screen_name)}</span></div>
      <div>${post.quoted.text_html}</div>
      ${renderMedia(post.quoted.media, true)}
      <p style="margin:8px 0 0;font-size:12.5px"><a href="${esc(post.quoted.url)}" rel="noopener">Quoted post on X</a></p>
    </div>`;
  }

  const stats = [];
  if (post.stats.likes != null) stats.push(`${fmtCount(post.stats.likes)} likes`);
  if (post.stats.replies != null) stats.push(`${fmtCount(post.stats.replies)} replies`);

  body += `
    <div class="meta">
      <span>${esc(fmtDate(post.created_at))}</span>
      ${stats.map((s) => `<span>${esc(s)}</span>`).join("\n      ")}
    </div>
  </article>
  <a class="origin" href="${esc(post.url)}" rel="noopener">View the original post on X →</a>
  <p class="notice">Snapshot captured ${esc(post.archived_at.slice(0, 10))}. Like/reply counts are frozen at capture time.</p>`;

  return pageShell({
    title,
    description,
    ogImage: firstImage ? `/x/${post.id}/${firstImage}` : null,
    lang: post.lang,
    body,
    canonicalPath: `/x/${post.id}/`,
    originUrl: post.url,
  });
}

// ------------------------------------------------------------- index page

const INDEX_CSS = `
  h1{font-family:var(--serif);font-weight:600;font-size:30px;letter-spacing:-.01em;margin:30px 0 8px}
  .dek{color:var(--muted);margin:0 0 26px;font-size:15.5px}
  .item{display:block;background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:16px 18px;margin:0 0 12px;text-decoration:none;color:var(--ink)}
  .item:hover{border-color:var(--accent)}
  .item .who{font-size:13.5px;margin-bottom:4px}
  .item .who b{font-weight:700}
  .item .who span{color:var(--muted);font-family:var(--mono);font-size:12px}
  .item .snip{font-size:15.5px;line-height:1.45;color:#2a2a2a}
  .item .d{font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-top:8px}
  .item .m{font-family:var(--mono);font-size:11px;color:var(--accent);margin-left:10px}
  .empty{color:var(--muted);font-style:italic;padding:30px 0}
  .howto{background:var(--panel);border:1px solid var(--rule);border-left:3px solid var(--accent);border-radius:2px;padding:14px 18px;font-size:14px;color:var(--muted);margin:0 0 26px}
  .howto code{font-family:var(--mono);font-size:12px;background:#efe9df;padding:1px 5px;border-radius:3px}
`;

async function rebuildIndex() {
  const entries = [];
  for (const name of await readdir(ARCHIVE_DIR).catch(() => [])) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const post = JSON.parse(await readFile(path.join(ARCHIVE_DIR, name, "post.json"), "utf8"));
      entries.push(post);
    } catch { /* skip malformed */ }
  }
  entries.sort((a, b) => (a.archived_at < b.archived_at ? 1 : -1));

  const items = entries.map((p) => {
    const snip = p.text.length > 180 ? p.text.slice(0, 177) + "…" : p.text;
    const hasMedia = p.media?.some((m) => m.file || m.poster);
    return `    <a class="item" href="${p.id}/">
      <div class="who"><b>${esc(p.author.name)}</b> <span>@${esc(p.author.screen_name)}</span></div>
      <div class="snip">${esc(snip) || "<i>(media-only post)</i>"}</div>
      <div class="d">${esc(fmtDate(p.created_at))}${hasMedia ? `<span class="m">has media</span>` : ""}</div>
    </a>`;
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(SITE_NAME)} · Post Archive</title>
<style>${SHARED_CSS}${INDEX_CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="site">
    <a class="brand" href="./">${esc(SITE_NAME)} · Post Archive</a>
    <span class="sub">Readable without an X account</span>
  </header>
  <h1>Archived posts</h1>
  <p class="dek">Snapshots of X posts referenced in the newsletter, hosted here so every reader can open them — no account required.</p>
  <div class="howto">To archive a new post: run the <b>“Archive X post”</b> action in the
    <a href="https://github.com/${esc(REPO)}/actions/workflows/archive-x-post.yml">Actions tab</a>,
    or <a href="https://github.com/${esc(REPO)}/issues/new?title=Archive%20X%20post&labels=archive-x-post&body=Paste%20X%20links%20below%3A%0A%0A">open an issue</a> containing the links.</div>
${items.join("\n") || '  <p class="empty">Nothing archived yet.</p>'}
  <footer class="site">
    <p>Pages on this archive are snapshots preserved for ${esc(SITE_NAME)} newsletter readers.
    All content belongs to its original authors; every page links to its original post on X.</p>
  </footer>
</div>
</body>
</html>
`;
  await writeFile(path.join(ARCHIVE_DIR, "index.html"), html);
  return entries.length;
}

// --------------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  const text = argv[0] === "--text" ? argv.slice(1).join(" ") : argv.join(" ");
  const ids = extractIds(text);

  if (!ids.length) {
    console.error("No X/Twitter post links or ids found in input.");
    console.error('Usage: node scripts/archive-x-post.mjs "https://x.com/user/status/123..." [...]');
    process.exit(2);
  }

  await mkdir(ARCHIVE_DIR, { recursive: true });
  let failures = 0;
  for (const id of ids) {
    try {
      console.log(`Archiving ${id} ...`);
      const post = await archivePost(id);
      console.log(`ARCHIVED ${id} x/${id}/ (@${post.author.screen_name})`);
    } catch (e) {
      failures++;
      console.error(`FAILED ${id}: ${e.message}`);
    }
  }
  const total = await rebuildIndex();
  console.log(`Index rebuilt: ${total} archived post(s).`);
  if (failures && failures === ids.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
