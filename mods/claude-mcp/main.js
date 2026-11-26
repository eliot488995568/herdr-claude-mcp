// MCP for Herdr: a tab-bar button and a panel to see, edit and act on Claude
// Code's MCP servers for the active space's folder.
//   props().role === "toggle"  the tab-bar button (layout node "mcp-toggle")
//   otherwise                  the panel (inside layout node "mcp-panel")
// The folder is the focused terminal's; ↻ reloads for a newly focused one.
// Status comes from `claude mcp list`, details from Claude Code's config files
// (see mcp.js). Edits and enable/disable rewrite those files atomically and
// only if they haven't changed since read; remove/login/logout use the CLI.
// ponytail: local machine only; a space on another machine still shows this
// computer's servers. Add `on: space.machine` to exec/readTextFile if needed.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState } from "gpui-base";
import { checking, exec, focused, home, layout, props, readTextFile, run, settings, spaces, theme, writeTextFile } from "herdr";
import { configs, locate, parseList, setServer, toggleDisabled } from "./mcp.js";

const PANEL = "mcp-panel";
const MARK = "mods/claude-mcp/mark.svg";
const SCOPES = { local: "local", project: "project", user: "user", "claude.ai": "claude.ai", plugin: "plugin" };

const findNode = (node, id) =>
  node?.id === id ? node : (node?.children ?? []).reduce((hit, c) => hit ?? findNode(c, id), null);
// Claude Code keys local scope by the folder it runs in: the focused terminal's.
const folderNow = () => {
  const f = focused();
  return f?.cwd ?? spaces().find((s) => s.id === f?.space)?.folder ?? home();
};
const errText = (e) => String(e?.message ?? e).replace(/^`herdr\.\w+`: /, "");

function button(id, label, onClick, t, tone) {
  return h_flex().id(id).h(28).px(10).flex_none().items_center().rounded(6).cursor_pointer()
    .text_size(12).border(1).border_color(t.border)
    .text_color(tone ?? t.foreground)
    .hover((s) => s.bg(t.hover))
    .on_click(onClick)
    .child(label);
}

function dotColor(kind, t) {
  return { ok: t.ansi2, auth: t.ansi3, failed: t.ansi1, pending: t.ansi4, disabled: t.dim }[kind] ?? t.dim;
}

class Toggle {
  render() {
    const t = theme();
    const node = findNode(layout(), PANEL);
    const open = Boolean(node) && !node.hidden;
    return h_flex().size_full().pl(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(
        h_flex().id("mcp-toggle").h(26).px(8).gap(5).flex_none().items_center().rounded(6).cursor_pointer()
          .text_size(12)
          .bg(open ? t.selected : t.chrome)
          .text_color(open ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("layout.toggle", { id: PANEL }))
          .child(svg(MARK).size(14).flex_none())
          .child(div().child("MCP")),
      );
  }
}

class Panel {
  init(cx) {
    this.servers = [];
    this.cfg = configs(null, null, "");
    this.selected = null;
    this.editor = null;
    this.message = null;
    this.confirmRemove = false;
    if (!checking()) this.refresh(cx);
  }

