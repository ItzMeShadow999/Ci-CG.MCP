const GH = "https://api.github.com";
const MAX_OUT = 80000;
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const CONFIRM_TTL_MS = 10 * 60 * 1000;
const enc = new TextEncoder();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
};

const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? "?" + s : "";
};

const encPath = (s) => String(s || "").split("/").map(encodeURIComponent).join("/");

const fromB64 = (s) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

const toB64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

function rp(a) {
  if (!NAME_RE.test(a.owner || "") || !NAME_RE.test(a.repo || "")) {
    throw new Error("owner and repo are required and must be valid names");
  }
  return `/repos/${a.owner}/${a.repo}`;
}

async function gh(env, method, path, body, accept) {
  const res = await fetch(GH + path, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: accept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-mcp-worker",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${res.status} ${method} ${path}: ${text.slice(0, 500)}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const slimRepo = (r) => ({
  full_name: r.full_name,
  private: r.private,
  description: r.description,
  language: r.language,
  default_branch: r.default_branch,
  pushed_at: r.pushed_at,
  archived: r.archived,
  html_url: r.html_url,
});

const slimIssue = (i) => ({
  number: i.number,
  title: i.title,
  state: i.state,
  user: i.user && i.user.login,
  labels: (i.labels || []).map((l) => (typeof l === "string" ? l : l.name)),
  comments: i.comments,
  created_at: i.created_at,
  updated_at: i.updated_at,
  html_url: i.html_url,
});

const slimPull = (p) => ({
  number: p.number,
  title: p.title,
  state: p.state,
  draft: p.draft,
  user: p.user && p.user.login,
  head: p.head && p.head.ref,
  base: p.base && p.base.ref,
  merged_at: p.merged_at,
  created_at: p.created_at,
  html_url: p.html_url,
});

const slimCommit = (c) => ({
  sha: c.sha,
  message: ((c.commit && c.commit.message) || "").split("\n")[0],
  author: c.commit && c.commit.author && c.commit.author.name,
  date: c.commit && c.commit.author && c.commit.author.date,
  html_url: c.html_url,
});

const stable = (v) =>
  v && typeof v === "object"
    ? Array.isArray(v)
      ? "[" + v.map(stable).join(",") + "]"
      : "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}"
    : JSON.stringify(v);

