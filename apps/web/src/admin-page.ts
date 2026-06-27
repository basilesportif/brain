import { Buffer } from "node:buffer";
import type { BrainAdminServiceConfig } from "./admin-service.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

function adminSignInPath(routePath: string): string {
  return `${routePath.replace(/\/+$/, "")}/auth/sign-in`;
}

function clerkFrontendApiFromPublishableKey(publishableKey: string): string {
  const encoded = publishableKey.split("_")[2] ?? "";
  if (!encoded) return "";
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "").trim();
    return /^[A-Za-z0-9.-]+$/.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}

function clerkAssetBase(config: BrainAdminServiceConfig): string {
  const frontendApi = clerkFrontendApiFromPublishableKey(config.clerkPublishableKey);
  return frontendApi ? `https://${frontendApi}/npm/@clerk` : "https://cdn.jsdelivr.net/npm/@clerk";
}

function clerkUiScriptUrl(config: BrainAdminServiceConfig): string {
  return `${clerkAssetBase(config)}/ui@1/dist/ui.browser.js`;
}

function clerkJsScriptUrl(config: BrainAdminServiceConfig): string {
  return `${clerkAssetBase(config)}/clerk-js@6/dist/clerk.browser.js`;
}

function jsonScriptPayload(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return char;
    }
  });
}

type HtmlChild = string | false | null | undefined;

function h(tag: string, attrs: Record<string, string | number | boolean | undefined | null>, ...children: HtmlChild[]): string {
  const renderedAttrs = Object.entries(attrs)
    .filter(([, value]) => value !== false && value !== null && value !== undefined)
    .map(([key, value]) => value === true ? ` ${key}` : ` ${key}="${escapeHtml(String(value))}"`)
    .join("");
  return `<${tag}${renderedAttrs}>${children.filter((child) => child !== false && child !== null && child !== undefined).join("")}</${tag}>`;
}

function css(): string {
  return `
:root{color-scheme:dark;--bg:#08111f;--panel:#0f1b2d;--panel2:#121f33;--panel3:#17243a;--line:#29405e;--muted:#99a8bd;--text:#e8eef8;--soft:#c9d5e5;--accent:#5b8cff;--accent2:#67e8f9;--ok:#74e4a2;--warn:#fbbf24;--bad:#fb7185;--shadow:0 18px 50px #0006}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;background:linear-gradient(135deg,#07101d 0%,#101827 45%,#0b1324 100%);color:var(--text)}a{color:#bcd1ff;text-decoration:none}a:hover{text-decoration:underline}.shell{min-height:100vh}.topbar{position:sticky;top:0;z-index:20;display:grid;grid-template-columns:1fr auto;gap:16px;align-items:center;padding:10px 18px;border-bottom:1px solid var(--line);background:#08111fe8;backdrop-filter:blur(16px)}.brand{display:flex;gap:12px;align-items:center;min-width:0}.logo{display:grid;place-items:center;width:34px;height:34px;border-radius:11px;background:linear-gradient(135deg,var(--accent),#8b5cf6);font-weight:800}.brand h1{margin:0;font-size:18px;letter-spacing:.01em}.subtitle{margin:1px 0 0;color:var(--muted);font-size:12px}.chips,.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.chip,.badge{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--line);background:#0b1627;border-radius:999px;color:var(--soft);padding:4px 8px;font-size:12px;white-space:nowrap}.chip.ok,.badge.ok{border-color:#256c48;color:#a7f3d0;background:#0d2a1e}.chip.warn,.badge.warn{border-color:#8a6518;color:#fde68a;background:#2b210d}.chip.bad,.badge.bad{border-color:#8f2d40;color:#fecdd3;background:#35111b}.header-actions{display:flex;gap:10px;align-items:center;justify-content:flex-end}.user-menu{position:relative}.icon-button,.btn{appearance:none;border:1px solid #45617f;background:#17243a;color:var(--text);border-radius:10px;padding:8px 10px;font:inherit;cursor:pointer}.icon-button{min-width:38px;height:38px;border-radius:999px}.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font-weight:650}.btn.primary{background:#285eea;border-color:#4d7cff}.btn.danger{background:#3a1520;border-color:#a43c52;color:#ffd3da}.btn.ghost{background:#0b1627}.btn:disabled{opacity:.45;cursor:not-allowed}.menu{position:absolute;right:0;top:44px;min-width:260px;padding:10px;border:1px solid var(--line);border-radius:14px;background:#101c2f;box-shadow:var(--shadow)}.menu[hidden]{display:none}.menu .menu-title{font-weight:750;margin:0 0 4px}.menu .menu-email{margin:0 0 10px;color:var(--muted);word-break:break-all}.layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:18px;max-width:1440px;margin:0 auto;padding:18px}.side{position:sticky;top:68px;align-self:start;border:1px solid var(--line);border-radius:18px;background:#0c1728cc;padding:12px}.nav{display:grid;gap:4px}.nav a{display:flex;align-items:center;justify-content:space-between;padding:9px 10px;border-radius:11px;color:var(--soft)}.nav a:hover,.nav a.active{background:#17243a;text-decoration:none}.content{display:grid;gap:18px}.status-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.metric{border:1px solid var(--line);border-radius:16px;background:linear-gradient(180deg,#122036,#0d192b);padding:13px}.metric .label{color:var(--muted);font-size:12px}.metric .value{margin-top:5px;font-size:17px;font-weight:780;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.metric .hint{margin-top:4px;color:var(--muted);font-size:12px}.section{scroll-margin-top:86px;border:1px solid var(--line);border-radius:20px;background:#0d182acc;box-shadow:0 10px 35px #0003;overflow:hidden}.section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 18px;border-bottom:1px solid var(--line);background:#101d31}.section h2{margin:0;font-size:18px}.section p{margin:6px 0 0}.section-body{padding:18px}.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.card{border:1px solid var(--line);border-radius:16px;background:#111e32;padding:15px}.card h3{margin:0 0 8px;font-size:15px}.muted{color:var(--muted)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}.small{font-size:12px}.table{width:100%;border-collapse:collapse}.table th,.table td{padding:9px;border-bottom:1px solid #263b57;text-align:left;vertical-align:top}.table th{color:#bfd0e6;font-size:12px;text-transform:uppercase;letter-spacing:.04em}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.field{display:grid;gap:5px}.field label{font-weight:700}.field .help{font-size:12px;color:var(--muted)}input,select,textarea{width:100%;border:1px solid #425a78;border-radius:10px;background:#06101f;color:var(--text);padding:9px 10px;font:inherit}textarea{min-height:130px;resize:vertical}.code{max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-word;border:1px solid #253a57;border-radius:14px;background:#06101f;padding:12px}.alert{border:1px solid var(--line);border-radius:14px;padding:11px 12px;background:#122036}.alert.ok{border-color:#256c48;background:#0d2a1e}.alert.warn{border-color:#8a6518;background:#2b210d}.alert.bad{border-color:#8f2d40;background:#35111b}.details{border:1px solid var(--line);border-radius:14px;background:#0b1627;margin-top:12px;overflow:hidden}.details summary{cursor:pointer;padding:11px 12px;font-weight:750}.details>div{padding:0 12px 12px}.activity-list{display:grid;gap:8px;margin:0;padding:0;list-style:none}.activity-list li{border:1px solid #263b57;border-radius:12px;padding:10px;background:#0b1627}.two-col{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(320px,.85fr);gap:14px}.mobile-tabs{display:none}.skip{position:absolute;left:-999px}.skip:focus{left:12px;top:12px;z-index:50;background:#fff;color:#000;padding:8px;border-radius:8px}.hidden{display:none!important}
@media (max-width: 960px){.topbar{grid-template-columns:1fr;padding:9px 12px}.header-actions{justify-content:space-between}.chips{width:100%;overflow:auto;flex-wrap:nowrap;padding-bottom:2px}.layout{display:block;padding:12px}.side{display:none}.mobile-tabs{position:sticky;top:91px;z-index:10;display:flex;gap:8px;overflow:auto;margin:0 -12px 12px;padding:8px 12px;border-bottom:1px solid var(--line);background:#08111fe8}.mobile-tabs a{white-space:nowrap;border:1px solid var(--line);border-radius:999px;padding:7px 10px;color:var(--soft);background:#0b1627}.status-strip,.cards,.two-col,.form-grid{grid-template-columns:1fr}.section-head{display:block}.section-body{padding:14px}.table,.table tbody,.table tr,.table td,.table th{display:block}.table thead{display:none}.table tr{border:1px solid #263b57;border-radius:12px;margin-bottom:10px;padding:6px;background:#0b1627}.table td{border:0;padding:6px}.table td::before{content:attr(data-label);display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}.brand h1{font-size:17px}.menu{right:auto;left:0;max-width:calc(100vw - 24px)}}`;
}

