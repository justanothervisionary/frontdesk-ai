// Thin wrapper over the GitHub Contents API - this is how a paid signup's
// config gets published: the webhook commits configs/{key}.json straight to
// the repo, which triggers the existing Vercel auto-deploy-on-push. No new
// database - reuses the exact pipeline that already publishes every other
// config today, just done by an API call instead of by hand.
//
// Requires GITHUB_TOKEN (a fine-grained PAT scoped to just this repo,
// Contents: Read & Write only), GITHUB_OWNER, GITHUB_REPO, and optionally
// GITHUB_BRANCH (defaults to "main").
const GITHUB_API = "https://api.github.com";

function ghHeaders() {
  return {
    "Authorization": "Bearer " + process.env.GITHUB_TOKEN,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json"
  };
}

function repoContentsUrl(filePath) {
  var owner = process.env.GITHUB_OWNER;
  var repo = process.env.GITHUB_REPO;
  return GITHUB_API + "/repos/" + owner + "/" + repo + "/contents/" + filePath;
}

// Returns { sha, content } (content already decoded to a UTF-8 string), or
// null if the file doesn't exist yet.
async function getFile(filePath) {
  var branch = process.env.GITHUB_BRANCH || "main";
  var res = await fetch(repoContentsUrl(filePath) + "?ref=" + encodeURIComponent(branch), { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("GitHub getFile failed (" + res.status + "): " + await res.text().catch(function () { return ""; }));
  var data = await res.json();
  return { sha: data.sha, content: Buffer.from(data.content, "base64").toString("utf8") };
}

// Creates the file if `sha` is omitted, otherwise updates it. Throws with
// `.conflict = true` on a 409 (the file moved since the caller last read its
// sha) so callers can decide whether to re-fetch-and-retry rather than
// silently overwriting something newer.
async function putFile(filePath, jsonObj, message, sha) {
  var branch = process.env.GITHUB_BRANCH || "main";
  var body = {
    message: message,
    content: Buffer.from(JSON.stringify(jsonObj, null, 2) + "\n", "utf8").toString("base64"),
    branch: branch
  };
  if (sha) body.sha = sha;

  var res = await fetch(repoContentsUrl(filePath), { method: "PUT", headers: ghHeaders(), body: JSON.stringify(body) });
  if (res.status === 409) {
    var conflictErr = new Error("GitHub putFile conflict - file changed since it was last read");
    conflictErr.conflict = true;
    throw conflictErr;
  }
  if (!res.ok) throw new Error("GitHub putFile failed (" + res.status + "): " + await res.text().catch(function () { return ""; }));
  return res.json();
}

module.exports = { getFile, putFile };