async function sign(env, name, args, exp) {
  const key = await crypto.subtle.importKey("raw", enc.encode("confirm:" + env.ACCESS_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${name}|${exp}|${stable(args)}`)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeToken(env, name, args) {
  const exp = Date.now() + CONFIRM_TTL_MS;
  return `${exp}.${await sign(env, name, args, exp)}`;
}

async function checkToken(env, name, args, tok) {
  const [exp, sig] = String(tok || "").split(".");
  if (!/^\d+$/.test(exp || "") || !sig || Date.now() > Number(exp)) return false;
  return safeEq(sig, await sign(env, name, args, exp));
}

function lineDiff(oldText, newText) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const ma = a.slice(s, ea);
  const mb = b.slice(s, eb);
  if (!ma.length && !mb.length) return { added: 0, removed: 0, text: "(no changes)" };
  const ops = [];
  if (ma.length * mb.length > 4e6) {
    ma.forEach((l) => ops.push(["-", l]));
    mb.forEach((l) => ops.push(["+", l]));
  } else {
    const n = ma.length;
    const m = mb.length;
    const w = m + 1;
    const dp = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = ma[i] === mb[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) {
        ops.push([" ", ma[i]]);
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) ops.push(["-", ma[i++]]);
      else ops.push(["+", mb[j++]]);
    }
    while (i < n) ops.push(["-", ma[i++]]);
    while (j < m) ops.push(["+", mb[j++]]);
  }
  const all = [
    ...a.slice(Math.max(0, s - 2), s).map((l) => [" ", l]),
    ...ops,
    ...a.slice(ea, ea + 2).map((l) => [" ", l]),
  ];
  const out = [];
  for (let k = 0; k < all.length; ) {
    if (all[k][0] !== " ") {
      out.push(all[k][0] + " " + all[k][1]);
      k++;
      continue;
    }
    let e = k;
    while (e < all.length && all[e][0] === " ") e++;
    const run = all.slice(k, e);
    if (run.length > 6 && k > 0 && e < all.length) {
      run.slice(0, 3).forEach((x) => out.push("  " + x[1]));
      out.push("  ...");
      run.slice(-3).forEach((x) => out.push("  " + x[1]));
    } else run.forEach((x) => out.push("  " + x[1]));
    k = e;
  }
  const CAP = 250;
  const text = out.slice(0, CAP).join("\n") + (out.length > CAP ? `\n...[diff truncated, ${out.length - CAP} more lines]` : "");
  return {
    added: ops.filter((o) => o[0] === "+").length,
    removed: ops.filter((o) => o[0] === "-").length,
    text,
  };
}

async function fileState(a, env) {
  const p = rp(a);
  const path = encPath(a.path);
  if (!a.path) throw new Error("path is required");
  const repo = await gh(env, "GET", p);
  const branch = a.branch || repo.default_branch;
  if (a.branch) await gh(env, "GET", `${p}/branches/${encPath(a.branch)}`);
  let cur = null;
  try {
    const c = await gh(env, "GET", `${p}/contents/${path}${qs({ ref: branch })}`);
    if (Array.isArray(c) || c.type !== "file") throw new Error(`${a.path} is a directory or not a regular file`);
    cur = { sha: c.sha, size: c.size, text: c.content ? fromB64(c.content) : null };
  } catch (e) {
    if (!/^GitHub 404/.test(String(e.message))) throw e;
  }
  return { p, path, repo, branch, isDefault: branch === repo.default_branch, cur };
}

const branchLine = (s) =>
  `Branch: ${s.branch}` + (s.isDefault ? "  (DEFAULT BRANCH: this pushes straight to it)" : "");

function applyEdits(text, edits) {
  if (!Array.isArray(edits) || !edits.length) throw new Error("edits must be a non-empty array of {old_str, new_str}");
  let out = text;
  edits.forEach((e, i) => {
    if (!e || typeof e.old_str !== "string" || e.old_str === "" || typeof e.new_str !== "string") {
      throw new Error(`edit #${i + 1}: old_str (non-empty) and new_str are required strings`);
    }
    const n = out.split(e.old_str).length - 1;
    if (n === 0) throw new Error(`edit #${i + 1}: old_str not found in file`);
    if (n > 1 && !e.replace_all) {
      throw new Error(`edit #${i + 1}: old_str matches ${n} places; add more context or set replace_all`);
    }
    out = out.split(e.old_str).join(e.new_str);
  });
  return out;
}

async function planEdit(a, env) {
  const s = await fileState(a, env);
  if (!s.cur) throw new Error(`${a.path} does not exist on ${s.branch}`);
  if (s.cur.text === null) throw new Error("File is too large (over 1 MB) to edit through this tool");
  return { s, next: applyEdits(s.cur.text, a.edits) };
}

const head = (a) => `${a.owner}/${a.repo}`;

const genericPreview = (tool, a) => {
  let j = JSON.stringify(a, null, 2);
  if (j.length > 4000) j = j.slice(0, 4000) + "\n...[truncated]";
  return `Tool: ${tool.name}\nArguments:\n${j}`;
};

const OR = {
  owner: { type: "string", description: "Repo owner (user or org)" },
  repo: { type: "string", description: "Repo name" },
};
const PAGING = {
  per_page: { type: "number", description: "Results per page, max 100" },
  page: { type: "number", description: "Page number, starts at 1" },
};

const CONFIRM_PROP = {
  confirm_token: {
    type: "string",
    description:
      "Leave empty on the first call to get a preview (nothing is changed). Only after the user explicitly approves the preview, repeat the identical call with the token the preview returned.",
  },
};