function header(config: BrainAdminServiceConfig, adminEmail: string, signInUrl: string): string {
  return h("header", { class: "topbar" },
    h("a", { class: "skip", href: "#main" }, "Skip to admin content"),
    h("div", { class: "brand" },
      h("div", { class: "logo", "aria-hidden": "true" }, "B"),
      h("div", {},
        h("h1", {}, "Brain"),
        h("p", { class: "subtitle" }, `${escapeHtml(config.instanceName)} · ${escapeHtml(config.codexChatServiceName)} · ${escapeHtml(config.codexChatHost)}`),
        h("div", { class: "chips", "aria-label": "Current status summary" },
          h("span", { id: "chip-auth", class: "chip warn" }, "auth checking"),
          h("span", { id: "chip-health", class: "chip warn" }, "health loading"),
          h("span", { id: "chip-slack", class: "chip" }, "Slack Events URL"),
          h("span", { id: "chip-restart", class: "chip" }, "restart not pending"),
        ),
      ),
    ),
    h("div", { class: "header-actions" },
      h("button", { class: "btn ghost", type: "button", onclick: "refresh()", "aria-label": "Refresh Brain admin status" }, "↻ Refresh"),
      h("div", { class: "user-menu" },
        h("button", { class: "icon-button", type: "button", onclick: "toggleAccountMenu()", "aria-haspopup": "menu", "aria-controls": "account-menu", "aria-label": "Open account menu" }, "◎"),
        h("div", { id: "account-menu", class: "menu", role: "menu", hidden: true },
          h("p", { class: "menu-title" }, "Current account"),
          h("p", { id: "account-email", class: "menu-email mono" }, escapeHtml(adminEmail || "unknown account")),
          h("div", { class: "row" },
            h("a", { class: "btn ghost", role: "menuitem", href: signInUrl }, "Account page"),
            h("button", { class: "btn ghost", role: "menuitem", type: "button", onclick: "signOut()" }, "Sign out / switch account"),
          ),
          h("p", { id: "account-error", class: "small", role: "alert" }, ""),
        ),
      ),
    ),
  );
}

