// Contextual Org Picker — Voiden plugin (prototype)
//
// Compiled by `tsc` to a single plain ES module with no imports: Voiden loads a
// community plugin's main bundle as an ES module and calls its default export
// with the plugin context. Keep this file import-free (type-only imports are fine).
//
// What it does:
//   - Before any request that carries an `x-org-id` header is sent, it fills the
//     header with the org selected for the active environment.
//   - If no org is selected yet, it fetches GET {{AUTH_API_URL}}/organizations?fields=id,name with
//     the token from the OAuth2 auth block and shows a picker. One org = auto-pick.
//   - Selections are stored per environment (dev / qa / prod have different orgs).
//   - Status bar item + command palette entries to switch or clear the org.
//
// Internal (undocumented) Voiden APIs used — these may change between versions:
//   context.pipeline.registerHook('pre-send', ...)   hooks are awaited by the pipeline
//   requestState.metadata.scriptCancelled = true     cancels the send from pre-send
//   window.electron.env.load()                       active env key + variables
//   window.electron.variables.readMerged()           runtime vars (oauth2_access_token)
//   window.electron.sendRequest(url, init)           HTTP from the main process (no CORS)

// -----------------------------------------------------------------------------
// Types for the parts of Voiden this plugin touches. These describe observed
// behaviour, not a published API.
// -----------------------------------------------------------------------------

type ToastType = "info" | "success" | "warning" | "error";

interface RequestHeader {
  key: string;
  value: string;
  enabled?: boolean;
}

interface RequestState {
  url?: string;
  headers?: RequestHeader[];
  metadata?: Record<string, unknown> & { scriptCancelled?: boolean };
}

interface PipelineHookContext {
  requestState?: RequestState;
}

interface PluginContext {
  settings: {
    get<T = unknown>(key: string): Promise<T | undefined | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  pipeline: {
    registerHook(stage: "pre-send", hook: (ctx: PipelineHookContext) => Promise<void>, priority?: number): Promise<void>;
    unregister(): Promise<void>;
  };
  ui: {
    showToast(message: string, type?: ToastType): void;
  };
  events: {
    on(event: string, handler: () => void): () => void;
  };
  registerStatusBarItem(item: {
    id: string;
    icon: string;
    label: unknown;
    tooltip: unknown;
    position: "left" | "right";
    onClick: () => void;
  }): void;
  registerCommand(command: { id: string; label: string; description?: string; action: () => void }): void;
}

interface Plugin {
  onload(): Promise<void>;
  onunload(): Promise<void>;
}

interface VoidenEnvFile {
  activeEnv?: string | null;
  data?: Record<string, Record<string, string>>;
  displayNames?: Record<string, string>;
}

interface ElectronResponse {
  status?: number;
  statusText?: string;
  body?: unknown;
}

// Minimal slice of React used for the live status bar label.
interface ReactShim {
  createElement(type: () => unknown): unknown;
  useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T;
}

declare global {
  interface Window {
    electron?: {
      env?: { load?: () => Promise<VoidenEnvFile | undefined> };
      variables?: { readMerged?: () => Promise<Record<string, string> | undefined> };
      sendRequest: (url: string, init: { method: string; headers: Record<string, string> }) => Promise<ElectronResponse | undefined>;
    };
    __voiden_shims__?: { react?: Partial<ReactShim> };
  }
}

// -----------------------------------------------------------------------------
// Plugin types
// -----------------------------------------------------------------------------

interface Org {
  id: string;
  name: string;
}

interface Env {
  key: string | null;
  vars: Record<string, string>;
  label: string;
}

/** An Env whose key is known to be set. */
type ActiveEnv = Env & { key: string };

type SelectionResult =
  | { status: "selected"; org: Org }
  | { status: "cancelled" }
  | { status: "skipped" };

interface StatusState {
  text: string;
  tooltip: string;
}

class OrgFetchError extends Error {
  readonly code: "NO_TOKEN" | "BAD_TOKEN" | undefined;