const T = (name, description, props, required, run, opts = {}) => ({
  name,
  description: opts.write
    ? `${description} TWO-STEP: the first call only returns a preview and changes nothing; show it to the user, wait for their explicit yes, then repeat the same call with the confirm_token.`
    : description,
  inputSchema: { type: "object", properties: opts.write ? { ...props, ...CONFIRM_PROP } : props, required },
  run,
  preview: opts.preview,
  write: !!opts.write,
  destructive: !!opts.destructive,
});

const TOOLS = [
  T("whoami", "Show which GitHub account the token belongs to.", {}, [], async (a, env) => {
    const u = await gh(env, "GET", "/user");
    return { login: u.login, name: u.name, html_url: u.html_url };
  }),

  T(
    "list_repos",
    "List repositories the token can access (owned, collaborator, org member), private included. Sorted by last push.",
    {
      visibility: { type: "string", enum: ["all", "public", "private"] },
      affiliation: { type: "string", description: "Comma list of owner,collaborator,organization_member" },
      sort: { type: "string", enum: ["created", "updated", "pushed", "full_name"] },
      ...PAGING,
    },
    [],
    async (a, env) => {
      const data = await gh(
        env,
        "GET",
        "/user/repos" +
          qs({
            visibility: a.visibility,
            affiliation: a.affiliation || "owner,collaborator,organization_member",
            sort: a.sort || "pushed",
            per_page: a.per_page || 100,
            page: a.page,
          })
      );
      return data.map(slimRepo);
    }
  ),

  T("get_repo", "Get details for one repository.", { ...OR }, ["owner", "repo"], async (a, env) => {
    const r = await gh(env, "GET", rp(a));
    return {
      ...slimRepo(r),
      stars: r.stargazers_count,
      forks: r.forks_count,
      open_issues_count: r.open_issues_count,
      topics: r.topics,
      size_kb: r.size,
      license: r.license && r.license.spdx_id,
    };
  }),

  T(
    "get_file",
    "Read a file (returns text with sha) or list a directory. Use path \"\" for the repo root. Optional start_line/end_line for big files.",
    {
      ...OR,
      path: { type: "string" },
      ref: { type: "string", description: "Branch, tag or commit sha" },
      start_line: { type: "number" },
      end_line: { type: "number" },
    },
    ["owner", "repo"],
    async (a, env) => {
      const p = rp(a);
      const path = encPath(a.path);
      const url = `${p}/contents/${path}${qs({ ref: a.ref })}`;
      const data = await gh(env, "GET", url);
      if (Array.isArray(data)) {
        return data.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size }));
      }
      if (data.type !== "file") return data;
      let text = data.content
        ? fromB64(data.content)
        : await gh(env, "GET", url, null, "application/vnd.github.raw+json");
      if (a.start_line || a.end_line) {
        const lines = text.split("\n");
        const s = Math.max((a.start_line || 1) - 1, 0);
        text = lines
          .slice(s, a.end_line || lines.length)
          .map((l, i) => `${s + i + 1}: ${l}`)
          .join("\n");
      }
      return `sha: ${data.sha}\nsize: ${data.size}\n\n${text}`;
    }
  ),

  T(
    "get_tree",
    "List every file path in a repo at a ref (recursive). Good for orienting in a codebase.",
    { ...OR, ref: { type: "string", description: "Branch or sha, default HEAD" } },
    ["owner", "repo"],
    async (a, env) => {
      const data = await gh(
        env,
        "GET",
        `${rp(a)}/git/trees/${encPath(a.ref || "HEAD")}${qs({ recursive: 1 })}`
      );
      const lines = data.tree.map((t) => `${t.type === "tree" ? "d" : "f"} ${t.path}`);
      return (data.truncated ? "[tree truncated by GitHub]\n" : "") + lines.join("\n");
    }
  ),

  T(
    "search_code",
    "Search code across GitHub. Use qualifiers, e.g. \"user:ItzMeShadow999 fetch(\" or \"repo:owner/name TODO language:js\".",
    { q: { type: "string" }, ...PAGING },
    ["q"],
    async (a, env) => {
      const data = await gh(env, "GET", "/search/code" + qs({ q: a.q, per_page: a.per_page || 30, page: a.page }));
      return {
        total_count: data.total_count,
        items: data.items.map((i) => ({
          repo: i.repository.full_name,
          path: i.path,
          html_url: i.html_url,
        })),
      };
    }
  ),

  T(
    "search_issues",
    "Search issues and pull requests across GitHub. Qualifiers like is:pr, is:open, repo:owner/name, author:name.",
    { q: { type: "string" }, ...PAGING },
    ["q"],
    async (a, env) => {
      const data = await gh(env, "GET", "/search/issues" + qs({ q: a.q, per_page: a.per_page || 30, page: a.page }));
      return {
        total_count: data.total_count,
        items: data.items.map((i) => ({ ...slimIssue(i), is_pr: !!i.pull_request })),
      };
    }
  ),

  T("list_branches", "List branches of a repo.", { ...OR, ...PAGING }, ["owner", "repo"], async (a, env) => {
    const data = await gh(env, "GET", `${rp(a)}/branches` + qs({ per_page: a.per_page || 100, page: a.page }));
    return data.map((b) => ({ name: b.name, sha: b.commit.sha, protected: b.protected }));
  }),

  T(
    "list_commits",
    "List commits, optionally for a branch/sha and/or a file path.",
    { ...OR, sha: { type: "string" }, path: { type: "string" }, ...PAGING },
    ["owner", "repo"],
    async (a, env) => {
      const data = await gh(
        env,
        "GET",
        `${rp(a)}/commits` + qs({ sha: a.sha, path: a.path, per_page: a.per_page || 30, page: a.page })
      );
      return data.map(slimCommit);
    }
  ),

  T("get_commit", "Get one commit with changed files and patches.", { ...OR, ref: { type: "string" } }, ["owner", "repo", "ref"], async (a, env) => {
    const c = await gh(env, "GET", `${rp(a)}/commits/${encPath(a.ref)}`);
    return {
      ...slimCommit(c),
      stats: c.stats,
      files: (c.files || []).map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      })),
    };
  }),

  T(
    "list_issues",
    "List issues (pull requests excluded).",
    {
      ...OR,
      state: { type: "string", enum: ["open", "closed", "all"] },
      labels: { type: "string", description: "Comma separated" },
      ...PAGING,
    },
    ["owner", "repo"],
    async (a, env) => {
      const data = await gh(
        env,
        "GET",
        `${rp(a)}/issues` +
          qs({ state: a.state || "open", labels: a.labels, per_page: a.per_page || 30, page: a.page })
      );
      return data.filter((i) => !i.pull_request).map(slimIssue);
    }
  ),

  T(
    "get_issue",
    "Get an issue (or PR) with body, optionally with comments.",
    { ...OR, number: { type: "number" }, include_comments: { type: "boolean" } },
    ["owner", "repo", "number"],
    async (a, env) => {
      const p = rp(a);
      const i = await gh(env, "GET", `${p}/issues/${Number(a.number)}`);
      const out = { ...slimIssue(i), body: i.body };
      if (a.include_comments) {
        const cs = await gh(env, "GET", `${p}/issues/${Number(a.number)}/comments?per_page=100`);
        out.comment_list = cs.map((c) => ({ user: c.user && c.user.login, created_at: c.created_at, body: c.body }));
      }
      return out;
    }
  ),

  T(
    "list_pulls",
    "List pull requests.",
    { ...OR, state: { type: "string", enum: ["open", "closed", "all"] }, ...PAGING },
    ["owner", "repo"],
    async (a, env) => {
      const data = await gh(
        env,
        "GET",
        `${rp(a)}/pulls` + qs({ state: a.state || "open", per_page: a.per_page || 30, page: a.page })
      );
      return data.map(slimPull);
    }
  ),

  T(
    "get_pull",
    "Get a pull request. Set diff true to get the raw unified diff instead.",
    { ...OR, number: { type: "number" }, diff: { type: "boolean" } },
    ["owner", "repo", "number"],
    async (a, env) => {
      const url = `${rp(a)}/pulls/${Number(a.number)}`;
      if (a.diff) return await gh(env, "GET", url, null, "application/vnd.github.diff");
      const p = await gh(env, "GET", url);
      return {
        ...slimPull(p),
        body: p.body,
        mergeable: p.mergeable,
        additions: p.additions,
        deletions: p.deletions,
        changed_files: p.changed_files,
      };
    }
  ),

  T(
    "create_issue",
    "Open a new issue.",
    {
      ...OR,
      title: { type: "string" },
      body: { type: "string" },
      labels: { type: "array", items: { type: "string" } },
      assignees: { type: "array", items: { type: "string" } },
    },
    ["owner", "repo", "title"],
    async (a, env) => {
      const i = await gh(env, "POST", `${rp(a)}/issues`, {
        title: a.title,
        body: a.body,
        labels: a.labels,
        assignees: a.assignees,
      });
      return slimIssue(i);
    },
    { write: true }
  ),

  T(
    "update_issue",
    "Edit an issue or PR: title, body, state, labels.",
    {
      ...OR,
      number: { type: "number" },
      title: { type: "string" },
      body: { type: "string" },
      state: { type: "string", enum: ["open", "closed"] },
      labels: { type: "array", items: { type: "string" } },
    },
    ["owner", "repo", "number"],
    async (a, env) => {
      const i = await gh(env, "PATCH", `${rp(a)}/issues/${Number(a.number)}`, {
        title: a.title,
        body: a.body,
        state: a.state,
        labels: a.labels,
      });
      return slimIssue(i);
    },
    { write: true }
  ),

  T(
    "comment_issue",
    "Comment on an issue or pull request.",
    { ...OR, number: { type: "number" }, body: { type: "string" } },
    ["owner", "repo", "number", "body"],
    async (a, env) => {
      const c = await gh(env, "POST", `${rp(a)}/issues/${Number(a.number)}/comments`, { body: a.body });
      return { id: c.id, html_url: c.html_url };
    },
    { write: true }
  ),

  T(
    "create_branch",
    "Create a branch from another branch (default: the repo's default branch).",
    { ...OR, branch: { type: "string" }, from: { type: "string" } },
    ["owner", "repo", "branch"],
    async (a, env) => {
      const p = rp(a);
      const from = a.from || (await gh(env, "GET", p)).default_branch;
      const ref = await gh(env, "GET", `${p}/git/ref/heads/${encPath(from)}`);
      const r = await gh(env, "POST", `${p}/git/refs`, { ref: `refs/heads/${a.branch}`, sha: ref.object.sha });
      return { ref: r.ref, sha: r.object.sha, from };
    },
    { write: true }
  ),

  T(
    "put_file",
    "Create or update a text file with a commit (this pushes to the branch). Sends the full file content; for small changes prefer edit_file. Looks up the existing sha automatically if not given.",
    {
      ...OR,
      path: { type: "string" },
      content: { type: "string", description: "Full new file content (UTF-8 text)" },
      message: { type: "string", description: "Commit message" },
      branch: { type: "string" },
      sha: { type: "string", description: "Blob sha of the file being replaced, optional" },
    },
    ["owner", "repo", "path", "content", "message"],
    async (a, env) => {
      const p = rp(a);
      const path = encPath(a.path);
      let sha = a.sha;
      if (!sha) {
        try {
          const cur = await gh(env, "GET", `${p}/contents/${path}${qs({ ref: a.branch })}`);
          if (cur && !Array.isArray(cur)) sha = cur.sha;
        } catch (e) {
        }
      }
      const r = await gh(env, "PUT", `${p}/contents/${path}`, {
        message: a.message,
        content: toB64(a.content),
        branch: a.branch,
        sha,
      });
      return { commit: r.commit.sha, url: r.commit.html_url, path: r.content.path };
    },
    {
      write: true,
      preview: async (a, env) => {
        if (typeof a.content !== "string") throw new Error("content (string) is required");
        if (!a.message) throw new Error("message (commit message) is required");
        const s = await fileState(a, env);
        const lines = [`${s.cur ? "UPDATE" : "CREATE"} file ${head(a)}:${a.path}`, branchLine(s), `Commit message: ${a.message}`];
        if (s.cur && a.sha && a.sha !== s.cur.sha) lines.push("WARNING: the sha you passed does not match the current file; GitHub will reject this write.");
        if (!s.cur) {
          const l = a.content.split("\n");
          lines.push("", `New file, ${l.length} lines. First lines:`, l.slice(0, 40).join("\n"));
        } else if (s.cur.text === null) {
          lines.push("", "Existing file is over 1 MB, diff not available.");
        } else {
          const d = lineDiff(s.cur.text, a.content);
          lines.push("", `Diff (+${d.added} -${d.removed}):`, d.text);
        }
        return lines.join("\n");
      },
    }
  ),

  T(
    "edit_file",
    "Edit an existing text file with exact find-and-replace edits and commit it (this pushes to the branch). No need to resend the whole file. Each old_str must match exactly once unless replace_all is true. The commit fails safely if the file changed in the meantime.",
    {
      ...OR,
      path: { type: "string" },
      message: { type: "string", description: "Commit message" },
      branch: { type: "string", description: "Defaults to the repo's default branch" },
      edits: {
        type: "array",
        description: "Applied in order",
        items: {
          type: "object",
          properties: {
            old_str: { type: "string", description: "Exact text to find, including whitespace" },
            new_str: { type: "string", description: "Replacement text (empty string deletes)" },
            replace_all: { type: "boolean" },
          },
          required: ["old_str", "new_str"],
        },
      },
    },
    ["owner", "repo", "path", "message", "edits"],
    async (a, env) => {
      if (!a.message) throw new Error("message (commit message) is required");
      const { s, next } = await planEdit(a, env);
      const r = await gh(env, "PUT", `${s.p}/contents/${s.path}`, {
        message: a.message,
        content: toB64(next),
        branch: a.branch,
        sha: s.cur.sha,
      });
      return { commit: r.commit.sha, url: r.commit.html_url, path: r.content.path };
    },
    {
      write: true,
      preview: async (a, env) => {
        if (!a.message) throw new Error("message (commit message) is required");
        const { s, next } = await planEdit(a, env);
        const d = lineDiff(s.cur.text, next);
        return [`EDIT file ${head(a)}:${a.path}`, branchLine(s), `Commit message: ${a.message}`, "", `Diff (+${d.added} -${d.removed}):`, d.text].join("\n");
      },
    }
  ),

  T(
    "delete_file",
    "Delete a file with a commit. Looks up the sha automatically if not given.",
    {
      ...OR,
      path: { type: "string" },
      message: { type: "string" },
      branch: { type: "string" },
      sha: { type: "string" },
    },
    ["owner", "repo", "path", "message"],
    async (a, env) => {
      const p = rp(a);
      const path = encPath(a.path);
      let sha = a.sha;
      if (!sha) {
        const cur = await gh(env, "GET", `${p}/contents/${path}${qs({ ref: a.branch })}`);
        sha = cur.sha;
      }
      const r = await gh(env, "DELETE", `${p}/contents/${path}`, { message: a.message, sha, branch: a.branch });
      return { commit: r.commit.sha, url: r.commit.html_url };
    },
    {
      write: true,
      destructive: true,
      preview: async (a, env) => {
        if (!a.message) throw new Error("message (commit message) is required");
        const s = await fileState(a, env);
        if (!s.cur) throw new Error(`${a.path} does not exist on ${s.branch}`);
        const n = s.cur.text === null ? "over 1 MB" : `${s.cur.text.split("\n").length} lines`;
        return [`DELETE file ${head(a)}:${a.path} (${n})`, branchLine(s), `Commit message: ${a.message}`].join("\n");
      },
    }
  ),

  T(
    "create_pull",
    "Open a pull request.",
    {
      ...OR,
      title: { type: "string" },
      head: { type: "string", description: "Branch with changes (or user:branch for forks)" },
      base: { type: "string", description: "Branch to merge into" },
      body: { type: "string" },
      draft: { type: "boolean" },
    },
    ["owner", "repo", "title", "head", "base"],
    async (a, env) => {
      const pr = await gh(env, "POST", `${rp(a)}/pulls`, {
        title: a.title,
        head: a.head,
        base: a.base,
        body: a.body,
        draft: a.draft,
      });
      return slimPull(pr);
    },
    { write: true }
  ),

  T(
    "merge_pull",
    "Merge a pull request.",
    {
      ...OR,
      number: { type: "number" },
      merge_method: { type: "string", enum: ["merge", "squash", "rebase"] },
      commit_title: { type: "string" },
    },
    ["owner", "repo", "number"],
    async (a, env) => {
      return await gh(env, "PUT", `${rp(a)}/pulls/${Number(a.number)}/merge`, {
        merge_method: a.merge_method || "merge",
        commit_title: a.commit_title,
      });
    },
    {
      write: true,
      destructive: true,
      preview: async (a, env) => {
        const pr = await gh(env, "GET", `${rp(a)}/pulls/${Number(a.number)}`);
        return [
          `MERGE pull request #${pr.number} in ${head(a)} using "${a.merge_method || "merge"}"`,
          `Title: ${pr.title}`,
          `${pr.head && pr.head.ref} -> ${pr.base && pr.base.ref}`,
          `State: ${pr.state}, mergeable: ${pr.mergeable}, +${pr.additions} -${pr.deletions} in ${pr.changed_files} files`,
        ].join("\n");
      },
    }
  ),

  T(
    "create_repo",
    "Create a new repository for the user, or under an org if org is given.",
    {
      name: { type: "string" },
      org: { type: "string" },
      description: { type: "string" },
      private: { type: "boolean" },
      auto_init: { type: "boolean", description: "Create an initial README commit" },
    },
    ["name"],
    async (a, env) => {
      if (a.org && !NAME_RE.test(a.org)) throw new Error("invalid org");
      const path = a.org ? `/orgs/${a.org}/repos` : "/user/repos";
      const r = await gh(env, "POST", path, {
        name: a.name,
        description: a.description,
        private: a.private !== false,
        auto_init: a.auto_init,
      });
      return slimRepo(r);
    },
    { write: true }
  ),

  T(
    "github_api",
    "Escape hatch: call any GitHub REST endpoint. path starts with \"/\", for example \"/repos/owner/name/actions/runs\". Covers everything the other tools do not. GET runs immediately; any other method is two-step (preview, then confirm_token).",
    {
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      path: { type: "string" },
      body: { type: "object", description: "JSON body for non-GET calls" },
    },
    ["method", "path"],
    async (a, env) => {
      if (typeof a.path !== "string" || !a.path.startsWith("/") || a.path.startsWith("//")) {
        throw new Error("path must start with a single /");
      }
      return await gh(env, a.method, a.path, a.body);
    },
    { write: true, destructive: true }
  ),
];

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const bad = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const readOnly = (env) => String(env.READ_ONLY).toLowerCase() === "true";
const visibleTools = (env) => TOOLS.filter((t) => !(t.write && readOnly(env)));