function nav(): string {
  const items = [
    ["Overview", "overview"], ["Slack", "slack"], ["Manifest", "manifest"], ["Env & Config", "env"], ["Deploy", "deploy"], ["Audit", "audit"], ["Advanced", "advanced"],
  ];
  const links = items.map(([label, id]) => h("a", { href: `#${id}` }, escapeHtml(label), h("span", { "aria-hidden": "true" }, "›"))).join("");
  return `${h("aside", { class: "side", "aria-label": "Admin sections" }, h("nav", { class: "nav" }, links))}${h("nav", { class: "mobile-tabs", "aria-label": "Admin sections" }, links)}`;
}

function section(id: string, title: string, description: string, body: string, action = ""): string {
  return h("section", { id, class: "section", "aria-labelledby": `${id}-title` },
    h("div", { class: "section-head" },
      h("div", {}, h("h2", { id: `${id}-title` }, escapeHtml(title)), h("p", { class: "muted" }, escapeHtml(description))),
      action,
    ),
    h("div", { class: "section-body" }, body),
  );
}

function dashboard(): string {
  return h("div", { class: "content" },
    h("div", { id: "status-region", class: "status-strip", role: "status", "aria-live": "polite" },
      h("div", { class: "metric" }, h("div", { class: "label" }, "Account"), h("div", { id: "metric-account", class: "value" }, "Checking"), h("div", { class: "hint" }, "Clerk allowlist enforced server-side")),
      h("div", { class: "metric" }, h("div", { class: "label" }, "Brain service"), h("div", { id: "metric-brain", class: "value" }, "Loading"), h("div", { id: "metric-brain-hint", class: "hint" }, "Fail-closed auth")),
      h("div", { class: "metric" }, h("div", { class: "label" }, "Slack readiness"), h("div", { id: "metric-slack", class: "value" }, "Loading"), h("div", { id: "metric-slack-hint", class: "hint" }, "Presence only")),
      h("div", { class: "metric" }, h("div", { class: "label" }, "Deploy state"), h("div", { id: "metric-deploy", class: "value" }, "Plan first"), h("div", { id: "metric-deploy-hint", class: "hint" }, "No global restart controls")),
    ),
    section("overview", "Overview", "Daily status for this concrete Brain instance and its codex-chat target.", h("div", { class: "cards" },
      h("article", { class: "card" }, h("h3", {}, "Instance identity"), h("div", { id: "overview-instance" }, "Loading…")),
      h("article", { class: "card" }, h("h3", {}, "codex-chat target"), h("div", { id: "overview-codex" }, "Loading…")),
      h("article", { class: "card" }, h("h3", {}, "Auth & security"), h("div", { id: "overview-auth" }, "Loading…")),
      h("article", { class: "card" }, h("h3", {}, "Recent feedback"), h("div", { id: "overview-feedback" }, h("p", { class: "muted" }, "Page-local activity appears here after actions."))),
    )),
    section("slack", "Slack", "Events endpoint and write-only Slack settings grouped by purpose.",
      h("div", { class: "two-col" },
        h("div", { class: "card" },
          h("h3", {}, "Required settings"),
          h("p", { class: "muted small" }, "Secret values are never shown or prefilled. Blank fields keep existing values."),
          h("div", { id: "slack-settings-table" }, "Loading Slack settings…"),
          h("details", { class: "details" }, h("summary", {}, "Update Slack settings"), h("div", {},
            h("div", { id: "slack-fields", class: "form-grid" }, ""),
            h("div", { class: "field", style: "margin-top:12px" }, h("label", { for: "slack-approval" }, "Approval phrase"), h("input", { id: "slack-approval", autocomplete: "off", placeholder: "write Slack settings" }), h("div", { class: "help" }, "Type exactly: write Slack settings")),
            h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "btn primary", type: "button", onclick: "writeSlackSettings()" }, "Write Slack settings")),
            h("div", { id: "slack-result", style: "margin-top:12px" }, ""),
          )),
        ),
        h("aside", { class: "card" }, h("h3", {}, "Events endpoint"), h("div", { id: "slack-endpoint" }, "Loading…"), h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "btn ghost", type: "button", onclick: "copySlackUrl()" }, "Copy Events URL"))),
      ),
    ),
    section("manifest", "Manifest", "Render/copy/download the codex-chat-owned Slack manifest; JSON stays collapsed by default.",
      h("div", { class: "card" },
        h("div", { id: "manifest-summary" }, "Manifest not rendered yet."),
        h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "btn primary", type: "button", onclick: "loadManifest()" }, "Render / validate"), h("button", { class: "btn ghost", type: "button", onclick: "copyManifest()" }, "Copy JSON"), h("button", { class: "btn ghost", type: "button", onclick: "downloadManifest()" }, "Download JSON"), h("button", { class: "btn ghost", type: "button", onclick: "openManifestDraft()" }, "Edit draft")),
        h("div", { id: "manifest-result", style: "margin-top:12px" }, ""),
        h("details", { id: "manifest-json-details", class: "details" }, h("summary", {}, "View manifest JSON"), h("div", {}, h("pre", { id: "manifest-text", class: "code mono" }, "Render the manifest to view JSON."))),
        h("details", { id: "manifest-draft-details", class: "details" }, h("summary", {}, "Draft-only manifest editor"), h("div", {}, h("p", { class: "alert warn" }, "Draft only — codex-chat remains source of truth. This editor does not save."), h("textarea", { id: "manifest-draft", class: "mono", spellcheck: "false" }, ""), h("div", { class: "row", style: "margin-top:10px" }, h("button", { class: "btn ghost", type: "button", onclick: "copyManifestDraft()" }, "Copy draft"), h("button", { class: "btn ghost", type: "button", onclick: "downloadManifestDraft()" }, "Download draft"))))
      ),
    ),
    section("env", "Env & Config", "Presence-only codex-chat env metadata and an advanced write-only escape hatch.",
      h("div", { class: "two-col" },
        h("div", { class: "card" }, h("h3", {}, "Env metadata"), h("div", { id: "env-table" }, "Loading…")),
        h("aside", { class: "card" }, h("h3", {}, "Write env entry"), h("p", { class: "muted small" }, "Use Slack settings for Slack keys when possible. Values are write-only and fields clear after success."), h("div", { class: "form-grid" },
          h("div", { class: "field" }, h("label", { for: "env-key" }, "Key"), h("input", { id: "env-key", list: "env-key-options", placeholder: "CODEX_CHAT_BASE_URL" }), h("datalist", { id: "env-key-options" }, ""), h("div", { class: "help" }, "Must be allowlisted by the server.")),
          h("div", { class: "field" }, h("label", { for: "env-value" }, "Value"), h("input", { id: "env-value", type: "password", autocomplete: "off", placeholder: "write-only" }), h("div", { class: "help" }, "Never displayed after submission.")),
        ), h("div", { class: "field", style: "margin-top:12px" }, h("label", { for: "env-approval" }, "Approval phrase"), h("input", { id: "env-approval", autocomplete: "off", placeholder: "write env" }), h("div", { class: "help" }, "Type exactly: write env")), h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "btn primary", type: "button", onclick: "writeEnv()" }, "Write entry")), h("div", { id: "env-result", style: "margin-top:12px" }, "")),
      ),
    ),
    section("deploy", "Deploy / Restart", "Plan-first controls for codex-chat operations; no Brain or codex-chat parent process restart from this UI.",
      h("div", { class: "two-col" },
        h("div", { class: "card" }, h("h3", {}, "Operation review"), h("p", { class: "alert warn" }, "Run a fresh plan before restart/deploy. Exact approval examples: plan codex-chat.service, restart codex-chat.service, deploy codex-chat.service. Live operations are audited."), h("div", { id: "operation-target" }, "Loading target…"), h("div", { class: "form-grid", style: "margin-top:12px" },
          h("div", { class: "field" }, h("label", { for: "op" }, "Operation"), h("select", { id: "op", onchange: "syncOperationApproval()" }, h("option", { value: "plan" }, "plan"), h("option", { value: "restart" }, "restart"), h("option", { value: "deploy" }, "deploy")), h("div", { class: "help" }, "Plan has no side effects.")),
          h("div", { class: "field" }, h("label", { for: "op-approval" }, "Approval phrase"), h("input", { id: "op-approval", autocomplete: "off", placeholder: "plan codex-chat.service" }), h("div", { id: "op-help", class: "help" }, "Type exactly: plan codex-chat.service")),
        ), h("label", { class: "row small", style: "margin-top:10px" }, h("input", { id: "op-bypass-plan", type: "checkbox", style: "width:auto" }), "Run without fresh plan (restart/deploy only)"), h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "btn primary", type: "button", onclick: "runOperation()" }, "Run operation")), h("div", { id: "op-result", style: "margin-top:12px" }, "")),
        h("aside", { class: "card" }, h("h3", {}, "Plan state"), h("div", { id: "plan-state" }, h("p", { class: "muted" }, "No plan run in this page session.")), h("details", { class: "details" }, h("summary", {}, "Redacted operation log"), h("div", {}, h("pre", { id: "op-log", class: "code mono" }, "No operation yet."))))
      ),
    ),
    section("audit", "Audit / Feedback", "Current browser-session action feedback. Server writes and operations are still audited server-side.", h("ul", { id: "activity-list", class: "activity-list" }, h("li", { class: "muted" }, "No page-local actions yet."))),
    section("advanced", "Advanced", "Raw JSON/debug payloads remain available here, away from the primary daily workflow.", h("div", { class: "cards" },
      h("article", { class: "card" }, h("h3", {}, "Raw /health"), h("pre", { id: "health", class: "code mono" }, "")),
      h("article", { class: "card" }, h("h3", {}, "Raw /settings"), h("pre", { id: "settings", class: "code mono" }, "")),
      h("article", { class: "card" }, h("h3", {}, "Raw /slack/settings"), h("pre", { id: "slack-raw", class: "code mono" }, "")),
      h("article", { class: "card" }, h("h3", {}, "Raw last response"), h("pre", { id: "raw-last", class: "code mono" }, "")),
    )),
  );
}

