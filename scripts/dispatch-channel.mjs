#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.join(path.dirname(new URL(import.meta.url).pathname), ".."));
const ISSUE_DIR = path.join(ROOT, "plan", "issues");
const STATE_DIR = path.join(ROOT, ".codex", "dispatch");
const CLAIMS_FILE = path.join(STATE_DIR, "claims.json");
const MESSAGES_FILE = path.join(STATE_DIR, "messages.jsonl");
const RECEIPTS_DIR = path.join(STATE_DIR, "receipts");
const READY_STATES = new Set(["ready"]);
const TERMINAL_STATES = new Set(["done", "wont-fix"]);
const ISSUE_FILE_RE = /^\d+[a-z]?(?:[-_].+)?\.md$/i;

function parseArgs(argv) {
  const args = {
    command: "",
    sprint: "latest",
    issue: "",
    owner: "",
    from: "dispatch",
    to: "",
    body: "",
    reason: "",
    limit: 20,
    json: false,
    consume: false,
    format: "text",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (!args.command && !a.startsWith("-")) args.command = a;
    else if (a === "--sprint") args.sprint = argv[++i];
    else if (a === "--issue") args.issue = argv[++i];
    else if (a === "--owner") args.owner = argv[++i];
    else if (a === "--from") args.from = argv[++i];
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--body") args.body = argv[++i];
    else if (a === "--reason") args.reason = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--consume") args.consume = true;
    else if (a === "--format") args.format = argv[++i];
    else if (a === "-h" || a === "--help") {
      help();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function help() {
  console.log(`Usage: node scripts/dispatch-channel.mjs <command> [options]

Commands:
  queue             Show claimable issues from plan/issues frontmatter
  request-claude    Send a Claude-lead request to fill native Claude TaskList
  claim             Claim an issue for a lead/teammate/channel
  complete          Mark a channel claim complete
  release           Release a channel claim
  message           Append an arbitrary channel message
  inbox             Read messages for a recipient
  status            Show claims and recent messages

Options:
  --sprint N        Sprint number, or latest (default)
  --limit N         Max queue/message rows (default 20)
  --issue ID        Issue id for claim/complete/release
  --owner NAME      Claim owner, e.g. codex-lead or claude-lead
  --from NAME       Message sender
  --to NAME         Message recipient
  --body TEXT       Message body
  --reason TEXT     Claim/release reason
  --consume         Advance inbox read offset
  --format hook     Render inbox as Claude/Codex prompt context
  --json            Emit JSON
`);
}

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(RECEIPTS_DIR, { recursive: true });
}

function parseScalar(raw) {
  let v = String(raw ?? "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

function parseArray(raw) {
  const v = parseScalar(raw);
  if (!v) return [];
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((item) => parseScalar(item))
      .filter(Boolean);
  }
  return [v];
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return {};
  const fm = {};
  let current = null;
  for (const line of m[1].split("\n")) {
    if (/^[A-Za-z0-9_ -]+:/.test(line)) {
      const idx = line.indexOf(":");
      current = line.slice(0, idx).trim();
      fm[current] = line.slice(idx + 1).trim();
    } else if (current && /^\s+-\s+/.test(line)) {
      fm[current] = `${fm[current] || ""}\n${line}`;
    }
  }
  return fm;
}

function issueIdFromFile(file) {
  return path.basename(file).match(/^(\d+[a-z]?)/i)?.[1] ?? path.basename(file, ".md");
}

function loadIssues() {
  const issues = [];
  for (const name of readdirSync(ISSUE_DIR)) {
    if (!ISSUE_FILE_RE.test(name)) continue;
    const file = path.join(ISSUE_DIR, name);
    if (statSync(file).isDirectory()) continue;
    const text = readFileSync(file, "utf8");
    const fm = parseFrontmatter(text);
    const id = parseScalar(fm.id || issueIdFromFile(file));
    issues.push({
      id,
      identifier: id,
      title: parseScalar(fm.title || text.match(/^#\s+(.+)$/m)?.[1] || "Untitled"),
      status: parseScalar(fm.status || "ready").toLowerCase(),
      sprint: parseScalar(fm.sprint || ""),
      priority: parseScalar(fm.priority || ""),
      depends_on: parseArray(fm.depends_on),
      file,
      relFile: path.relative(ROOT, file),
    });
  }
  return issues.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function currentSprint(issues) {
  const nums = issues
    .filter((issue) => /^\d+$/.test(issue.sprint) && !TERMINAL_STATES.has(issue.status))
    .map((issue) => Number(issue.sprint));
  return nums.length ? String(Math.max(...nums)) : "";
}

function loadClaims() {
  ensureStateDir();
  if (!existsSync(CLAIMS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CLAIMS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveClaims(claims) {
  ensureStateDir();
  const tmp = `${CLAIMS_FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(claims, null, 2)}\n`);
  renameSync(tmp, CLAIMS_FILE);
}

function activeClaims(claims) {
  return Object.fromEntries(Object.entries(claims).filter(([, claim]) => claim.status === "claimed"));
}

function claimableIssues(args) {
  const issues = loadIssues();
  const sprint = args.sprint === "latest" ? currentSprint(issues) : String(args.sprint);
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const claims = activeClaims(loadClaims());
  return issues
    .filter((issue) => issue.sprint === sprint)
    .filter((issue) => READY_STATES.has(issue.status))
    .filter((issue) => !claims[issue.id])
    .filter((issue) => issue.depends_on.every((id) => TERMINAL_STATES.has(byId.get(String(id))?.status || "")))
    .slice(0, args.limit)
    .map((issue) => ({ ...issue, sprint }));
}

function appendMessage(message) {
  ensureStateDir();
  appendFileSync(MESSAGES_FILE, `${JSON.stringify(message)}\n`);
}

function readMessages() {
  ensureStateDir();
  if (!existsSync(MESSAGES_FILE)) return [];
  return readFileSync(MESSAGES_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function receiptFile(to) {
  return path.join(RECEIPTS_DIR, `${String(to || "default").replace(/[^A-Za-z0-9._-]/g, "_")}.offset`);
}

function readInbox(args) {
  ensureStateDir();
  const to = args.to || "claude-lead";
  const file = receiptFile(to);
  const offset = args.consume && existsSync(file) ? Number(readFileSync(file, "utf8") || 0) : 0;
  const text = existsSync(MESSAGES_FILE) ? readFileSync(MESSAGES_FILE, "utf8") : "";
  const nextText = text.slice(offset);
  const messages = nextText
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((msg) => msg && (msg.to === to || msg.to === "all"))
    .slice(-args.limit);
  if (args.consume) writeFileSync(file, String(text.length));
  return messages;
}

function renderQueue(rows, json) {
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  for (const issue of rows) {
    console.log(`#${issue.id} [${issue.priority || "priority?"}] ${issue.title}`);
    console.log(`  ${issue.relFile}`);
  }
}

function renderInbox(messages, args) {
  if (args.json) {
    console.log(JSON.stringify(messages, null, 2));
    return;
  }
  if (messages.length === 0) return;
  if (args.format === "hook") {
    console.log("\n<SymphonyDispatchChannel>");
    console.log("Pending dispatch-channel messages:");
    for (const msg of messages) {
      console.log(`- from=${msg.from} type=${msg.type || "message"} at=${msg.created_at}`);
      console.log(`  ${msg.body.replace(/\n/g, "\n  ")}`);
    }
    console.log("</SymphonyDispatchChannel>\n");
    return;
  }
  for (const msg of messages) console.log(`[${msg.created_at}] ${msg.from} -> ${msg.to}: ${msg.body}`);
}

function commandQueue(args) {
  renderQueue(claimableIssues(args), args.json);
}

function commandRequestClaude(args) {
  const rows = claimableIssues(args);
  const sprint = rows[0]?.sprint || args.sprint;
  const body = [
    `Please populate the native Claude Code Team TaskList for sprint ${sprint}.`,
    "",
    "Use native Claude Code team/task tools only. Do not edit generated Claude task files directly.",
    "Create tasks for these ready issues, preserving lowest-ID priority unless you see a conflict:",
    "",
    ...rows.map((issue) => `- #${issue.id}: ${issue.title} (${issue.relFile})`),
  ].join("\n");
  const message = {
    id: `${Date.now()}-${process.pid}`,
    type: "claude_tasklist_request",
    from: args.from || "dispatch",
    to: args.to || "claude-lead",
    sprint,
    issues: rows.map((issue) => issue.id),
    body,
    created_at: new Date().toISOString(),
  };
  appendMessage(message);
  if (args.json) console.log(JSON.stringify(message, null, 2));
  else console.log(`queued Claude lead TaskList request for sprint ${sprint}: ${rows.length} issue(s)`);
}

function commandClaim(args) {
  if (!args.issue) throw new Error("claim requires --issue");
  if (!args.owner) throw new Error("claim requires --owner");
  const claims = loadClaims();
  const existing = claims[args.issue];
  if (existing?.status === "claimed" && existing.owner !== args.owner) {
    throw new Error(`#${args.issue} already claimed by ${existing.owner}`);
  }
  claims[args.issue] = {
    issue: args.issue,
    owner: args.owner,
    status: "claimed",
    reason: args.reason || "",
    claimed_at: new Date().toISOString(),
  };
  saveClaims(claims);
  console.log(`claimed #${args.issue} for ${args.owner}`);
}

function commandComplete(args) {
  if (!args.issue) throw new Error("complete requires --issue");
  const claims = loadClaims();
  claims[args.issue] = {
    ...(claims[args.issue] || { issue: args.issue }),
    status: "completed",
    completed_at: new Date().toISOString(),
    reason: args.reason || "",
  };
  saveClaims(claims);
  console.log(`completed channel claim for #${args.issue}`);
}

function commandRelease(args) {
  if (!args.issue) throw new Error("release requires --issue");
  const claims = loadClaims();
  claims[args.issue] = {
    ...(claims[args.issue] || { issue: args.issue }),
    status: "released",
    released_at: new Date().toISOString(),
    reason: args.reason || "",
  };
  saveClaims(claims);
  console.log(`released channel claim for #${args.issue}`);
}

function commandMessage(args) {
  if (!args.to) throw new Error("message requires --to");
  if (!args.body) throw new Error("message requires --body");
  const message = {
    id: `${Date.now()}-${process.pid}`,
    type: "message",
    from: args.from || "dispatch",
    to: args.to,
    body: args.body,
    created_at: new Date().toISOString(),
  };
  appendMessage(message);
  console.log(`queued message to ${message.to}`);
}

function commandStatus(args) {
  const payload = {
    claims: loadClaims(),
    recent_messages: readMessages().slice(-args.limit),
  };
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(JSON.stringify(payload, null, 2));
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "queue":
    case "":
      commandQueue(args);
      break;
    case "request-claude":
      commandRequestClaude(args);
      break;
    case "claim":
      commandClaim(args);
      break;
    case "complete":
      commandComplete(args);
      break;
    case "release":
      commandRelease(args);
      break;
    case "message":
      commandMessage(args);
      break;
    case "inbox":
      renderInbox(readInbox(args), args);
      break;
    case "status":
      commandStatus(args);
      break;
    default:
      throw new Error(`unknown command: ${args.command}`);
  }
}

main();