function toText(v) {
  let s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined || s === null) s = "null";
  if (s.length > MAX_OUT) s = s.slice(0, MAX_OUT) + `\n...[truncated ${s.length - MAX_OUT} chars]`;
  return s;
}

async function handleRpc(msg, env, origin) {
  if (!msg || typeof msg !== "object") return bad(null, -32600, "Invalid request");
  const isNotification = !("id" in msg);
  const id = msg.id;
  const { method, params } = msg;

  if (isNotification) return null;

  try {
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: (params && params.protocolVersion) || "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: "commitment-issues",
            title: "Commitment Issues",
            description: "GitHub for Claude. Previews every change and only commits after you say yes.",
            version: "1.0.0",
          },
          instructions:
            "GitHub access via REST API. Start with list_repos or search_code. Prefer get_tree then get_file to explore a repo. " +
            "Reading never changes anything. Every write tool (edit_file, put_file, delete_file, create_*, update_*, comment_issue, merge_pull, non-GET github_api) is two-step: " +
            "the first call returns a preview and changes nothing. Show that preview to the user and ask for explicit approval. " +
            "Only after they clearly say yes, repeat the same call with the confirm_token from the preview. Never reuse a token without fresh approval.",
        });

      case "ping":
        return ok(id, {});

      case "tools/list":
        return ok(id, {
          tools: visibleTools(env).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: {
              readOnlyHint: !t.write,
              destructiveHint: t.destructive,
              openWorldHint: true,
            },
          })),
        });

      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === (params && params.name));
        if (!tool) return bad(id, -32602, `Unknown tool: ${params && params.name}`);
        if (tool.write && readOnly(env)) {
          return ok(id, { content: [{ type: "text", text: "Server is in READ_ONLY mode." }], isError: true });
        }
        try {
          const { confirm_token, ...args } = (params && params.arguments) || {};
          const needsConfirm = tool.write && !(tool.name === "github_api" && String(args.method).toUpperCase() === "GET");
          if (needsConfirm) {
            if (!confirm_token) {
              const detail = tool.preview ? await tool.preview(args, env) : genericPreview(tool, args);
              const token = await makeToken(env, tool.name, args);
              return ok(id, {
                content: [
                  {
                    type: "text",
                    text:
                      `PREVIEW ONLY. Nothing has been changed on GitHub.\n\n${detail}\n\n---\n` +
                      `STOP: show this preview to the user and ask for explicit approval. Do not continue unless they clearly say yes. ` +
                      `If approved, call ${tool.name} again with exactly the same arguments plus confirm_token: "${token}" (valid 10 minutes). ` +
                      `If the user wants changes, start over without a token.`,
                  },
                ],
              });
            }
            if (!(await checkToken(env, tool.name, args, confirm_token))) {
              return ok(id, {
                content: [
                  {
                    type: "text",
                    text: "Invalid or expired confirm_token, or the arguments differ from the previewed ones. Nothing was changed. Call again without a token to get a fresh preview.",
                  },
                ],
                isError: true,
              });
            }
          }
          const out = await tool.run(args, env);
          return ok(id, { content: [{ type: "text", text: toText(out) }] });
        } catch (e) {
          return ok(id, { content: [{ type: "text", text: String(e && e.message ? e.message : e) }], isError: true });
        }
      }

      default:
        return bad(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return bad(id, -32603, String(e && e.message ? e.message : e));
  }
}

function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const jsonRes = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const m = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
    if (!m || !env.ACCESS_KEY || !safeEq(decodeURIComponent(m[1]), env.ACCESS_KEY)) {
      return new Response("Not found", { status: 404 });
    }
    if (!env.GITHUB_TOKEN) return jsonRes(bad(null, -32603, "GITHUB_TOKEN secret is not set"), 500);
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "POST", ...CORS } });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return jsonRes(bad(null, -32700, "Parse error"), 400);
    }

    if (Array.isArray(body)) {
      const outs = (await Promise.all(body.map((x) => handleRpc(x, env, url.origin)))).filter(Boolean);
      return outs.length ? jsonRes(outs) : new Response(null, { status: 202, headers: CORS });
    }

    const out = await handleRpc(body, env, url.origin);
    return out ? jsonRes(out) : new Response(null, { status: 202, headers: CORS });
  },
};