function clientScript(): string {
  return `
const SLACK_KEYS=[
  ['CODEX_CHAT_SLACK_ENABLED','Enable Slack runtime','required'],
  ['CODEX_CHAT_BASE_URL','Public Brain base URL','required'],
  ['CODEX_CHAT_SLACK_EVENTS_PATH','Events route path','required'],
  ['SLACK_SIGNING_SECRET','Slack request signature verification','required'],
  ['SLACK_BOT_TOKEN','Slack Web API bot token','required'],
  ['SLACK_APP_TOKEN','Socket mode app token','optional']
];
const CONFIG=JSON.parse(document.getElementById('brain-admin-config').textContent);
let lastManifestText='';
let lastSlackUrl='';
let lastSettings=null;
let planFresh=false;
function esc(v){return String(v??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function clerkEmail(user){const emails=user?.emailAddresses||[];const primary=emails.find(e=>e?.id===user?.primaryEmailAddressId)||emails[0]||user?.primaryEmailAddress;return primary?.emailAddress||user?.primaryEmailAddress?.emailAddress||''}
async function loadClerk(){if(!CONFIG.publishableKey)return null;for(let i=0;i<80&&!window.Clerk;i++)await new Promise(r=>setTimeout(r,100));if(!window.Clerk)return null;await Clerk.load(window.__internal_ClerkUICtor?{ui:{ClerkUI:window.__internal_ClerkUICtor}}:undefined);const email=clerkEmail(Clerk.user)||CONFIG.adminEmail;if(email)setAccountEmail(email);return Clerk}
function setAccountEmail(email){document.getElementById('account-email').textContent=email;document.getElementById('metric-account').textContent=email||'Known admin';}
function toggleAccountMenu(){const menu=document.getElementById('account-menu');menu.hidden=!menu.hidden;}
async function signOut(){try{const clerk=await loadClerk();if(clerk&&clerk.signOut){await clerk.signOut({redirectUrl:CONFIG.signInUrl});return}}catch(e){document.getElementById('account-error').textContent=e?.message||String(e)}location.assign(CONFIG.signInUrl)}
async function tokenHeaders(){if(window.Clerk&&Clerk.session&&Clerk.session.getToken){try{return {authorization:'Bearer '+await Clerk.session.getToken()}}catch{}}return {}}
async function api(path,options={}){const headers={...(await tokenHeaders()),...(options.headers||{})};if(options.body)headers['content-type']='application/json';const res=await fetch(CONFIG.apiBase+path,{...options,headers});const text=await res.text();let body;try{body=JSON.parse(text)}catch{body={raw:text}}if(!res.ok)throw Object.assign(new Error(body.error||res.statusText),{status:res.status,payload:body});return body}
function show(id,value){const text=typeof value==='string'?value:JSON.stringify(value,null,2);const el=document.getElementById(id);if(el)el.textContent=text;showRaw(value);}
function showRaw(value){const el=document.getElementById('raw-last');if(el)el.textContent=typeof value==='string'?value:JSON.stringify(value,null,2)}
function alertHtml(kind,title,body){return '<div class="alert '+kind+'" role="'+(kind==='bad'?'alert':'status')+'"><strong>'+esc(title)+'</strong>'+ (body?'<div class="small">'+esc(body)+'</div>':'')+'</div>'}
function badge(present, warnLabel){return '<span class="badge '+(present?'ok':(warnLabel?'warn':'bad'))+'">'+(present?'present':(warnLabel||'not set'))+'</span>'}
function addActivity(title, detail, kind='ok'){const list=document.getElementById('activity-list');if(list.querySelector('.muted'))list.innerHTML='';const li=document.createElement('li');li.innerHTML='<strong>'+esc(title)+'</strong><div class="small muted">'+esc(new Date().toLocaleString())+' · '+esc(detail||'')+'</div>';li.className=kind==='bad'?'alert bad':'';list.prepend(li);document.getElementById('overview-feedback').innerHTML=alertHtml(kind,title,detail||'');}
function setChip(id,text,kind=''){const el=document.getElementById(id);el.textContent=text;el.className='chip '+kind;}
function keyPresence(summary,key){return Boolean((summary?.env?.keys||summary?.keys||[]).find(k=>k.key===key)?.present)}
function renderKv(entries){return '<dl>'+entries.map(([k,v])=>'<dt class="small muted">'+esc(k)+'</dt><dd class="mono" style="margin:0 0 8px;word-break:break-word">'+esc(v??'not configured')+'</dd>').join('')+'</dl>'}
function renderEnvTable(env){const rows=(env?.keys||[]).map(k=>'<tr><td data-label="Key" class="mono">'+esc(k.key)+'</td><td data-label="Present">'+badge(k.present)+'</td><td data-label="Secret-ish">'+(k.secret?'yes':'no')+'</td><td data-label="Value">'+(k.present?'redacted':'not set')+'</td></tr>').join('');return '<table class="table"><thead><tr><th>Key</th><th>Present</th><th>Secret-ish</th><th>Value</th></tr></thead><tbody>'+rows+'</tbody></table><p class="small muted">env file: <span class="mono">'+esc(env?.envFile||'unknown')+'</span></p>'}
function renderSlackSettings(slack){const rows=SLACK_KEYS.map(([key,purpose,req])=>{const present=keyPresence(slack,key);const secret=/SECRET|TOKEN|KEY/i.test(key);return '<tr><td data-label="Key" class="mono">'+esc(key)+'</td><td data-label="Purpose">'+esc(purpose)+'</td><td data-label="Required">'+esc(req)+'</td><td data-label="Status">'+badge(present,req==='optional'?'optional':'')+'</td><td data-label="Secret-ish">'+(secret?'yes':'no')+'</td><td data-label="Action"><a href="#slack-fields">update</a></td></tr>'}).join('');document.getElementById('slack-settings-table').innerHTML='<table class="table"><thead><tr><th>Key</th><th>Purpose</th><th>Required</th><th>Status</th><th>Secret-ish</th><th>Action</th></tr></thead><tbody>'+rows+'</tbody></table>';document.getElementById('slack-fields').innerHTML=SLACK_KEYS.map(([key,purpose,req])=>'<div class="field"><label for="slack-'+esc(key)+'">'+esc(key)+'</label><input id="slack-'+esc(key)+'" type="password" autocomplete="off" placeholder="leave blank to keep existing value"><div class="help">'+esc(purpose)+' · '+esc(req)+' · '+(keyPresence(slack,key)?'currently present':'currently not set')+'</div></div>').join('');lastSlackUrl=slack?.publicEventsUrl||'';document.getElementById('slack-endpoint').innerHTML=renderKv([['Public Events URL',lastSlackUrl],['Upstream owner',slack?.runtimeOwner||slack?.upstream],['Values',slack?.values||'write-only; presence only']]);const required=SLACK_KEYS.filter(k=>k[2]==='required');const ready=required.filter(([k])=>keyPresence(slack,k)).length;document.getElementById('metric-slack').textContent=ready+'/'+required.length+' required present';document.getElementById('metric-slack-hint').textContent=lastSlackUrl||'Events URL unavailable';setChip('chip-slack','Slack '+ready+'/'+required.length,ready===required.length?'ok':'warn');document.getElementById('slack-raw').textContent=JSON.stringify(slack,null,2);}
async function refresh(){try{const me=await api('/me');const email=me.email||CONFIG.adminEmail||'allowlisted admin';setAccountEmail(email);setChip('chip-auth','allowlisted','ok');document.getElementById('metric-account').textContent=email;const health=await api('/health');document.getElementById('health').textContent=JSON.stringify(health,null,2);const settings=await api('/settings');lastSettings=settings;document.getElementById('settings').textContent=JSON.stringify(settings,null,2);document.getElementById('metric-brain').textContent=health.ok?'OK':'Check auth';document.getElementById('metric-brain-hint').textContent=(health.service||'brain-admin')+' · '+(health.hostname||'local');setChip('chip-health',health.ok?'brain ok':'brain check',health.ok?'ok':'warn');document.getElementById('overview-instance').innerHTML=renderKv([['Instance',settings.instance?.instanceName],['Host',settings.instance?.host],['IP',settings.instance?.ip],['Workspace',settings.instance?.workspacePath],['Config source',settings.instance?.configurationSource]]);document.getElementById('overview-codex').innerHTML=renderKv([['Service',settings.codexChat?.serviceName],['Host/IP',(settings.codexChat?.host||'')+' / '+(settings.codexChat?.ip||'')],['Path',settings.codexChat?.path],['Env file',settings.codexChat?.env?.envFile],['Config file',settings.codexChat?.configFile?.path||'not configured']]);document.getElementById('overview-auth').innerHTML=renderKv([['Configured',settings.auth?.configured?'yes':'no'],['Allowed accounts',settings.auth?.allowedEmailCount],['Fail closed',settings.auth?.failClosed?'yes':'no'],['Current account',email]]);document.getElementById('env-table').innerHTML=renderEnvTable(settings.codexChat?.env);document.getElementById('env-key-options').innerHTML=(settings.codexChat?.env?.allowedKeys||[]).map(k=>'<option value="'+esc(k)+'"></option>').join('');renderSlackSettings(settings.slack||await api('/slack/settings'));document.getElementById('operation-target').innerHTML=renderKv([['Target service',settings.codexChat?.serviceName],['Target path',settings.codexChat?.path],['Restart command',settings.codexChat?.restartCommand||'default systemctl restart'],['Deploy configured',settings.codexChat?.deployCommandConfigured?'yes':'no']]);document.getElementById('metric-deploy').textContent=settings.codexChat?.deployCommandConfigured?'Deploy configured':'Restart only';document.getElementById('metric-deploy-hint').textContent='Plan before live operation';syncOperationApproval();}catch(e){const email=e.payload?.email||CONFIG.adminEmail||document.getElementById('account-email').textContent||'current Clerk account';setAccountEmail(email);setChip('chip-auth','access problem','bad');setChip('chip-health','blocked','bad');document.getElementById('overview-feedback').innerHTML=alertHtml('bad','Access problem',e.payload?.error||e.message);addActivity('Access problem',e.payload?.error||e.message,'bad');}}
async function writeEnv(){try{const key=document.getElementById('env-key').value.trim();const value=document.getElementById('env-value').value;const result=await api('/codex-chat/env',{method:'POST',body:JSON.stringify({entries:{[key]:value},approval:document.getElementById('env-approval').value})});document.getElementById('env-value').value='';document.getElementById('env-result').innerHTML=alertHtml('ok','Env entry written','Restart required for '+(result.writtenKeys||[]).join(', '));setChip('chip-restart','restart required','warn');addActivity('Env write succeeded','Keys: '+(result.writtenKeys||[]).join(', '));showRaw(result);await refresh()}catch(e){document.getElementById('env-result').innerHTML=alertHtml('bad','Env write failed',e.payload?.error||e.message);addActivity('Env write failed',e.payload?.error||e.message,'bad');showRaw(e.payload||e.message)}}
async function writeSlackSettings(){try{const entries={};for(const [key] of SLACK_KEYS){const el=document.getElementById('slack-'+key);if(el?.value)entries[key]=el.value}const result=await api('/slack/settings',{method:'POST',body:JSON.stringify({entries,approval:document.getElementById('slack-approval').value})});for(const [key] of SLACK_KEYS){const el=document.getElementById('slack-'+key);if(el)el.value=''}document.getElementById('slack-result').innerHTML=alertHtml('ok','Slack settings written','Restart required for '+(result.writtenKeys||[]).join(', '));setChip('chip-restart','restart required','warn');addActivity('Slack settings written','Keys: '+(result.writtenKeys||[]).join(', '));showRaw(result);await refresh()}catch(e){document.getElementById('slack-result').innerHTML=alertHtml('bad','Slack write failed',e.payload?.error||e.message);addActivity('Slack write failed',e.payload?.error||e.message,'bad');showRaw(e.payload||e.message)}}
async function loadManifest(){try{const m=await api('/slack/manifest');lastManifestText=m.text||JSON.stringify(m.manifest,null,2)+'\\n';document.getElementById('manifest-text').textContent=lastManifestText;document.getElementById('manifest-summary').innerHTML=renderKv([['Renderer',m.renderer],['Request URL',m.requestUrl],['Events path',m.eventsPath],['Last rendered',new Date().toLocaleString()]]);document.getElementById('manifest-result').innerHTML=alertHtml('ok','Manifest rendered','Copy/download are available from the collapsed summary.');showRaw({renderer:m.renderer,requestUrl:m.requestUrl,eventsPath:m.eventsPath});addActivity('Manifest rendered',m.requestUrl);return m}catch(e){document.getElementById('manifest-result').innerHTML=alertHtml('bad','Manifest render failed',e.payload?.error||e.message);addActivity('Manifest render failed',e.payload?.error||e.message,'bad');showRaw(e.payload||e.message);throw e}}
async function copyText(text){await navigator.clipboard.writeText(text)}
async function copySlackUrl(){if(!lastSlackUrl&&lastSettings?.slack)lastSlackUrl=lastSettings.slack.publicEventsUrl;await copyText(lastSlackUrl||'');addActivity('Slack Events URL copied',lastSlackUrl||'empty');}
async function copyManifest(){if(!lastManifestText)await loadManifest();await copyText(lastManifestText);document.getElementById('manifest-result').innerHTML=alertHtml('ok','Copied manifest JSON','Clipboard updated.');addActivity('Manifest copied','JSON copied to clipboard')}
function downloadText(filename,text,type='application/json'){const blob=new Blob([text],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url)}
async function downloadManifest(){if(!lastManifestText)await loadManifest();downloadText('codex-chat.slack.manifest.json',lastManifestText);addActivity('Manifest downloaded','codex-chat.slack.manifest.json')}
function openManifestDraft(){if(lastManifestText)document.getElementById('manifest-draft').value=lastManifestText;document.getElementById('manifest-draft-details').open=true;document.getElementById('manifest-draft').focus();}
async function copyManifestDraft(){await copyText(document.getElementById('manifest-draft').value);addActivity('Manifest draft copied','Draft only; not saved')}
function downloadManifestDraft(){downloadText('codex-chat.slack.manifest.draft.json',document.getElementById('manifest-draft').value);addActivity('Manifest draft downloaded','Draft only; not saved')}
function syncOperationApproval(){const op=document.getElementById('op').value;const service=lastSettings?.codexChat?.serviceName||'codex-chat.service';const expected=op+' '+service;document.getElementById('op-approval').placeholder=expected;document.getElementById('op-help').textContent='Type exactly: '+expected;if(op==='deploy'&&!lastSettings?.codexChat?.deployCommandConfigured){document.getElementById('op-help').textContent+=' · deploy command is not configured';}}
async function runOperation(){try{const op=document.getElementById('op').value;if((op==='restart'||op==='deploy')&&!planFresh&&!document.getElementById('op-bypass-plan').checked){document.getElementById('op-result').innerHTML=alertHtml('warn','Fresh plan required','Run plan first, or explicitly choose Run without fresh plan.');return}const started=performance.now();const result=await api('/codex-chat/operation',{method:'POST',body:JSON.stringify({operation:op,approval:document.getElementById('op-approval').value})});const duration=Math.round(performance.now()-started);if(op==='plan')planFresh=true;document.getElementById('op-result').innerHTML=alertHtml(result.ok?'ok':'bad',op+' completed','Duration '+duration+'ms'+(result.dryRun?' · dry run':' · audited'));document.getElementById('plan-state').innerHTML=op==='plan'?alertHtml('ok','Fresh plan available','Use restart/deploy in this page session if needed.'):alertHtml('ok','Last live operation finished',op);document.getElementById('op-log').textContent=JSON.stringify(result,null,2);addActivity('Operation '+op+' completed',result.dryRun?'dry run':'status '+result.status);showRaw(result);if(op==='restart')setChip('chip-restart','restart complete','ok');await refresh()}catch(e){document.getElementById('op-result').innerHTML=alertHtml('bad','Operation failed',e.payload?.error||e.message);document.getElementById('op-log').textContent=JSON.stringify(e.payload||e.message,null,2);addActivity('Operation failed',e.payload?.error||e.message,'bad');showRaw(e.payload||e.message)}}
document.addEventListener('click',(event)=>{const menu=document.getElementById('account-menu');if(!menu.hidden&&!event.target.closest('.user-menu'))menu.hidden=true});
loadClerk().catch(()=>{});refresh();`;
}