  refresh(cx) {
    this.loading = true;
    this.folder = folderNow();
    const folder = this.folder;
    cx.spawn(async (cx) => {
      try {
        const [list, cj, mj] = await Promise.all([
          exec("claude", ["mcp", "list"], { cwd: folder, timeout: 120000 }),
          readTextFile(`${home()}/.claude.json`),
          readTextFile(`${folder}/.mcp.json`),
        ]);
        this.cfg = configs(JSON.parse(cj ?? "{}"), mj ? JSON.parse(mj) : null, folder);
        this.servers = parseList(list.stdout);
        if (!this.servers.length && list.code) this.message = { error: true, text: list.stderr.trim() || "claude mcp list failed" };
        if (this.selected && !this.servers.some((s) => s.name === this.selected)) this.select(null);
      } catch (e) {
        this.message = { error: true, text: errText(e) };
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  select(name) {
    this.selected = name;
    this.confirmRemove = false;
    this.editor?.release();
    this.editor = null;
    const config = name && locate(name, this.cfg).config;
    if (config) {
      const t = theme();
      this.editor = EditorState.new({
        language: "json",
        value: JSON.stringify(config, null, 2),
        font_family: settings().font_family,
        syntax: { keyword: t.ansi5, string: t.ansi2, number: t.ansi1, constant: t.ansi6 },
      });
    }
  }

  // Runs an action, shows its outcome, then reloads the list.
  act(cx, label, fn) {
    this.busy = label;
    this.message = null;
    cx.spawn(async (cx) => {
      try {
        const ok = await fn();
        this.message = { error: false, text: ok ?? `${label}: done` };
      } catch (e) {
        this.message = { error: true, text: `${label}: ${errText(e)}` };
      } finally {
        this.busy = null;
        this.refresh(cx);
      }
    });
    cx.notify();
  }

  async rewrite(path, change) {
    const text = await readTextFile(path);
    if (text === null) throw new Error(`${path} not found`);
    await writeTextFile(path, JSON.stringify(change(JSON.parse(text)), null, 2) + "\n", text);
  }

  async cli(args) {
    const r = await exec("claude", ["mcp", ...args], { cwd: this.folder, timeout: 60000 });
    if (r.code) throw new Error(r.stderr.trim() || r.stdout.trim() || `code ${r.code}`);
    return r.stdout.trim().split("\n").pop();
  }

  save(cx, name, scope) {
    let config;
    try {
      config = JSON.parse(this.editor.value());
    } catch (e) {
      this.message = { error: true, text: `Invalid JSON: ${e.message}` };
      return cx.notify();
    }
    const folder = this.folder;
    const path = scope === "project" ? `${folder}/.mcp.json` : `${home()}/.claude.json`;
    this.act(cx, "Save", () => this.rewrite(path, (doc) => setServer(doc, scope, folder, name, config)).then(
      () => "Saved. Running Claude sessions pick it up after /mcp → Reconnect.",
    ));
  }

  render(cx) {
    const t = theme();
    return v_flex().size_full().bg(t.surface).text_color(t.foreground).text_size(13)
      .child(this.header(t))
      .child(this.selected ? this.detail(t) : this.list(t))
      .when(Boolean(this.message || this.busy), (el) => el.child(
        div().px(12).py(8).flex_none().border_t(1).border_color(t.border).text_size(12)
          .text_color(this.busy ? t.muted : this.message.error ? t.ansi1 : t.muted)
          .child(this.busy ? `${this.busy}…` : this.message.text),
      ));
  }

  header(t) {
    return h_flex().h(44).px(12).gap(8).flex_none().items_center().border_b(1).border_color(t.border)
      .when(Boolean(this.selected), (el) => el.child(button("mcp-back", "←", (_e, cx) => { this.select(null); cx.notify(); }, t)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().font_semibold().truncate().child(this.selected ?? "MCP servers"))
        .child(div().text_size(11).text_color(t.dim).truncate().child(this.folder ?? "")))
      .child(this.loading
        ? div().text_color(t.muted).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)
        : button("mcp-refresh", "↻", (_e, cx) => this.refresh(cx), t));
  }

  list(t) {
    if (!this.servers.length) {
      return div().p(16).text_color(t.muted).child(this.loading ? "Checking servers (a few seconds)…" : "No MCP servers.");
    }
    return v_flex().id("mcp-list").flex_1().min_h(0).p(6).gap(2).overflow_y_scrollbar().children(
      this.servers.map((s) => {
        const scope = locate(s.name, this.cfg).scope;
        return h_flex().id(`mcp-${s.name}`).h(40).flex_none().px(8).gap(10).items_center().rounded(6).cursor_pointer()
          .hover((el) => el.bg(t.hover))
          .on_click((_e, cx) => { this.select(s.name); cx.notify(); })
          .child(div().size(8).flex_none().rounded(4).bg(dotColor(s.kind, t)))
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().child(s.name))
            .child(div().text_size(11).text_color(t.dim).truncate().child(s.status)))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(SCOPES[scope]));
      }),
    );
  }

  detail(t) {
    const name = this.selected;
    const s = this.servers.find((x) => x.name === name) ?? { kind: null, status: "" };
    const { scope, config } = locate(name, this.cfg);
    const disabled = s.kind === "disabled" || this.cfg.disabled.includes(name);
    const remote = !config || ["http", "sse"].includes(config.type) || Boolean(config.url);
    const actions = [
      button("mcp-test", "Test connection", (_e, cx) => this.refresh(cx), t),
      button("mcp-toggle-off", disabled ? "Enable" : "Disable", (_e, cx) =>
        this.act(cx, disabled ? "Enable" : "Disable", () =>
          this.rewrite(`${home()}/.claude.json`, (doc) => toggleDisabled(doc, this.folder, name))), t),
    ];
    if (remote) {
      actions.push(
        button("mcp-login", "Log in", () =>
          run("tab.new", { name: `mcp login ${name}`, folder: this.folder, argv: ["claude", "mcp", "login", name] }), t),
        button("mcp-logout", "Log out (OAuth)", (_e, cx) => this.act(cx, "Log out", () => this.cli(["logout", name])), t),
      );
    }
    if (config) {
      actions.push(button("mcp-remove", this.confirmRemove ? "Confirm removal" : "Remove", (_e, cx) => {
        if (!this.confirmRemove) { this.confirmRemove = true; return cx.notify(); }
        this.act(cx, "Remove", () => this.cli(["remove", name, "-s", scope]));
      }, t, t.ansi1));
    }
    const font = settings();
    return v_flex().flex_1().min_h(0).p(12).gap(10)
      .child(h_flex().gap(8).items_center()
        .child(div().size(8).flex_none().rounded(4).bg(dotColor(s.kind, t)))
        .child(div().flex_1().min_w(0).text_color(t.muted).child(s.status || "Unknown status")))
      .child(div().text_size(12).text_color(t.dim).child(`Scope: ${SCOPES[scope]}`))
      .child(h_flex().flex_wrap().gap(6).children(actions))
      .child(config
        ? v_flex().flex_1().min_h(0).gap(8)
          .child(div().flex_1().min_h(0).border(1).border_color(t.border).rounded(6).overflow_hidden()
            .child(Editor.new(this.editor).font_family(font.font_family).text_size(font.font_size).size_full()))
          .child(h_flex().justify_end().child(button("mcp-save", "Save", (_e, cx) => this.save(cx, name, scope), t, t.accent)))
        : div().text_size(12).text_color(t.muted).child(
          scope === "claude.ai"
            ? "claude.ai connector: manage it on claude.ai (Settings → Connectors)."
            : "Provided by a plugin: change it in the plugin."));
  }
}

export default class Mcp extends View {
  init(initial, cx) {
    this.role = (props() ?? initial ?? {}).role === "toggle" ? new Toggle() : new Panel();
    this.role.init?.(cx);
  }

  render(cx) {
    return this.role.render(cx);
  }
}
