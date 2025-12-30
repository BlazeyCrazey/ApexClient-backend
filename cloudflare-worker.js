// Apex Client User Manager - Cloudflare Worker
// Deploy this to Cloudflare Workers (free tier: 100k requests/day)

// Configuration - Set these as environment variables in Cloudflare dashboard
// GITHUB_TOKEN: Your GitHub Personal Access Token with repo scope
// GITHUB_REPO: "BlazeyCrazey/ApexClient-backend"

const GITHUB_API = "https://api.github.com";

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /debug - Check if secrets are configured
      if (path === "/debug" && request.method === "GET") {
        return jsonResponse({
          hasToken: !!env.GITHUB_TOKEN,
          hasRepo: !!env.GITHUB_REPO,
          repo: env.GITHUB_REPO || "NOT SET",
          tokenPrefix: env.GITHUB_TOKEN ? env.GITHUB_TOKEN.substring(0, 4) + "..." : "NOT SET"
        });
      }

      // GET /users - Get list of online users
      if (path === "/users" && request.method === "GET") {
        return await getUsers(env);
      }

      // POST /register - Add user to online list
      if (path === "/register" && request.method === "POST") {
        const body = await request.json();
        if (!body.uuid || !isValidUUID(body.uuid)) {
          return jsonResponse({ error: "Invalid UUID" }, 400);
        }
        return await addUser(env, body.uuid);
      }

      // POST /unregister - Remove user from online list
      if (path === "/unregister" && request.method === "POST") {
        const body = await request.json();
        if (!body.uuid || !isValidUUID(body.uuid)) {
          return jsonResponse({ error: "Invalid UUID" }, 400);
        }
        return await removeUser(env, body.uuid);
      }

      // GET /news - Get news feed (Atom format for launcher)
      if (path === "/news" && request.method === "GET") {
        return await getNewsFeed(env);
      }

      // GET /news.json - Get news in JSON format
      if (path === "/news.json" && request.method === "GET") {
        return await getNewsJson(env);
      }

      // GET /updates - Get latest version info
      if (path === "/updates" && request.method === "GET") {
        return await getLatestVersion(env);
      }

      // GET /updates/latest - Get latest release info
      if (path === "/updates/latest" && request.method === "GET") {
        return await getLatestVersion(env);
      }

      return jsonResponse({ error: "Not found" }, 404);

    } catch (error) {
      console.error("Error:", error);
      return jsonResponse({ error: "Internal server error" }, 500);
    }
  },
};

function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function getGitHubFile(env, path) {
  const response = await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/contents/${path}`, {
    headers: {
      "Authorization": `token ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "ApexClient-Worker",
    },
  });

  if (response.status === 404) {
    return { content: null, sha: null };
  }

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const data = await response.json();
  const content = JSON.parse(atob(data.content.replace(/\n/g, "")));
  return { content, sha: data.sha };
}

async function updateGitHubFile(env, path, content, sha, message) {
  const body = {
    message,
    content: btoa(JSON.stringify(content, null, 2)),
  };

  if (sha) {
    body.sha = sha;
  }

  const response = await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      "Authorization": `token ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "ApexClient-Worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error: ${response.status} - ${error}`);
  }

  return await response.json();
}

async function getUsers(env) {
  try {
    const { content } = await getGitHubFile(env, "users.json");
    return jsonResponse(content || { users: [] });
  } catch (error) {
    return jsonResponse({ users: [] });
  }
}

async function addUser(env, uuid) {
  try {
    const { content, sha } = await getGitHubFile(env, "users.json");

    let users = content || { users: [] };

    // Add user if not already present
    if (!users.users.includes(uuid)) {
      users.users.push(uuid);
      await updateGitHubFile(env, "users.json", users, sha, `Add user ${uuid}`);
    }

    return jsonResponse({ success: true, message: "User registered" });
  } catch (error) {
    console.error("Error adding user:", error);
    return jsonResponse({ error: "Failed to register user" }, 500);
  }
}

async function removeUser(env, uuid) {
  try {
    const { content, sha } = await getGitHubFile(env, "users.json");

    if (!content) {
      return jsonResponse({ success: true, message: "User not found" });
    }

    // Remove user
    const index = content.users.indexOf(uuid);
    if (index > -1) {
      content.users.splice(index, 1);
      await updateGitHubFile(env, "users.json", content, sha, `Remove user ${uuid}`);
    }

    return jsonResponse({ success: true, message: "User unregistered" });
  } catch (error) {
    console.error("Error removing user:", error);
    return jsonResponse({ error: "Failed to unregister user" }, 500);
  }
}

// ==================== NEWS FUNCTIONS ====================

/**
 * Get news feed in Atom format (for PrismLauncher's NewsChecker)
 */
async function getNewsFeed(env) {
  try {
    const { content } = await getGitHubFile(env, "news.json");
    const news = content || { articles: [] };

    // Generate Atom feed XML
    const atomFeed = generateAtomFeed(news.articles);

    return new Response(atomFeed, {
      status: 200,
      headers: {
        "Content-Type": "application/atom+xml; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("Error fetching news:", error);
    // Return empty feed on error
    const emptyFeed = generateAtomFeed([]);
    return new Response(emptyFeed, {
      status: 200,
      headers: {
        "Content-Type": "application/atom+xml; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}

/**
 * Get news in JSON format
 */
async function getNewsJson(env) {
  try {
    const { content } = await getGitHubFile(env, "news.json");
    return jsonResponse(content || { articles: [] });
  } catch (error) {
    return jsonResponse({ articles: [] });
  }
}

/**
 * Generate Atom feed XML from articles
 */
function generateAtomFeed(articles) {
  const now = new Date().toISOString();

  let entries = "";
  for (const article of articles) {
    const date = article.date || now;
    const id = article.id || `apex-news-${Date.parse(date)}`;
    entries += `
  <entry>
    <title>${escapeXml(article.title || "Untitled")}</title>
    <id>${escapeXml(id)}</id>
    <updated>${date}</updated>
    <content type="html">${escapeXml(article.content || "")}</content>
    <link href="${escapeXml(article.link || "https://github.com/BlazeyCrazey/ApexClient")}" />
  </entry>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Apex Client News</title>
  <subtitle>Latest news and updates from Apex Client</subtitle>
  <id>https://apexclient-backend.blazerkey106.workers.dev/news</id>
  <updated>${now}</updated>
  <link href="https://apexclient-backend.blazerkey106.workers.dev/news" rel="self" />
  <link href="https://github.com/BlazeyCrazey/ApexClient" />
  <author>
    <name>Apex Client Team</name>
  </author>${entries}
</feed>`;
}

/**
 * Escape special XML characters
 */
function escapeXml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ==================== UPDATE FUNCTIONS ====================

/**
 * Get latest version info for update checking
 */
async function getLatestVersion(env) {
  try {
    const { content } = await getGitHubFile(env, "version.json");

    if (!content) {
      // Return default version info if file doesn't exist
      return jsonResponse({
        version: "1.0.0-beta",
        version_tag: "beta-1.0.0",
        release_date: new Date().toISOString(),
        download_url: "https://github.com/BlazeyCrazey/ApexClient/releases",
        release_notes: "Initial beta release of Apex Client.",
        required: false
      });
    }

    return jsonResponse(content);
  } catch (error) {
    console.error("Error fetching version:", error);
    return jsonResponse({
      version: "1.0.0-beta",
      version_tag: "beta-1.0.0",
      release_date: new Date().toISOString(),
      download_url: "https://github.com/BlazeyCrazey/ApexClient/releases",
      release_notes: "Initial beta release of Apex Client.",
      required: false
    });
  }
}
