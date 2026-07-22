# Superhuman Insights

Internal analytics and reader-facing tools for the Superhuman AI newsletter.

- **`index.html`** — the 30-send engagement review.
- **`x/`** — the **X Post Archive**: login-free, permanent snapshots of X posts
  referenced in the newsletter, so readers without an X account can open them.

## X Post Archive

X blocks logged-out viewing, which dead-ends readers who don't have an account.
This archive fixes that: paste an X link, and it becomes a clean static page on
this site — text, images, and video preserved — that anyone can read.

Archive index: `https://tstavet.github.io/superhuman-insights/x/`
Each post lives at: `https://tstavet.github.io/superhuman-insights/x/<post-id>/`
— that's the link to put in the newsletter.

### Archiving a post (two ways, no terminal needed)

1. **Actions tab** — open [Actions → Archive X post](../../actions/workflows/archive-x-post.yml),
   click *Run workflow*, paste one or more X links, run. The workflow fetches the
   post(s), commits the pages, and GitHub Pages redeploys automatically
   (~1–2 minutes).
2. **Open an issue** — use the *Archive X post* issue template (works well from a
   phone), paste the links in the body, and submit. The bot archives them,
   replies to the issue with the reader-friendly URLs, and closes it.
   Issue-triggered archiving only runs for the repo owner and collaborators.

You can also run it locally:

```
node scripts/archive-x-post.mjs "https://x.com/user/status/123456789..."
```

### What gets captured

- Post text (links, @mentions, and hashtags rendered), author name/handle/avatar
- Photos (full resolution) and video (up to 720p MP4, capped at 80 MB —
  oversized video falls back to a poster image linking to the source)
- Quoted posts (text + photos)
- Like/reply counts and timestamp, frozen at capture time

Everything is downloaded **into the repo**, so archived pages keep working even
if the original post is later deleted or X tightens access further. Every page
links back to the original post and credits the author.

### How it works

`scripts/archive-x-post.mjs` (Node 18+, zero dependencies) pulls the post from
X's public syndication endpoint — the same one embedded tweets use, no API key
or account required — saves media alongside a `post.json` snapshot, renders a
static page per post, and rebuilds the archive index.

### One-time setup

GitHub Pages must be enabled: **Settings → Pages → Deploy from a branch →
`main` / root**. (If it's already serving `index.html`, nothing to do.)

### Notes

- Archived pages carry `noindex` so search engines don't treat the archive as
  the canonical source.
- Very long posts ("notes"/articles on X) are truncated by the public endpoint;
  the page always links to the original.
- Re-archiving the same link overwrites the snapshot (useful to refresh stats).
