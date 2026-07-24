import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, ArrowUpRight, Check, CircleAlert, Database, Globe2, LockKeyhole, Plus, Radio, RotateCw, Save, Server, Trash2 } from "lucide-react";
import "./styles.css";

const empty = { mode: "doh", upstreams: [], customHosts: "", timeoutMs: 5000, maxBodyBytes: 65535, adBlockEnabled: false, adBlockSource: "", adBlockRefreshMs: 21600000, queryAliases: [] };
const emptyCache = { capacity: 0, entries: 0, hits: 0, misses: 0 };

function App() {
  const [config, setConfig] = useState(empty);
  const [key, setKey] = useState(localStorage.getItem("dashboard-key") || "");
  const [status, setStatus] = useState({ kind: "idle", message: "Connect to load runtime settings" });
  const [newUpstream, setNewUpstream] = useState("");
  const [newAlias, setNewAlias] = useState("");
  const [cache, setCache] = useState(emptyCache);

  async function load() {
    setStatus({ kind: "loading", message: "Reading edge configuration..." });
    try {
      const response = await fetch("/api/config", { headers: { "x-dashboard-key": key } });
      if (!response.ok) throw new Error((await response.json()).error || "Unable to load configuration");
      setConfig(await response.json());
      await loadCache();
      setStatus({ kind: "success", message: "Runtime configuration loaded" });
    } catch (error) { setStatus({ kind: "error", message: error.message }); }
  }

  async function loadCache() {
    const response = await fetch("/api/cache", { headers: { "x-dashboard-key": key } });
    if (!response.ok) throw new Error((await response.json()).error || "Unable to load cache status");
    setCache(await response.json());
  }

  async function purgeCache() {
    setStatus({ kind: "loading", message: "Purging upstream cache..." });
    try {
      const response = await fetch("/api/cache/purge", { method: "POST", headers: { "x-dashboard-key": key } });
      if (!response.ok) throw new Error((await response.json()).error || "Unable to purge cache");
      setCache(await response.json());
      setStatus({ kind: "success", message: "Upstream cache purged" });
    } catch (error) { setStatus({ kind: "error", message: error.message }); }
  }

  async function save() {
    setStatus({ kind: "loading", message: "Applying configuration..." });
    localStorage.setItem("dashboard-key", key);
    try {
      const response = await fetch("/api/config", { method: "PUT", headers: { "content-type": "application/json", "x-dashboard-key": key }, body: JSON.stringify(config) });
      if (!response.ok) throw new Error((await response.json()).error || "Unable to save configuration");
      setConfig(await response.json());
      setStatus({ kind: "success", message: "Applied to this Function instance" });
    } catch (error) { setStatus({ kind: "error", message: error.message }); }
  }

  useEffect(() => { if (key) load(); }, []);
  const set = (field, value) => setConfig((current) => ({ ...current, [field]: value }));

  return <main className="min-h-screen overflow-hidden bg-ink text-slate-100">
    <div className="glow glow-a" /><div className="glow glow-b" />
    <div className="mx-auto max-w-7xl px-5 py-6 sm:px-8 lg:px-12">
      <header className="flex flex-col gap-6 border-b border-white/10 pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div><div className="eyebrow"><span className="pulse" /> AZURE FUNCTION / DNS EDGE</div><h1>Resolver control room<span className="text-cyan">.</span></h1><p className="mt-3 max-w-xl text-sm leading-6 text-slate-400">Tune your encrypted DNS path, local fallback, and private host overrides from one small control surface.</p></div>
        <div className="flex items-center gap-3 text-xs text-slate-400"><span className="status-dot" /> Runtime dashboard <span className="text-slate-600">/</span> v1.0</div>
      </header>

      <section className="mt-8 grid gap-4 sm:grid-cols-3">
        <Metric icon={<Radio />} label="Query mode" value={config.mode.toUpperCase()} detail="Current resolver strategy" />
        <Metric icon={<Server />} label="Upstream pool" value={String(config.upstreams.length)} detail="Encrypted endpoints" />
        <Metric icon={<Database />} label="Cache entries" value={`${cache.entries}/${cache.capacity || "-"}`} detail="This Function worker" />
      </section>

      <div className="mt-8 grid gap-5 lg:grid-cols-[1.3fr_.7fr]">
        <section className="panel p-6 sm:p-8"><SectionTitle icon={<Globe2 />} title="Resolution strategy" kicker="01 / ROUTING" />
          <div className="mt-7 grid gap-3 md:grid-cols-3">{[["doh", "Encrypted only", "Use the upstream pool"], ["auto", "Resilient", "DoH, then local DNS"], ["local", "Local network", "Use runtime resolver"]].map(([value, title, detail]) => <button key={value} onClick={() => set("mode", value)} className={`mode-card ${config.mode === value ? "selected" : ""}`}><span className="mode-icon">{value === "doh" ? "↗" : value === "auto" ? "◈" : "⌁"}</span><strong>{title}</strong><small>{detail}</small></button>)}</div>
          <div className="mt-8 grid gap-5 sm:grid-cols-2"><Field label="Upstream timeout" suffix="ms"><input type="number" min="1" max="30000" value={config.timeoutMs} onChange={(e) => set("timeoutMs", Number(e.target.value))} /></Field><Field label="Maximum DNS packet" suffix="bytes"><input type="number" min="1" max="1048576" value={config.maxBodyBytes} onChange={(e) => set("maxBodyBytes", Number(e.target.value))} /></Field></div>
        </section>

        <section className="panel p-6 sm:p-8"><SectionTitle icon={<LockKeyhole />} title="Access key" kicker="02 / SECURITY" /><p className="mt-5 text-sm leading-6 text-slate-400">The key is sent as a header and kept in this browser only. Set <code>DASHBOARD_KEY</code> in Function App settings.</p><div className="mt-6"><input className="font-mono" type="password" placeholder="x-dashboard-key" value={key} onChange={(e) => setKey(e.target.value)} /></div><div className="mt-5 flex items-center gap-2 text-xs text-amber-300"><CircleAlert size={14} /> Runtime changes reset when the worker restarts.</div></section>
      </div>

       <section className="panel mt-5 p-6 sm:p-8"><SectionTitle icon={<Server />} title="Encrypted upstream pool" kicker="03 / ENDPOINTS" /><div className="mt-6 space-y-3">{config.upstreams.map((url, index) => <div className="endpoint" key={`${url}-${index}`}><span className="endpoint-index">0{index + 1}</span><input value={url} onChange={(e) => set("upstreams", config.upstreams.map((item, i) => i === index ? e.target.value : item))} /><button className="icon-button" onClick={() => set("upstreams", config.upstreams.filter((_, i) => i !== index))} aria-label="Remove upstream"><Trash2 size={16} /></button></div>)}</div><div className="mt-4 flex flex-col gap-3 sm:flex-row"><input placeholder="https://resolver.example/dns-query" value={newUpstream} onChange={(e) => setNewUpstream(e.target.value)} /><button className="button secondary" onClick={() => { if (newUpstream.trim()) { set("upstreams", [...config.upstreams, newUpstream.trim()]); setNewUpstream(""); } }}><Plus size={16} /> Add endpoint</button></div></section>

        <section className="panel mt-5 p-6 sm:p-8"><SectionTitle icon={<Database />} title="Upstream cache" kicker="04 / LRU MEMORY" /><div className="mt-6 grid gap-px overflow-hidden border border-white/10 bg-white/10 sm:grid-cols-3"><CacheMetric label="Entries" value={`${cache.entries} / ${cache.capacity || "-"}`} /><CacheMetric label="Cache hits" value={String(cache.hits)} /><CacheMetric label="Hit rate" value={cache.hits + cache.misses ? `${Math.round((cache.hits / (cache.hits + cache.misses)) * 100)}%` : "-"} /></div><div className="mt-5 flex flex-col gap-4 border-t border-white/10 pt-5 sm:flex-row sm:items-center sm:justify-between"><p className="max-w-xl text-xs leading-5 text-slate-400">Responses are retained per worker until their DNS TTL expires. Restarting or scaling the Function creates a separate empty cache.</p><div className="flex gap-3"><button className="button secondary" onClick={() => loadCache().catch((error) => setStatus({ kind: "error", message: error.message }))}><RotateCw size={16} /> Refresh</button><button className="button secondary" onClick={purgeCache}><Trash2 size={16} /> Purge cache</button></div></div></section>

       <section className="panel mt-5 p-6 sm:p-8"><SectionTitle icon={<Globe2 />} title="Query aliases" kicker="05 / PUBLIC PATHS" /><p className="mt-4 text-sm text-slate-400">Add public aliases for <code>/api/dns-query</code>. Use lowercase letters, numbers, and hyphens. Changes apply when you save.</p><div className="mt-6 space-y-3">{config.queryAliases.map((alias) => <div className="endpoint" key={alias}><span className="endpoint-index">/api</span><input className="font-mono" value={alias} readOnly /><button className="icon-button" onClick={() => set("queryAliases", config.queryAliases.filter((item) => item !== alias))} aria-label="Remove query alias"><Trash2 size={16} /></button></div>)}</div><div className="mt-4 flex flex-col gap-3 sm:flex-row"><input placeholder="resolver" value={newAlias} onChange={(e) => setNewAlias(e.target.value.toLowerCase())} /><button className="button secondary" onClick={() => { if (newAlias && !config.queryAliases.includes(newAlias)) { set("queryAliases", [...config.queryAliases, newAlias]); setNewAlias(""); } }}><Plus size={16} /> Add alias</button></div></section>

       <section className="panel mt-5 p-6 sm:p-8"><SectionTitle icon={<ArrowUpRight />} title="Custom hosts" kicker="06 / OVERRIDES" /><p className="mt-4 text-sm text-slate-400">One mapping per line. IPv4 and IPv6 are accepted. These entries win before local DNS.</p><textarea className="mt-5 min-h-40 font-mono text-sm leading-7" placeholder={'10.0.0.10 internal.example.com\n2001:db8::10 api.example.com'} value={config.customHosts} onChange={(e) => set("customHosts", e.target.value)} /></section>

       <section className="panel mt-5 p-6 sm:p-8"><SectionTitle icon={<CircleAlert />} title="Ad shield" kicker="07 / BLOCKLIST" /><div className="mt-5 flex items-center justify-between gap-5"><div><strong className="text-sm">Block advertising domains</strong><p className="mt-1 text-xs leading-5 text-slate-400">Fetches the selected hosts file and answers matching domains with NXDOMAIN.</p></div><button className={`toggle ${config.adBlockEnabled ? "on" : ""}`} onClick={() => set("adBlockEnabled", !config.adBlockEnabled)} aria-label="Toggle ad blocking"><span /></button></div><div className="mt-6 grid gap-5 sm:grid-cols-[1fr_180px]"><Field label="Hosts source" suffix="HTTPS"><input value={config.adBlockSource} onChange={(e) => set("adBlockSource", e.target.value)} /></Field><Field label="Refresh interval" suffix="ms"><input type="number" min="60000" max="604800000" value={config.adBlockRefreshMs} onChange={(e) => set("adBlockRefreshMs", Number(e.target.value))} /></Field></div><p className="mt-4 text-xs text-slate-500">Default source: rentianyu/Ad-set-hosts · no list is bundled locally.</p></section>

      <footer className="mt-6 flex flex-col gap-4 pb-8 sm:flex-row sm:items-center sm:justify-between"><div className={`notice ${status.kind}`}><span className="notice-icon">{status.kind === "success" ? <Check size={15} /> : status.kind === "error" ? <CircleAlert size={15} /> : <Activity size={15} />}</span>{status.message}</div><div className="flex gap-3"><button className="button secondary" onClick={load}><RotateCw size={16} /> Reload</button><button className="button primary" onClick={save}><Save size={16} /> Apply changes</button></div></footer>
    </div>
  </main>;
}

function Metric({ icon, label, value, detail }) { return <div className="metric"><span className="metric-icon">{icon}</span><div><div className="eyebrow">{label}</div><strong>{value}</strong><small>{detail}</small></div></div>; }
function CacheMetric({ label, value }) { return <div className="cache-metric"><span>{label}</span><strong>{value}</strong></div>; }
function SectionTitle({ icon, title, kicker }) { return <div className="flex items-start gap-3"><span className="section-icon">{icon}</span><div><div className="eyebrow">{kicker}</div><h2>{title}</h2></div></div>; }
function Field({ label, suffix, children }) { return <label className="field"><span>{label}</span><div className="relative">{children}<b>{suffix}</b></div></label>; }

createRoot(document.getElementById("root")).render(<App />);