export function renderBrainAdminPage(config: BrainAdminServiceConfig, adminEmail: string): string {
  const signInUrl = adminSignInPath(config.routePath);
  const payload = jsonScriptPayload({ apiBase: "/api/admin/brain", routePath: config.routePath, publishableKey: config.clerkPublishableKey, signInUrl, adminEmail });
  const clerkUiScript = clerkUiScriptUrl(config);
  const clerkJsScript = clerkJsScriptUrl(config);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brain Control Plane</title><style>${css()}</style></head><body><div class="shell">${header(config, adminEmail, signInUrl)}<div class="layout">${nav()}<main id="main" class="main" tabindex="-1">${dashboard()}</main></div></div><script type="application/json" id="brain-admin-config">${payload}</script><script async crossorigin="anonymous" src="${escapeHtml(clerkUiScript)}"></script><script async crossorigin="anonymous" data-clerk-publishable-key="${escapeHtml(config.clerkPublishableKey)}" src="${escapeHtml(clerkJsScript)}"></script><script>${clientScript()}</script></body></html>`;
}

export function renderBrainAdminSignInPage(config: BrainAdminServiceConfig, redirectUrl: string): string {
  const payload = jsonScriptPayload({ publishableKey: config.clerkPublishableKey, redirectUrl });
  const clerkUiScript = clerkUiScriptUrl(config);
  const clerkJsScript = clerkJsScriptUrl(config);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Brain Control Plane</title><style>body{font:16px system-ui;margin:3rem;max-width:720px;background:#0f172a;color:#e5e7eb}.card{border:1px solid #334155;border-radius:16px;padding:24px;background:#111827}.bad{color:#f87171}.muted{color:#94a3b8}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.hidden{display:none}button,a.button{box-sizing:border-box;font:inherit;border-radius:10px;border:1px solid #475569;background:#2563eb;color:#e5e7eb;padding:10px;text-decoration:none;display:inline-block;cursor:pointer}button.secondary,a.secondary{background:#1f2937}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}</style></head><body><section class="card"><h1>Sign in to Brain Control Plane</h1><p>Use an allowlisted Clerk account.</p><section id="current-account" class="hidden"><h2>Current Clerk account</h2><p class="muted">You are already signed in as <span id="account-email" class="mono">unknown account</span>.</p><p>If this account is not allowlisted, sign out and choose another account.</p><div class="row"><a class="button" href="${escapeHtml(redirectUrl)}">Continue to admin</a><button class="secondary" onclick="signOut()">Sign out / switch account</button></div></section><div id="sign-in"></div><p id="error" class="bad"></p></section><script type="application/json" id="config">${payload}</script><script async crossorigin="anonymous" src="${escapeHtml(clerkUiScript)}"></script><script async crossorigin="anonymous" data-clerk-publishable-key="${escapeHtml(config.clerkPublishableKey)}" src="${escapeHtml(clerkJsScript)}"></script><script>const c=JSON.parse(document.getElementById('config').textContent);function clerkEmail(user){const emails=user?.emailAddresses||[];const primary=emails.find(e=>e?.id===user?.primaryEmailAddressId)||emails[0]||user?.primaryEmailAddress;return primary?.emailAddress||user?.primaryEmailAddress?.emailAddress||''}async function signOut(){try{await Clerk.signOut({redirectUrl:location.href})}catch(e){document.getElementById('error').textContent=e?.message||String(e)}}async function mount(){for(let i=0;i<80&&(!window.Clerk||!window.__internal_ClerkUICtor);i++)await new Promise(r=>setTimeout(r,100));if(!window.Clerk||!window.__internal_ClerkUICtor){document.getElementById('error').textContent='Clerk sign-in UI did not load. Check browser blockers, then retry.';return}await Clerk.load({ui:{ClerkUI:window.__internal_ClerkUICtor}});if(Clerk.user){document.getElementById('account-email').textContent=clerkEmail(Clerk.user)||'unknown Clerk account';document.getElementById('current-account').classList.remove('hidden');return}Clerk.mountSignIn(document.getElementById('sign-in'),{forceRedirectUrl:c.redirectUrl,fallbackRedirectUrl:c.redirectUrl});}mount().catch(e=>document.getElementById('error').textContent=e.message||String(e));</script></body></html>`;
}