  constructor(message: string, code?: "NO_TOKEN" | "BAD_TOKEN") {
    super(message);
    this.name = "OrgFetchError";
    this.code = code;
  }
}

const ORG_HEADER = "x-org-id";
const SETTINGS_PREFIX = "org:";
const LOG = "[contextual-org-picker]";

export default function createContextualOrgPicker(context: PluginContext): Plugin {
  // envKey -> Promise<SelectionResult>, so parallel requests (Run All) share one picker
  const pendingSelections = new Map<string, Promise<SelectionResult>>();
  // cleanup callbacks for event subscriptions
  const unsubscribers: Array<() => void> = [];

  // ---------------------------------------------------------------------------
  // Environment, token, settings
  // ---------------------------------------------------------------------------

  async function getEnv(): Promise<Env> {
    const env = await window.electron?.env?.load?.();
    const key = env?.activeEnv ?? null;
    const vars = (key && env?.data?.[key]) || {};
    const label = (key && env?.displayNames?.[key]) || key || "no environment";
    return { key, vars, label };
  }

  function hasKey(env: Env): env is ActiveEnv {
    return Boolean(env.key);
  }

  function resolveTemplate(text: string | undefined, vars: Record<string, string>): string {
    let out = String(text ?? "");
    for (let i = 0; i < 5 && out.includes("{{"); i++) {
      out = out.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (m, name: string) =>
        typeof vars[name] === "string" ? vars[name] : m,
      );
    }
    return out;
  }

  async function getToken(): Promise<string | null> {
    const vars = await window.electron?.variables?.readMerged?.();
    return vars?.oauth2_access_token || null;
  }

  async function getSelection(envKey: string): Promise<Org | null> {
    return (await context.settings.get<Org>(SETTINGS_PREFIX + envKey)) || null;
  }

  async function setSelection(envKey: string, org: Org): Promise<void> {
    await context.settings.set(SETTINGS_PREFIX + envKey, org);
    void refreshStatus();
  }

  async function clearSelection(envKey: string): Promise<void> {
    await context.settings.delete(SETTINGS_PREFIX + envKey);
    void refreshStatus();
  }

  // ---------------------------------------------------------------------------
  // Status bar label
  //
  // Voiden has no API to update a status bar item after registering it, but it
  // renders `label` as a React child. So the label is a tiny component (built with
  // Voiden's shared React) subscribed to this plugin's own state, and it re-renders
  // whenever the selection or the active environment changes.
  // ---------------------------------------------------------------------------

  let status: StatusState = { text: "Org", tooltip: "Contextual organization: click to switch" };
  const statusListeners = new Set<() => void>();

  function setStatus(next: StatusState): void {
    if (next.text === status.text && next.tooltip === status.tooltip) return;
    status = next;
    statusListeners.forEach((listener) => listener());
  }

  async function refreshStatus(): Promise<void> {
    try {
      const env = await getEnv();
      if (!hasKey(env)) {
        setStatus({ text: "No org", tooltip: "Contextual organization: choose an environment first" });
        return;
      }
      const org = await getSelection(env.key);
      setStatus(
        org
          ? { text: org.id, tooltip: `x-org-id for ${env.label}: ${org.name} (${org.id}). Click to switch.` }
          : { text: "Select org", tooltip: `No organization selected for ${env.label}. Click to choose one.` },
      );
    } catch (err) {
      console.warn(LOG, "couldn't refresh status bar", err);
    }
  }

