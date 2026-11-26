// Pure logic for the MCP panel: no Herdr imports, so `node --test` covers it.
// Data comes from Claude Code itself: `claude mcp list` for status, and its
// config files for details (~/.claude.json: user scope in `mcpServers`, local
// scope and disabled names in `projects[folder]`; `<folder>/.mcp.json`: project).

const KINDS = { "✔": "ok", "!": "auth", "✘": "failed", "⏸": "pending", "⊘": "disabled" };

// "name: target - ✔ Connected" lines from `claude mcp list`.
export function parseList(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(.+?): .* - ([✔✘!⏸⊘]) ?(.*)$/u);
    if (m) out.push({ name: m[1], kind: KINDS[m[2]], status: m[3] });
  }
  return out;
}

export function configs(claudeJson, mcpJson, folder) {
  const proj = claudeJson?.projects?.[folder] ?? {};
  return {
    local: proj.mcpServers ?? {},
    project: mcpJson?.mcpServers ?? {},
    user: claudeJson?.mcpServers ?? {},
    disabled: proj.disabledMcpServers ?? [],
  };
}

// Where a server is defined, in Claude Code's precedence order. claude.ai
// connectors and plugin servers have no editable config.
export function locate(name, c) {
  for (const scope of ["local", "project", "user"]) {
    if (c[scope][name]) return { scope, config: c[scope][name] };
  }
  return { scope: name.startsWith("claude.ai ") ? "claude.ai" : "plugin", config: null };
}

// doc: parsed ~/.claude.json (user, local) or .mcp.json (project).
export function setServer(doc, scope, folder, name, config) {
  const target = scope === "local" ? ((doc.projects ??= {})[folder] ??= {}) : doc;
  target.mcpServers = { ...target.mcpServers, [name]: config };
  return doc;
}

export function toggleDisabled(doc, folder, name) {
  const p = ((doc.projects ??= {})[folder] ??= {});
  const list = p.disabledMcpServers ?? [];
  p.disabledMcpServers = list.includes(name) ? list.filter((n) => n !== name) : [...list, name];
  return doc;
}
