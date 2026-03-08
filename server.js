const express = require("express");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const GITHUB_OWNER = String(process.env.GITHUB_OWNER || "miksik454").trim();
const GITHUB_REPO = String(process.env.GITHUB_REPO || "zora-client-files").trim();
const GITHUB_TOKEN = String(process.env.GITHUB_TOKEN || "").trim();
const DEFAULT_BRANCH = String(process.env.GITHUB_BRANCH || "main").trim() || "main";
const BRANCHES = Array.from(
  new Set(
    [
      DEFAULT_BRANCH,
      ...String(process.env.GITHUB_BRANCHES || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
      "master",
    ].filter(Boolean)
  )
);

const MANIFEST_PATHS = String(process.env.MANIFEST_PATHS || "manifest.json,dist/manifest.json")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const LAUNCHER_UPDATE_PATHS = String(process.env.LAUNCHER_UPDATE_PATHS || "launcher-update.json,dist/launcher-update.json")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

function buildGithubHeaders(accept = "application/vnd.github+json") {
  const headers = {
    "User-Agent": "zora-update-proxy",
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  return headers;
}

function encodeRepoPath(repoPath) {
  return repoPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function normalizeRepoPath(input) {
  let value = String(input || "").trim();
  if (!value) return "";

  try {
    value = decodeURIComponent(value);
  } catch {
    // keep original value
  }

  value = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!value || value.includes("\0")) return "";

  const segments = value.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      return "";
    }
  }

  return segments.join("/");
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function getContentsMeta(repoPath) {
  const normalized = normalizeRepoPath(repoPath);
  if (!normalized) {
    throw new Error("Invalid repository path");
  }

  const encodedPath = encodeRepoPath(normalized);
  const errors = [];

  for (const branch of BRANCHES) {
    const encodedBranch = encodeURIComponent(branch);
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}?ref=${encodedBranch}`;
    const response = await fetch(url, {
      headers: buildGithubHeaders("application/vnd.github+json"),
    });

    if (response.ok) {
      const meta = await response.json();
      return { meta, branch };
    }

    const details = (await safeReadText(response)).slice(0, 300);
    errors.push(`${normalized}@${branch}: ${response.status} ${details}`);
  }

  throw new Error(errors.join(" | "));
}

async function downloadBlobBySha(sha) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs/${sha}`;
  const response = await fetch(url, {
    headers: buildGithubHeaders("application/vnd.github+json"),
  });
  if (!response.ok) {
    const details = await safeReadText(response);
    throw new Error(`Blob download failed: ${response.status} ${details.slice(0, 300)}`);
  }

  const payload = await response.json();
  if (payload.encoding !== "base64" || typeof payload.content !== "string") {
    throw new Error("Unexpected blob encoding");
  }
  return Buffer.from(payload.content.replace(/\n/g, ""), "base64");
}

async function downloadRepoFile(repoPath) {
  const normalized = normalizeRepoPath(repoPath);
  const { meta, branch } = await getContentsMeta(normalized);

  if (typeof meta.content === "string" && meta.content.length > 0 && meta.encoding === "base64") {
    return {
      buffer: Buffer.from(meta.content.replace(/\n/g, ""), "base64"),
      meta,
      branch,
      source: "contents-base64",
    };
  }

  if (meta.download_url) {
    const response = await fetch(meta.download_url, {
      headers: buildGithubHeaders("application/octet-stream"),
    });
    if (!response.ok) {
      const details = await safeReadText(response);
      throw new Error(`Raw download failed: ${response.status} ${details.slice(0, 300)}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      meta,
      branch,
      source: "download-url",
    };
  }

  if (meta.sha) {
    const buffer = await downloadBlobBySha(meta.sha);
    return { buffer, meta, branch, source: "git-blob" };
  }

  throw new Error("No supported download method for file");
}

async function loadJsonFromCandidates(paths) {
  const errors = [];

  for (const repoPath of paths) {
    const normalized = normalizeRepoPath(repoPath);
    if (!normalized) continue;
    try {
      const file = await downloadRepoFile(normalized);
      const text = file.buffer.toString("utf8");
      const json = JSON.parse(text);
      return { json, path: normalized, branch: file.branch, source: file.source };
    } catch (error) {
      errors.push(`${normalized}: ${error.message}`);
    }
  }

  throw new Error(errors.join(" | "));
}

function fail(res, status, message) {
  res.status(status).json({ ok: false, error: String(message || "Unknown error") });
}

if (!GITHUB_OWNER || !GITHUB_REPO) {
  // Keep service booting but signal misconfiguration.
  // Token may be optional for public repos.
  console.warn("GITHUB_OWNER/GITHUB_REPO are required.");
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "zora-update-proxy",
    repo: `${GITHUB_OWNER}/${GITHUB_REPO}`,
    defaultBranch: DEFAULT_BRANCH,
    tokenConfigured: Boolean(GITHUB_TOKEN),
  });
});

app.get(["/manifest", "/manifest.json"], async (req, res) => {
  try {
    const queryPath = normalizeRepoPath(req.query.path);
    const candidates = queryPath ? [queryPath] : MANIFEST_PATHS;
    const payload = await loadJsonFromCandidates(candidates);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Source-Path", payload.path);
    res.setHeader("X-Source-Branch", payload.branch);
    res.send(JSON.stringify(payload.json));
  } catch (error) {
    fail(res, 502, `Manifest unavailable: ${error.message}`);
  }
});

app.get(["/launcher-update", "/launcher-update.json"], async (req, res) => {
  try {
    const queryPath = normalizeRepoPath(req.query.path);
    const candidates = queryPath ? [queryPath] : LAUNCHER_UPDATE_PATHS;
    const payload = await loadJsonFromCandidates(candidates);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("X-Source-Path", payload.path);
    res.setHeader("X-Source-Branch", payload.branch);
    res.send(JSON.stringify(payload.json));
  } catch (error) {
    fail(res, 502, `Launcher update metadata unavailable: ${error.message}`);
  }
});

app.get("/file", async (req, res) => {
  try {
    const repoPath = normalizeRepoPath(req.query.path);
    if (!repoPath) {
      return fail(res, 400, "Query parameter 'path' is required");
    }

    const file = await downloadRepoFile(repoPath);
    const filename = path.basename(repoPath);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(file.buffer.length));
    res.setHeader("Content-Disposition", `inline; filename=\"${filename}\"`);
    res.setHeader("X-Source-Path", repoPath);
    res.setHeader("X-Source-Branch", file.branch);
    res.end(file.buffer);
  } catch (error) {
    fail(res, 502, `File unavailable: ${error.message}`);
  }
});

app.get("/file/*", async (req, res) => {
  try {
    const repoPath = normalizeRepoPath(req.params[0]);
    if (!repoPath) {
      return fail(res, 400, "Invalid file path");
    }

    const file = await downloadRepoFile(repoPath);
    const filename = path.basename(repoPath);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(file.buffer.length));
    res.setHeader("Content-Disposition", `inline; filename=\"${filename}\"`);
    res.setHeader("X-Source-Path", repoPath);
    res.setHeader("X-Source-Branch", file.branch);
    res.end(file.buffer);
  } catch (error) {
    fail(res, 502, `File unavailable: ${error.message}`);
  }
});

app.use((err, _req, res, _next) => {
  fail(res, 500, err && err.message ? err.message : "Internal error");
});

app.listen(PORT, () => {
  console.log(
    `[zora-update-proxy] listening on :${PORT}, repo=${GITHUB_OWNER}/${GITHUB_REPO}, branches=${BRANCHES.join(",")}`
  );
});