export function renderBrainAdminDeniedPage(config: BrainAdminServiceConfig, error: string, signInUrl: string, accountEmail = ""): string {
  const payload = jsonScriptPayload({ publishableKey: config.clerkPublishableKey, signInUrl });
  const clerkUiScript = clerkUiScriptUrl(config);
  const clerkJsScript = clerkJsScriptUrl(config);
  const identity = accountEmail ? `<p class="muted">Current Clerk account: <span class="mono">${escapeHtml(accountEmail)}</span></p>` : `<p class="muted">Current Clerk account could not be verified for this request.</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brain Control Plane denied</title><style>body{font:16px system-ui;margin:3rem;max-width:720px;background:#0f172a;color:#e5e7eb}.card{border:1px solid #334155;border-radius:16px;padding:24px;background:#111827}.bad{color:#f87171}.muted{color:#94a3b8}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}a,button{box-sizing:border-box;font:inherit;border-radius:10px;border:1px solid #475569;background:#2563eb;color:#e5e7eb;padding:10px;text-decoration:none;display:inline-block;cursor:pointer}button.secondary,a.secondary{background:#1f2937}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}</style></head><body><section class="card"><h1>Brain Control Plane access denied</h1><p class="bad">${escapeHtml(error)}</p>${identity}<p>Admin routes require Clerk auth and a non-empty server-side allowlist. Access fails closed; use the action below to switch accounts if this is the wrong Clerk session.</p><div class="row"><a href="${escapeHtml(signInUrl)}">Sign in or switch Clerk account</a><button class="secondary" onclick="signOut()">Sign out</button></div><p id="error" class="bad"></p></section><script type="application/json" id="config">${payload}</script><script async crossorigin="anonymous" src="${escapeHtml(clerkUiScript)}"></script><script async crossorigin="anonymous" data-clerk-publishable-key="${escapeHtml(config.clerkPublishableKey)}" src="${escapeHtml(clerkJsScript)}"></script><script>const c=JSON.parse(document.getElementById('config').textContent);async function signOut(){try{for(let i=0;i<80&&!window.Clerk;i++)await new Promise(r=>setTimeout(r,100));if(window.Clerk){await Clerk.load(window.__internal_ClerkUICtor?{ui:{ClerkUI:window.__internal_ClerkUICtor}}:undefined);await Clerk.signOut({redirectUrl:c.signInUrl});return}}catch(e){document.getElementById('error').textContent=e?.message||String(e)}location.assign(c.signInUrl)}</script></body></html>`;
}