  // Returns a React element that renders status[key] live, or the current
  // string if Voiden's shared React isn't available.
  function liveStatus(key: keyof StatusState): unknown {
    const React = window.__voiden_shims__?.react;
    if (!React?.createElement || !React?.useSyncExternalStore) return status[key];
    const { createElement, useSyncExternalStore } = React as ReactShim;
    const subscribe = (listener: () => void) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    };
    function ContextualOrgStatus() {
      return useSyncExternalStore(subscribe, () => status[key]);
    }
    return createElement(ContextualOrgStatus);
  }

  // ---------------------------------------------------------------------------
  // Fetch organizations
  // ---------------------------------------------------------------------------

  function decodeBody(body: unknown): string {
    if (body == null) return "";
    if (typeof body === "string") return body;
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
    if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
    // A Node Buffer serialized across the IPC bridge: { type: "Buffer", data: number[] }
    if (typeof body === "object" && "type" in body && "data" in body) {
      const { type, data } = body as { type: unknown; data: unknown };
      if (type === "Buffer" && Array.isArray(data)) {
        return new TextDecoder().decode(new Uint8Array(data as number[]));
      }
    }
    return String(body);
  }

  async function fetchOrgs(env: Env): Promise<Org[]> {
    const base = resolveTemplate(env.vars.AUTH_API_URL, env.vars);
    if (!base || base.includes("{{")) {
      throw new OrgFetchError(`AUTH_API_URL is not set for environment "${env.label}".`);
    }

    const token = await getToken();
    if (!token) throw new OrgFetchError("Not signed in yet.", "NO_TOKEN");

    const sendRequest = window.electron?.sendRequest;
    if (!sendRequest) throw new OrgFetchError("Voiden's request bridge isn't available.");

    const url = `${base.replace(/\/+$/, "")}/organizations?fields=id,name`;
    const res = await sendRequest(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

    if (!res?.status) {
      throw new OrgFetchError(`Couldn't reach ${url}: ${res?.statusText || "network error"}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new OrgFetchError(
        `Organizations request was rejected (${res.status}). Your token may have expired.`,
        "BAD_TOKEN",
      );
    }
    if (res.status >= 300) {
      throw new OrgFetchError(`Organizations request failed: ${res.status} ${res.statusText || ""}`.trim());
    }

    const json: unknown = JSON.parse(decodeBody(res.body) || "{}");
    const items: unknown[] = Array.isArray(json)
      ? json
      : Array.isArray((json as { items?: unknown })?.items)
        ? (json as { items: unknown[] }).items
        : [];
    return items
      .filter((o): o is { id: unknown; name?: unknown } => typeof o === "object" && o != null && (o as { id?: unknown }).id != null)
      .map((o) => ({ id: String(o.id), name: o.name ? String(o.name) : String(o.id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------------------------------------------------------------------------
  // Picker overlay
  //
  // Mirrors Voiden's built-in branch picker (core/git/components/GitBranchesList.tsx):
  // same overlay, panel, header, search row and list-item classes, so it picks up
  // the active theme. That component uses `cmdk`, which plugins can't import, so the
  // keyboard behaviour (↑/↓, Enter, Esc, hover-to-select) is reimplemented here and
  // the highlighted row is marked with data-selected="true" exactly like cmdk does.
  // ---------------------------------------------------------------------------

  const SVG_NS = "http://www.w3.org/2000/svg";
  // lucide icon paths (same icon set Voiden uses)
  const ICONS = {
    building: [
      "M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z",
      "M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2",
      "M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2",
      "M10 6h4", "M10 10h4", "M10 14h4", "M10 18h4",
    ],
    check: ["M20 6 9 17l-5-5"],
  } satisfies Record<string, string[]>;

  function icon(name: keyof typeof ICONS, size: number, className?: string): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [k, v] of Object.entries({
      width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
      "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round",
    })) svg.setAttribute(k, String(v));
    if (className) svg.setAttribute("class", className);
    for (const d of ICONS[name]) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string | null,
    text?: string | null,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const ITEM_CLASSES = [
    "flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors border-l-2",
    "data-[selected=true]:bg-active data-[selected=true]:border-accent",
    "hover:bg-active/50 border-transparent",
  ].join(" ");

  const PICKER_KEYS = new Set(["Escape", "Enter", "ArrowDown", "ArrowUp", "Home", "End"]);

  function showPicker(orgs: Org[], envLabel: string, currentId: string | undefined): Promise<Org | null> {
    return new Promise((resolve) => {
      // Overlay + panel (same classes as the branch picker)
      const overlay = el("div", "fixed inset-0 z-[9999] flex items-start justify-center pt-[20vh] bg-black/50");
      const wrapper = el("div", "w-full max-w-2xl mx-4");
      const panel = el("div", "bg-editor border border-border rounded-lg shadow-lg overflow-hidden");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "Select Organization");

      // Header
      const header = el("div", "flex items-center gap-3 py-3 px-4 border-b border-border");
      header.append(
        icon("building", 16, "text-accent flex-shrink-0"),
        el("span", "text-sm font-medium text-text", "Select Organization"),
        el("span", "text-xs text-comment", envLabel),
        el("span", "text-xs text-comment ml-auto", "ESC to close"),
      );

      // Search row
      const searchRow = el("div", "flex items-center gap-3 py-2 px-4 border-b border-border");
      const input = el("input", "flex-1 bg-transparent outline-none text-sm text-text placeholder:text-comment");
      input.type = "text";
      input.placeholder = "Search organizations by name or id...";
      input.setAttribute("aria-label", "Search organizations");
      input.addEventListener("mousedown", (e) => e.stopPropagation());
      searchRow.append(input);

      // List
      const list = el("div", "max-h-[400px] overflow-y-auto");
      list.setAttribute("role", "listbox");

      panel.append(header, searchRow, list);
      wrapper.append(panel);
      overlay.append(wrapper);

      let visible: Org[] = [];
      let rows: HTMLDivElement[] = [];
      let selected = 0;

      const finish = (org: Org | null) => {
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        resolve(org);
      };

      function select(index: number, scroll: boolean): void {
        if (rows.length === 0) return;
        selected = (index + rows.length) % rows.length;
        rows.forEach((r, i) => {
          r.setAttribute("data-selected", String(i === selected));
          r.setAttribute("aria-selected", String(i === selected));
        });
        if (scroll) rows[selected].scrollIntoView({ block: "nearest" });
      }

      function render(): void {
        const q = input.value.trim().toLowerCase();
        visible = q
          ? orgs.filter((o) => o.name.toLowerCase().includes(q) || o.id.toLowerCase().includes(q))
          : orgs;
        list.replaceChildren();
        rows = [];

        if (visible.length === 0) {
          list.append(el("div", "px-4 py-4 text-center text-comment text-sm", "No matching organizations"));
          return;
        }

        visible.forEach((org, i) => {
          const row = el("div", ITEM_CLASSES);
          row.setAttribute("role", "option");

          const text = el("div", "flex-1 min-w-0");
          text.append(el("div", "text-sm text-text truncate", org.name), el("div", "text-xs text-comment", org.id));
          row.append(icon("building", 16, "text-comment flex-shrink-0"), text);

          if (org.id === currentId) {
            const badge = el("div", "flex items-center gap-1 text-xs text-green-600 dark:text-green-400");
            badge.append(icon("check", 12), el("span", null, "Active"));
            row.append(badge);
          }

          row.addEventListener("mousemove", () => { if (selected !== i) select(i, false); });
          row.addEventListener("click", () => finish(org));
          list.append(row);
          rows.push(row);
        });

        const currentIndex = q ? -1 : visible.findIndex((o) => o.id === currentId);
        select(currentIndex >= 0 ? currentIndex : 0, true);
      }

      function onKey(e: KeyboardEvent): void {
        if (!PICKER_KEYS.has(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") finish(null);
        else if (e.key === "Enter") { if (visible.length > 0) finish(visible[selected]); }
        else if (e.key === "ArrowDown") select(selected + 1, true);
        else if (e.key === "ArrowUp") select(selected - 1, true);
        else if (e.key === "Home") select(0, true);
        else if (e.key === "End") select(rows.length - 1, true);
      }

      input.addEventListener("input", render);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(null); });
      wrapper.addEventListener("click", (e) => { if (e.target === wrapper) finish(null); });
      document.addEventListener("keydown", onKey, true);

      render();
      document.body.append(overlay);
      input.focus();
    });
  }

  // ---------------------------------------------------------------------------
  // Selection flow
  // ---------------------------------------------------------------------------

  async function chooseOrg(env: ActiveEnv, { forcePicker = false } = {}): Promise<SelectionResult> {
    let orgs: Org[];
    try {
      orgs = await fetchOrgs(env);
    } catch (err) {
      if (err instanceof OrgFetchError && err.code === "NO_TOKEN") {
        context.ui.showToast(
          "Contextual: sign in first. This request will go out without an org; you'll be asked to pick one on your next request.",
          "warning",
        );
      } else {
        const message = err instanceof Error ? err.message : String(err);
        context.ui.showToast(`Contextual: ${message}`, "error");
      }
      console.warn(LOG, err);
      return { status: "skipped" };
    }

    if (orgs.length === 0) {
      context.ui.showToast(`Contextual: your account has no organizations in ${env.label}.`, "warning");
      return { status: "skipped" };
    }

    const current = await getSelection(env.key);
    let org: Org | null;
    if (orgs.length === 1 && !forcePicker) {
      org = orgs[0];
    } else {
      org = await showPicker(orgs, env.label, current?.id);
      if (!org) return { status: "cancelled" };
    }

    await setSelection(env.key, org);
    context.ui.showToast(`Contextual: using ${org.name} (${org.id}) for ${env.label}`, "success");
    return { status: "selected", org };
  }

  function chooseOrgOnce(env: ActiveEnv, opts?: { forcePicker?: boolean }): Promise<SelectionResult> {
    let pending = pendingSelections.get(env.key);
    if (!pending) {
      pending = chooseOrg(env, opts).finally(() => pendingSelections.delete(env.key));
      pendingSelections.set(env.key, pending);
    }
    return pending;
  }

  // ---------------------------------------------------------------------------
  // Pipeline hook
  // ---------------------------------------------------------------------------

  function isOrgListRequest(url: string | undefined): boolean {
    return /\{\{\s*AUTH_API_URL\s*\}\}\/organizations\/?(\?|$)/.test(String(url || ""));
  }

  async function preSendHook(ctx: PipelineHookContext): Promise<void> {
    const requestState = ctx?.requestState;
    const headers = requestState?.headers;
    if (!requestState || !Array.isArray(headers)) return;

    const orgHeaders = headers.filter(
      (h) => h && typeof h.key === "string" && h.key.trim().toLowerCase() === ORG_HEADER && h.enabled !== false,
    );
    if (orgHeaders.length === 0) return; // request doesn't use an org — leave it alone
    if (isOrgListRequest(requestState.url)) return; // never block the org listing itself

    const env = await getEnv();
    if (!hasKey(env)) return;

    let org = await getSelection(env.key);
    if (!org) {
      const result = await chooseOrgOnce(env);
      if (result.status === "cancelled") {
        requestState.metadata = requestState.metadata || {};
        requestState.metadata.scriptCancelled = true;
        context.ui.showToast("Contextual: request cancelled — no organization selected.", "info");
        return;
      }
      if (result.status !== "selected") return; // skipped: send as-is
      org = result.org;
    }

    for (const h of orgHeaders) h.value = org.id;
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  async function switchOrg(): Promise<void> {
    const env = await getEnv();
    if (!hasKey(env)) {
      context.ui.showToast("Contextual: choose an environment first.", "warning");
      return;
    }
    await chooseOrgOnce(env, { forcePicker: true });
  }

  async function clearOrg(): Promise<void> {
    const env = await getEnv();
    if (!hasKey(env)) return;
    await clearSelection(env.key);
    context.ui.showToast(`Contextual: cleared the organization for ${env.label}. You'll be asked again on your next request.`, "info");
  }

  async function showCurrentOrg(): Promise<void> {
    const env = await getEnv();
    const org = hasKey(env) ? await getSelection(env.key) : null;
    context.ui.showToast(
      org ? `Contextual: ${env.label} → ${org.name} (${org.id})` : `Contextual: no organization selected for ${env.label}.`,
      "info",
    );
  }

  return {
    async onload() {
      await context.pipeline.registerHook("pre-send", preSendHook, 50);

      context.registerStatusBarItem({
        id: "contextual-org-picker",
        icon: "Building2",
        label: liveStatus("text"),
        tooltip: liveStatus("tooltip"),
        position: "right",
        onClick: () => { void switchOrg(); },
      });

      // Keep the label in sync with the active environment / project.
      // Needs the "events" permission; without it the label still updates on
      // selection changes, just not on environment switches.
      for (const event of ["environment:changed", "project:changed"]) {
        try {
          unsubscribers.push(context.events.on(event, () => { void refreshStatus(); }));
        } catch (err) {
          console.warn(LOG, `couldn't subscribe to ${event}`, err);
        }
      }
      void refreshStatus();

      context.registerCommand({
        id: "switch-org",
        label: "Contextual: Switch organization",
        description: "Pick the org sent as x-org-id for the active environment",
        action: () => { void switchOrg(); },
      });
      context.registerCommand({
        id: "show-org",
        label: "Contextual: Show current organization",
        action: () => { void showCurrentOrg(); },
      });
      context.registerCommand({
        id: "clear-org",
        label: "Contextual: Clear organization",
        description: "Forget the org for the active environment",
        action: () => { void clearOrg(); },
      });

      console.info(LOG, "loaded");
    },

    async onunload() {
      for (const unsubscribe of unsubscribers.splice(0)) {
        try { unsubscribe?.(); } catch { /* ignore */ }
      }
      statusListeners.clear();
      await context.pipeline.unregister();
    },
  };
}
