/**
 * fetchGitHubStatus.js
 *
 * Fetches live GitHub profile data via the REST API and renders two SVG stat
 * cards into the `stats/` directory:
 *   - stats.svg      — repo count, stars, followers, contribution estimate
 *   - top-langs.svg  — top languages by byte count across public repos
 *
 * Usage:
 *   node scripts/fetchGitHubStatus.js [username]
 *
 * Set GITHUB_TOKEN in the environment to raise the rate limit from 60 → 5 000
 * requests/hour.
 */

const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const USERNAME = process.argv[2] || "H-Yeasin";
const STATS_DIR = path.resolve(__dirname, "..", "stats");
const CARD_WIDTH = 430;
const CARD_HEIGHT = 180;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Lightweight HTTPS GET that returns the parsed JSON body.
 * Respects GITHUB_TOKEN for authenticated rate limits.
 */
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent": "fetchGitHubStatus/1.0",
      Accept: "application/vnd.github.v3+json",
    };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;
    }

    https
      .get(url, { headers }, (res) => {
        // Follow redirects (GitHub may redirect renamed users)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchJSON(res.headers.location).then(resolve, reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }

        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

/** Fetch every page of a paginated endpoint (max 15 pages to stay safe). */
async function fetchAllPages(baseUrl) {
  const results = [];
  let page = 1;
  const maxPages = 15;

  while (page <= maxPages) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${sep}per_page=100&page=${page}`;
    const batch = await fetchJSON(url);
    if (!Array.isArray(batch) || batch.length === 0) break;
    results.push(...batch);
    page++;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

/** Fetch the core user profile (followers, public_repos, public_gists, …). */
async function fetchUserProfile(username) {
  return fetchJSON(`https://api.github.com/users/${encodeURIComponent(username)}`);
}

/** Fetch all public repos for the user. */
async function fetchRepos(username) {
  return fetchAllPages(
    `https://api.github.com/users/${encodeURIComponent(username)}/repos`
  );
}

/**
 * Return an estimate of contributions in the last year.
 * Uses the /events endpoint as a heuristic — not perfectly accurate but serves
 * as a reasonable approximation without GraphQL auth.
 */
async function fetchContributionEstimate(username) {
  try {
    const events = await fetchAllPages(
      `https://api.github.com/users/${encodeURIComponent(username)}/events`
    );

    const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const recent = events.filter(
      (e) =>
        new Date(e.created_at).getTime() > oneYearAgo &&
        ["PushEvent", "PullRequestEvent", "IssuesEvent", "CreateEvent"].includes(
          e.type
        )
    );

    // For PushEvents each event can contain multiple commits
    let count = 0;
    for (const e of recent) {
      if (e.type === "PushEvent") {
        count += e.payload?.commits?.length ?? 0;
      } else {
        count += 1;
      }
    }
    return count;
  } catch {
    return null; // Non-critical — the card will show "—" for this field
  }
}

/** Aggregate language bytes across repos, returning a sorted { lang: bytes } map. */
function aggregateLanguages(repos) {
  const totals = Object.create(null);

  for (const repo of repos) {
    if (!repo.language || repo.fork) continue;
    const lang = repo.language;
    totals[lang] = (totals[lang] ?? 0) + (repo.size ?? 0);
  }

  // Sort descending by byte count, keep top 6
  return Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

/** Escape text so it renders safely inside SVG. */
function svgEscape(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Language → hex colour map (subset — extended as needed). */
const LANG_COLORS = {
  Dart: "#00B4AB",
  C: "#555555",
  "C++": "#F34B7D",
  "C#": "#178600",
  CMake: "#DA3434",
  CSS: "#563D7C",
  Dockerfile: "#384D54",
  Go: "#00ADD8",
  HTML: "#E34C26",
  Java: "#B07219",
  JavaScript: "#F1E05A",
  Kotlin: "#A97BFF",
  Makefile: "#427819",
  "Objective-C": "#438EFF",
  PHP: "#4F5D95",
  Python: "#3572A5",
  Ruby: "#701516",
  Rust: "#DEA584",
  Shell: "#89E051",
  Swift: "#F05138",
  TypeScript: "#3178C6",
};

/** Pick a deterministic colour for a language name. */
function langColor(name) {
  return LANG_COLORS[name] ?? "#858585";
}

/** Format large numbers compactly (1 200 → "1.2k", 1 500 000 → "1.5M"). */
function compactNum(n) {
  if (n == null) return "—"; // em-dash
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

/**
 * Render the main stats card SVG.
 *
 * Layout (left → right):
 *   ┌──────────────────────────────────────┐
 *   │  ◉ USERNAME's GitHub Stats           │
 *   │                                      │
 *   │  Repos    Stars   Followers   Contrib │
 *   │   42       89       120        1.2k   │
 *   │                                      │
 *   │  ── Updated: 2025-03-09             │
 *   └──────────────────────────────────────┘
 */
function renderStatsCard(profile, totalStars, contributions) {
  const stats = [
    { label: "Repos", value: compactNum(profile.public_repos) },
    { label: "Stars", value: compactNum(totalStars) },
    { label: "Followers", value: compactNum(profile.followers) },
    { label: "Contrib.", value: contributions != null ? compactNum(contributions) : "—" },
  ];

  const statWidth = CARD_WIDTH / stats.length;
  const now = new Date().toISOString().slice(0, 10);

  const lines = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">`);
  // Card background with subtle rounded rect + border
  lines.push(`  <rect x="0" y="0" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="12" fill="#0D1117" stroke="#30363D" stroke-width="1.5"/>`);
  // Title
  lines.push(`  <text x="20" y="38" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="bold" fill="#F0F6FC">${svgEscape(profile.login)}'s GitHub Stats</text>`);

  // Stat boxes
  for (let i = 0; i < stats.length; i++) {
    const cx = statWidth * i + statWidth / 2;
    const labelY = 85;
    const valueY = 125;

    lines.push(`  <text x="${cx}" y="${labelY}" font-family="Arial, Helvetica, sans-serif" font-size="13" fill="#8B949E" text-anchor="middle">${svgEscape(stats[i].label)}</text>`);
    lines.push(`  <text x="${cx}" y="${valueY}" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="bold" fill="#58A6FF" text-anchor="middle">${svgEscape(stats[i].value)}</text>`);
  }

  // Footer
  lines.push(`  <line x1="20" y1="148" x2="${CARD_WIDTH - 20}" y2="148" stroke="#21262D" stroke-width="1"/>`);
  lines.push(`  <text x="20" y="170" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="#484F58">Updated: ${now}</text>`);
  lines.push(`</svg>`);

  return lines.join("\n");
}

/**
 * Render the top-languages card SVG.
 *
 * Layout:
 *   ┌──────────────────────────────────────┐
 *   │  ◉ Top Languages                     │
 *   │                                      │
 *   │  Dart     ████████████████  72%      │
 *   │  Swift    ██████           18%      │
 *   │  C++      ███               6%      │
 *   │  Python   ██                4%      │
 *   └──────────────────────────────────────┘
 */
function renderLanguagesCard(langs) {
  const total = langs.reduce((sum, [, bytes]) => sum + bytes, 0);
  const barLeft = 130;
  const barMaxWidth = CARD_WIDTH - barLeft - 70;
  const rowHeight = 36;
  const startY = 52;
  const cardHeight = startY + langs.length * rowHeight + 24;

  const lines = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${cardHeight}" viewBox="0 0 ${CARD_WIDTH} ${cardHeight}">`);
  lines.push(`  <rect x="0" y="0" width="${CARD_WIDTH}" height="${cardHeight}" rx="12" fill="#0D1117" stroke="#30363D" stroke-width="1.5"/>`);
  lines.push(`  <text x="20" y="32" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="bold" fill="#F0F6FC">Top Languages</text>`);

  for (let i = 0; i < langs.length; i++) {
    const [lang, bytes] = langs[i];
    const pct = total > 0 ? bytes / total : 0;
    const barW = Math.max(pct * barMaxWidth, 2); // minimum visible sliver
    const y = startY + i * rowHeight;
    const color = langColor(lang);

    lines.push(`  <text x="20" y="${y + 18}" font-family="Arial, Helvetica, sans-serif" font-size="13" fill="#C9D1D9">${svgEscape(lang)}</text>`);
    lines.push(`  <rect x="${barLeft}" y="${y + 5}" width="${barW}" height="16" rx="3" fill="${color}"/>`);
    lines.push(`  <text x="${barLeft + barW + 8}" y="${y + 18}" font-family="Arial, Helvetica, sans-serif" font-size="12" fill="#8B949E">${(pct * 100).toFixed(1)}%</text>`);
  }

  lines.push(`</svg>`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Fetching GitHub data for @${USERNAME} …\n`);

  // 1. Fetch profile + repos in parallel
  const [profile, repos] = await Promise.all([
    fetchUserProfile(USERNAME),
    fetchRepos(USERNAME),
  ]);

  console.log(`  Profile         : ${profile.name ?? profile.login}`);
  console.log(`  Public repos    : ${profile.public_repos}`);
  console.log(`  Followers       : ${profile.followers}`);
  console.log(`  Following       : ${profile.following}`);

  // 2. Derived stats
  const totalStars = repos.reduce((sum, r) => sum + (r.stargazers_count ?? 0), 0);
  console.log(`  Total stars     : ${totalStars}`);

  // 3. Contributions (non-critical — won't fail the build)
  const contributions = await fetchContributionEstimate(USERNAME);
  if (contributions != null) {
    console.log(`  Est. contribs   : ${contributions}`);
  } else {
    console.log(`  Est. contribs   : (unavailable — set GITHUB_TOKEN for finer data)`);
  }

  // 4. Language aggregation
  const langs = aggregateLanguages(repos);
  console.log(`  Top languages   : ${langs.map(([l]) => l).join(", ")}`);

  // 5. Ensure output directory
  fs.mkdirSync(STATS_DIR, { recursive: true });

  // 6. Render & write SVGs
  const statsSvg = renderStatsCard(profile, totalStars, contributions);
  const langsSvg = renderLanguagesCard(langs);

  fs.writeFileSync(path.join(STATS_DIR, "stats.svg"), statsSvg, "utf8");
  fs.writeFileSync(path.join(STATS_DIR, "top-langs.svg"), langsSvg, "utf8");

  console.log(`\nWrote stats/stats.svg + stats/top-langs.svg`);
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
