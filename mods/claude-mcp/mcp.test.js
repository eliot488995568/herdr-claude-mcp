// node --test ~/.config/herdr-app/mods/claude-mcp/mcp.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { configs, locate, parseList, setServer, toggleDisabled } from "./mcp.js";

test("parseList reads every status", () => {
  const out = parseList(`Checking MCP server health…

claude.ai Slack: https://mcp.slack.com - ! Needs authentication
chrome-devtools: npx chrome-devtools-mcp@latest - ✔ Connected
dummy-a: true  - ⊘ Disabled for this project (re-enable via /mcp)
broken: https://x.test/a - b - ✘ Failed to connect — nope`);
  assert.deepEqual(out.map((s) => [s.name, s.kind]), [
    ["claude.ai Slack", "auth"],
    ["chrome-devtools", "ok"],
    ["dummy-a", "disabled"],
    ["broken", "failed"],
  ]);
  assert.equal(out[3].status, "Failed to connect — nope");
});

test("locate follows local > project > user", () => {
  const c = configs(
    { mcpServers: { a: { u: 1 }, b: { u: 1 } }, projects: { "/p": { mcpServers: { a: { l: 1 } } } } },
    { mcpServers: { b: { p: 1 } } },
    "/p",
  );
  assert.deepEqual(locate("a", c), { scope: "local", config: { l: 1 } });
  assert.deepEqual(locate("b", c), { scope: "project", config: { p: 1 } });
  assert.equal(locate("claude.ai Gmail", c).scope, "claude.ai");
  assert.equal(locate("other", c).scope, "plugin");
});

test("setServer and toggleDisabled keep the rest of the doc", () => {
  const doc = { keep: 1, mcpServers: { a: 1, b: 2 } };
  setServer(doc, "user", "/p", "a", { x: 1 });
  assert.deepEqual(doc.mcpServers, { a: { x: 1 }, b: 2 });
  setServer(doc, "local", "/p", "c", { y: 1 });
  assert.deepEqual(doc.projects["/p"].mcpServers, { c: { y: 1 } });
  toggleDisabled(doc, "/p", "a");
  assert.deepEqual(doc.projects["/p"].disabledMcpServers, ["a"]);
  toggleDisabled(doc, "/p", "a");
  assert.deepEqual(doc.projects["/p"].disabledMcpServers, []);
  assert.equal(doc.keep, 1);
});
