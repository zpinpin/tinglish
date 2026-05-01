"use client";

import React, { useState, useCallback, useRef } from "react";

// ─── CONFIG ────────────────────────────────────────────────────────────────────
// Worker handles SUBTITLES ONLY — search now runs client-side via CORS proxies.
// Deploy bilibili-worker-v2.js (or v5) to Cloudflare Workers, paste URL below.
const WORKER_URL = "https://snowy-forest-8ca6.kate-appel.workers.dev";

// ─── CONSTANTS ─────────────────────────────────────────────────────────────────
const FILTERS = [
  { key: "生活 日常", label: "日常生活", emoji: "🏠" },
  { key: "vlog", label: "Vlog", emoji: "📱" },
  { key: "聊天 口语", label: "口语聊天", emoji: "💬" },
  { key: "街访 采访", label: "街头采访", emoji: "🎤" },
  { key: "美食 探店", label: "美食探店", emoji: "🍜" },
];
const EXAMPLES = ["随便", "反正", "其实", "确实", "差不多", "无所谓", "怎么了", "没事"];

// Maximum verified hits to collect before stopping scan
const MAX_HITS = 30;
// Max videos to scan per search (to keep it snappy)
const MAX_SCAN = 20;

// ─── TYPES ─────────────────────────────────────────────────────────────────────
interface Video {
  bvid: string;
  title: string;
  author: string;
  duration: string;
  pic: string | null;
  play: number;
}

interface SubHit {
  from: number;
  to: number;
  content: string;
}

interface Hit extends Video {
  from: number;
  to?: number;
  content: string | null;
  verified: boolean;
  noSubtitles: boolean;
}

interface ValidateResult {
  hits: SubHit[];
  hasSubtitles: boolean;
}

interface ScanStats {
  scanned: number;
  verified: number;
  noSubs: number;
}

interface StatusState {
  type: "idle" | "loading" | "done" | "error" | "empty";
  msg: string;
}

// ─── HELPERS ───────────────────────────────────────────────────────────────────
const fmt = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function Highlight({ text, kw }: { text: string; kw: string }) {
  if (!kw || !text) return <span>{text}</span>;
  const re = new RegExp(`(${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  return (
    <span>
      {text.split(re).map((part, i) =>
        re.test(part) ? (
          <mark key={i} style={{
            background: "rgba(251,114,153,0.25)", color: "#b5274e",
            borderRadius: 3, padding: "0 2px", fontWeight: 700,
          }}>{part}</mark>
        ) : part
      )}
    </span>
  );
}

// ─── SEARCH via SearXNG ────────────────────────────────────────────────────────
// Bilibili's own API requires browser-computed fingerprints (wbi/412) that block
// every proxy and server approach. Instead we query public SearXNG instances,
// which are open metasearch engines with CORS-enabled JSON APIs that aggregate
// Bilibili results from many different IPs — no auth, no fingerprinting needed.
//
// We maintain a list of reliable public instances and race them; first valid
// response with Bilibili BVIDs wins.

const SEARXNG_INSTANCES = [
  "https://searx.be",
  "https://search.inetol.net",
  "https://searx.tiekoetter.com",
  "https://searxng.world",
  "https://search.ononoki.org",
];

const BVID_RE = /BV[a-zA-Z0-9]{10}/g;

async function queryInstance(base: string, q: string, signal: AbortSignal): Promise<Video[]> {
  // SearXNG JSON API: ?q=...&engines=bilibili&format=json
  // We also include general web in case bilibili engine isn't enabled,
  // then extract BVIDs from any URLs that appear in results.
  const url = `${base}/search?q=${encodeURIComponent(q)}&engines=bilibili&format=json&language=zh`;
  const res = await fetch(url, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${base}: ${res.status}`);
  const data = await res.json();

  const results = data.results || [];
  if (!results.length) throw new Error(`${base}: no results`);

  // Extract BVIDs and titles from results
  const seen = new Set();
  const videos = [];
  for (const r of results) {
    const bvids = [...(r.url || "").matchAll(BVID_RE), ...(r.content || "").matchAll(BVID_RE)];
    for (const m of bvids) {
      const bvid = m[0];
      if (!seen.has(bvid)) {
        seen.add(bvid);
        videos.push({
          bvid,
          title: r.title || bvid,
          author: r.metadata || "",
          duration: "",
          pic: r.thumbnail || null,
          play: 0,
        });
      }
    }
    if (videos.length >= 20) break;
  }

  if (!videos.length) throw new Error(`${base}: no BVIDs in results`);
  return videos;
}

async function apiSearch(kw: string, filter: string): Promise<Video[]> {
  const q = `site:bilibili.com ${kw} ${filter}`;
  const errors = [];

  // Try all instances with a short per-instance timeout; return first success
  const results = await Promise.any(
    SEARXNG_INSTANCES.map(async (base) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const videos = await queryInstance(base, q, ctrl.signal);
        clearTimeout(timer);
        return videos;
      } catch (e) {
        clearTimeout(timer); 
        const errorMessage = e instanceof Error ? e.message : String(e);
        errors.push(`${base}: ${errorMessage}`);
        throw e; 
      }
    })
  ).catch(() => null);

  if (results && results.length) return results;

  // Last resort: try without bilibili engine filter (broader web search)
  for (const base of SEARXNG_INSTANCES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const url = `${base}/search?q=${encodeURIComponent(`bilibili.com/video ${kw} ${filter}`)}&format=json`;
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      const seen = new Set();
      const videos = [];
      for (const r of (data.results || [])) {
        const matches = [...(r.url || "").matchAll(BVID_RE)];
        for (const m of matches) {
          if (!seen.has(m[0])) {
            seen.add(m[0]);
            videos.push({ bvid: m[0], title: r.title || m[0], author: "", duration: "", pic: null, play: 0 });
          }
        }
        if (videos.length >= 20) break;
      }
      if (videos.length) return videos;
    } catch (_) {}
  }

  throw new Error("搜索失败：所有 SearXNG 节点均无响应，请稍后重试");
}

// Returns { hits: [{from, to, content}], hasSubtitles }
async function apiValidate(bvid: string, kw: string): Promise<ValidateResult> {
  const r = await fetch(
    `${WORKER_URL}/validate?bvid=${encodeURIComponent(bvid)}&kw=${encodeURIComponent(kw)}`
  );
  if (!r.ok) return { hits: [], hasSubtitles: false };
  return r.json();
}

// ─── SUB-COMPONENTS ────────────────────────────────────────────────────────────

function Dots() {
  return (
    <span style={{ display: "inline-flex", gap: 3, alignItems: "center", marginLeft: 6 }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{
          width: 4, height: 4, borderRadius: "50%", background: "#FB7299", display: "inline-block",
          animation: `db 1.2s ${i * 0.2}s infinite ease-in-out`,
        }} />
      ))}
    </span>
  );
}

// The subtitle context panel below the player
function SubtitlePanel({ hit, allHits, instanceIdx, keyword, onPrevInstance, onNextInstance }: {
  hit: Hit;
  allHits: Hit[];
  instanceIdx?: number;
  keyword: string;
  onPrevInstance: () => void;
  onNextInstance: () => void;
}) {
  const verified = hit.verified;
  const sameVideoHits = allHits.filter(h => h.bvid === hit.bvid && h.verified);
  const videoInstanceTotal = sameVideoHits.length;
  // find position of current hit within same-video hits
  const videoInstancePos = sameVideoHits.findIndex(h => h.from === hit.from) + 1;

  return (
    <div style={{
      borderTop: verified ? "1px solid rgba(251,114,153,0.15)" : "1px solid rgba(0,0,0,0.07)",
      background: verified ? "rgba(251,114,153,0.04)" : "rgba(0,0,0,0.02)",
    }}>
      {/* Subtitle text */}
      <div style={{ padding: "12px 16px 10px", display: "flex", gap: 10, alignItems: "flex-start" }}>
        <svg width="16" height="16" viewBox="0 0 24 24" style={{ marginTop: 2, flexShrink: 0 }}>
          {[3,6,9,12,15,18,21].map((x, i) => {
            const h = [5,13,9,17,7,15,5][i];
            return <rect key={x} x={x-1} y={(24-h)/2} width={2} height={h} rx={1}
              fill={verified ? "#FB7299" : "#bbb"} opacity={0.6+i*0.05} />;
          })}
        </svg>
        <div style={{ flex: 1, minWidth: 0 }}>
          {verified ? (
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.7, color: "#111" }}>
               <Highlight text={hit.content ?? ""} kw={keyword} />
            </p>
          ) : (
            <p style={{ margin: 0, fontSize: 13, color: "#aaa", fontStyle: "italic" }}>
              {hit.noSubtitles
                ? "此视频无 CC 字幕 — 未经验证"
                : "字幕中未找到关键词 — 未经验证"}
            </p>
          )}
        </div>
        {verified && (
          <span style={{
            fontSize: 11, color: "#FB7299", background: "rgba(251,114,153,0.1)",
            borderRadius: 8, padding: "2px 8px", whiteSpace: "nowrap", flexShrink: 0, marginTop: 3,
          }}>
            {fmt(hit.from)}
          </span>
        )}
        {!verified && (
          <span style={{
            fontSize: 10, color: "#bbb", background: "rgba(0,0,0,0.05)",
            borderRadius: 6, padding: "2px 7px", whiteSpace: "nowrap", flexShrink: 0, marginTop: 3,
          }}>
            未验证
          </span>
        )}
      </div>

      {/* In-video instance navigation (only when ≥2 hits in same video) */}
      {verified && videoInstanceTotal > 1 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "6px 16px 10px", borderTop: "0.5px solid rgba(251,114,153,0.12)",
        }}>
          <span style={{ fontSize: 11, color: "#aaa", marginRight: 2 }}>
            本视频第 {videoInstancePos} / {videoInstanceTotal} 处
          </span>
          <div style={{ flex: 1 }} />
          <button
            onClick={onPrevInstance}
            disabled={videoInstancePos <= 1}
            style={inVideoBtn(videoInstancePos <= 1)}
          >
            ↑ 上一处
          </button>
          <button
            onClick={onNextInstance}
            disabled={videoInstancePos >= videoInstanceTotal}
            style={inVideoBtn(videoInstancePos >= videoInstanceTotal)}
          >
            跳到下一处 ↓
          </button>
        </div>
      )}
    </div>
  );
}

const inVideoBtn = (disabled: boolean): React.CSSProperties => ({
  height: 26, padding: "0 10px", fontSize: 11,
  border: "1px solid rgba(251,114,153,0.35)", borderRadius: 6,
  background: disabled ? "transparent" : "rgba(251,114,153,0.08)",
  color: disabled ? "#ccc" : "#e05a80",
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.45 : 1, transition: "all 0.12s",
});

// Main player card
function PlayerCard({ hit, allHits, globalIdx, globalTotal, keyword, onPrev, onNext, onJumpInstance }: {
  hit: Hit;
  allHits: Hit[];
  globalIdx: number;
  globalTotal: number;
  keyword: string;
  onPrev: () => void;
  onNext: () => void;
  onJumpInstance: (h: Hit) => void;
}) {
  const src = `https://player.bilibili.com/player.html?bvid=${hit.bvid}&autoplay=1&t=${Math.floor(hit.from)}&high_quality=1&danmaku=0`;

  const sameVideoHits = allHits.filter(h => h.bvid === hit.bvid && h.verified);
  const curSVIdx = sameVideoHits.findIndex(h => h.from === hit.from);

  const handlePrevInstance = () => {
    if (curSVIdx > 0) onJumpInstance(sameVideoHits[curSVIdx - 1]);
  };
  const handleNextInstance = () => {
    if (curSVIdx < sameVideoHits.length - 1) onJumpInstance(sameVideoHits[curSVIdx + 1]);
  };

  return (
    <div style={{
      background: "#fff", border: "1px solid rgba(251,114,153,0.18)",
      borderRadius: 16, overflow: "hidden",
      boxShadow: "0 2px 20px rgba(251,114,153,0.07)",
      animation: "slideIn 0.22s ease",
    }}>
      {/* Verified badge row */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "7px 14px 6px",
        background: hit.verified ? "rgba(251,114,153,0.05)" : "rgba(0,0,0,0.025)",
        borderBottom: "0.5px solid rgba(0,0,0,0.06)",
      }}>
        <span style={{
          fontSize: 11, fontWeight: 600, letterSpacing: 0.3,
          color: hit.verified ? "#d44070" : "#aaa",
          display: "flex", alignItems: "center", gap: 5,
        }}>
          {hit.verified ? (
            <><svg width="12" height="12" viewBox="0 0 24 24"><path d="M9 12l2 2 4-4" stroke="#d44070" strokeWidth="2.5" fill="none" strokeLinecap="round"/><circle cx="12" cy="12" r="10" stroke="#d44070" strokeWidth="1.5" fill="none"/></svg>字幕已验证</>
          ) : (
            <><svg width="12" height="12" viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01" stroke="#bbb" strokeWidth="2" strokeLinecap="round"/><circle cx="12" cy="12" r="10" stroke="#bbb" strokeWidth="1.5" fill="none"/></svg>未经字幕验证</>
          )}
        </span>
        <span style={{ fontSize: 11, color: "#ccc" }}>{globalIdx + 1} / {globalTotal}</span>
      </div>

      {/* iframe */}
      <div style={{ position: "relative", paddingBottom: "56.25%", background: "#090909" }}>
        <iframe
          key={`${hit.bvid}-${hit.from}`}
          src={src}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }}
          allowFullScreen
          allow="autoplay; fullscreen; picture-in-picture"
          sandbox="allow-scripts allow-same-origin allow-popups allow-presentation allow-top-navigation"
        />
      </div>

      {/* Subtitle / context panel */}
      <SubtitlePanel
        hit={hit} allHits={allHits} keyword={keyword}
        onPrevInstance={handlePrevInstance}
        onNextInstance={handleNextInstance}
      />

      {/* Video meta + global nav */}
      <div style={{ padding: "10px 16px 14px" }}>
        <p style={{
          margin: "0 0 2px", fontSize: 13, fontWeight: 600, color: "#1a1a1a",
          lineHeight: 1.4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }} title={hit.title}>{hit.title}</p>
        <p style={{ margin: "0 0 12px", fontSize: 11, color: "#aaa" }}>UP: {hit.author}</p>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <NavBtn onClick={onPrev} disabled={globalIdx === 0} label="← 上一个" />
          <div style={{ flex: 1, textAlign: "center" }}>
            <span style={{ fontSize: 11, color: "#ccc" }}>片段 {globalIdx + 1} / {globalTotal}</span>
          </div>
          <NavBtn onClick={onNext} disabled={globalIdx >= globalTotal - 1} label="下一个 →" />
        </div>
      </div>
    </div>
  );
}

const NavBtn = ({ onClick, disabled, label }: { onClick: () => void; disabled: boolean; label: string }) => (
  <button onClick={onClick} disabled={disabled} style={{
    height: 32, padding: "0 14px", fontSize: 12,
    border: "0.5px solid rgba(0,0,0,0.18)", borderRadius: 8,
    background: "#fff", color: disabled ? "#ccc" : "#333",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1, transition: "opacity 0.12s",
  }}>{label}</button>
);

// ─── MAIN APP ──────────────────────────────────────────────────────────────────
export default function Page() {
  const [query, setQuery]           = useState<string>("");
  const [filter, setFilter]         = useState<string>("生活 日常");
  const [status, setStatus]         = useState<StatusState>({ type: "idle", msg: "" });
  const [hits, setHits]             = useState<Hit[]>([]);   // verified + unverified segments
  const [globalIdx, setGlobalIdx]   = useState<number>(0);
  const [scanStats, setScanStats]   = useState<ScanStats | null>(null); // { scanned, verified, noSubs }
  const abortRef                    = useRef<AbortController | null>(null);

  const isConfigured = !WORKER_URL.includes("YOUR-WORKER");

  // ── core search + validate pipeline ────────────────────────────────────────
  const runSearch = useCallback(async (kw: string, fltr: string) => {
    if (!kw.trim()) return;
    if (!isConfigured) {
      setStatus({ type: "error", msg: "⚠️ 请先配置 Cloudflare Worker URL（见代码顶部）" });
      return;
    }

    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setHits([]); setGlobalIdx(0); setScanStats(null);
    setStatus({ type: "loading", msg: "正在搜索 Bilibili（直连）…" });

    try {
      const videos = await apiSearch(kw, fltr);
      if (!videos.length) { setStatus({ type: "empty", msg: "没有找到相关视频，换个词试试" }); return; }

      setStatus({ type: "loading", msg: `找到 ${videos.length} 个视频，正在逐一验证字幕…` });

      const collected: Hit[] = [];
      let scanned = 0, verified = 0, noSubs = 0;

      for (const v of videos.slice(0, MAX_SCAN)) {
        if (ctrl.signal.aborted) break;
        scanned++;

        setStatus({ type: "loading", msg: `扫描中 ${scanned}/${Math.min(videos.length, MAX_SCAN)} — 已验证 ${verified} 处` });

        const { hits: vHits, hasSubtitles } = await apiValidate(v.bvid, kw);

        if (!hasSubtitles) {
          noSubs++;
          // Include as unverified fallback (only first time seeing this video)
          if (!collected.find(c => c.bvid === v.bvid)) {
            collected.push({ ...v, from: 0, content: null, verified: false, noSubtitles: true });
          }
        } else if (vHits.length > 0) {
          verified += vHits.length;
          for (const h of vHits) {
            collected.push({ ...v, ...h, verified: true, noSubtitles: false });
          }
        }
        // if has subs but no hit — silently skip (keyword not spoken)

        setScanStats({ scanned, verified, noSubs });
        if (collected.some(c => c.verified)) setHits([...collected]);
        if (verified >= MAX_HITS) break;
      }

      // Final state
      const verifiedHits = collected.filter(c => c.verified);
      if (verifiedHits.length === 0 && collected.length === 0) {
        setStatus({ type: "empty", msg: `在 ${scanned} 个视频的字幕中未找到「${kw}」` });
      } else {
        // Sort: verified first, then unverified
        const sorted = [...collected.filter(c => c.verified), ...collected.filter(c => !c.verified)];
        setHits(sorted);
        setStatus({
          type: "done",
          msg: verifiedHits.length > 0
            ? `「${kw}」共 ${verifiedHits.length} 处字幕验证命中`
            : `未找到字幕命中，展示 ${collected.length} 个相关视频`,
        });
      }
    } catch (e) {
      if (!ctrl.signal.aborted) {
        // Check if it's a real Error object to access .message
        const errorMessage = e instanceof Error ? e.message : "未知错误";
        setStatus({ type: "error", msg: `出错：${errorMessage}` });
      }
    }
  }, [isConfigured]);

  const go = () => runSearch(query, filter);
  const example = (w: string) => { setQuery(w); runSearch(w, filter); };

  const current = hits[globalIdx];

  // Jump to a specific hit (for in-video instance nav)
  const jumpToHit = (targetHit: Hit) => {
    const idx = hits.findIndex(h => h.bvid === targetHit.bvid && h.from === targetHit.from);
    if (idx !== -1) setGlobalIdx(idx);
  };

  const statusColor: Record<string, string> = { idle:"#bbb", loading:"#FB7299", done:"#1da462", error:"#e53935", empty:"#999" };
  const currentStatusColor = statusColor[status.type] || "#bbb";

  return (
    <div style={{
      fontFamily: "'Noto Sans SC','PingFang SC','Hiragino Sans GB',sans-serif",
      maxWidth: 680, margin: "0 auto", padding: "20px 0 36px", color: "#1a1a1a",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap');
        @keyframes db { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-4px)} }
        @keyframes slideIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
        .si:focus { outline:none; border-color:#FB7299 !important; box-shadow:0 0 0 3px rgba(251,114,153,0.14) !important; }
        .fc:hover { border-color:#FB7299 !important; color:#FB7299 !important; background:rgba(251,114,153,0.06) !important; }
        .ec:hover { background:rgba(251,114,153,0.1) !important; color:#e05a80 !important; }
        .sb:not(:disabled):hover { background:#e0456e !important; }
        .sb:not(:disabled):active { transform:scale(0.97); }
      `}</style>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 22 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:5 }}>
          <div style={{
            width:34, height:34, borderRadius:10, flexShrink:0,
            background:"linear-gradient(135deg,#FB7299,#f04c7f)",
            display:"flex", alignItems:"center", justifyContent:"center",
          }}>
            <span style={{ fontSize:17 }}>🎬</span>
          </div>
          <h1 style={{ margin:0, fontSize:20, fontWeight:700, letterSpacing:-0.3 }}>哔哩听说</h1>
          <span style={{
            marginLeft:"auto", fontSize:11, fontWeight:500, padding:"3px 9px", borderRadius:20,
            color: isConfigured ? "#1da462" : "#e53935",
            background: isConfigured ? "rgba(29,164,98,0.08)" : "rgba(229,57,53,0.08)",
          }}>
            {isConfigured ? "● Worker 已连接" : "● 请配置 Worker"}
          </span>
        </div>
        <p style={{ margin:0, fontSize:12, color:"#aaa", paddingLeft:44 }}>
          搜索直连 Bilibili · 字幕验证 · 精准跳转 · 真实普通话
        </p>
      </div>

      {/* ── Search bar ─────────────────────────────────────────────────────── */}
      <div style={{ display:"flex", gap:8, marginBottom:10 }}>
        <input
          className="si"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === "Enter" && go()}
          placeholder="输入汉字或词语，例如：随便、其实、差不多…"
          style={{
            flex:1, height:42, padding:"0 14px", fontSize:15,
            border:"1.5px solid rgba(0,0,0,0.11)", borderRadius:10,
            background:"#fff", color:"#1a1a1a", transition:"border-color 0.15s,box-shadow 0.15s",
          }}
        />
        <button
          className="sb"
          onClick={go}
          disabled={status.type === "loading" || !query.trim()}
          style={{
            height:42, padding:"0 20px", fontSize:14, fontWeight:700,
            background:"#FB7299", color:"#fff", border:"none", borderRadius:10,
            cursor: status.type === "loading" || !query.trim() ? "not-allowed" : "pointer",
            opacity: status.type === "loading" || !query.trim() ? 0.55 : 1,
            transition:"background 0.13s,transform 0.1s", whiteSpace:"nowrap",
          }}
        >
          搜索
        </button>
      </div>

      {/* ── Filter chips ───────────────────────────────────────────────────── */}
      <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:12 }}>
        {FILTERS.map(f => (
          <button
            key={f.key} className="fc"
            onClick={() => setFilter(f.key)}
            style={{
              height:27, padding:"0 10px", fontSize:12, cursor:"pointer",
              border:`1px solid ${filter===f.key ? "#FB7299" : "rgba(0,0,0,0.11)"}`,
              borderRadius:14, transition:"all 0.13s",
              background: filter===f.key ? "rgba(251,114,153,0.09)" : "#fff",
              color: filter===f.key ? "#FB7299" : "#666",
              fontWeight: filter===f.key ? 600 : 400,
              display:"flex", alignItems:"center", gap:4,
            }}
          >
            <span style={{ fontSize:12 }}>{f.emoji}</span>{f.label}
          </button>
        ))}
      </div>

      {/* ── Status ─────────────────────────────────────────────────────────── */}
      <div style={{ minHeight:20, marginBottom:12, display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
        <span style={{ fontSize:13, color:currentStatusColor }}>
          {status.type === "loading" ? <>{status.msg}<Dots /></> : status.msg}
        </span>
        {scanStats && status.type === "done" && (
          <span style={{ fontSize:11, color:"#ccc", marginLeft:4 }}>
            （扫描 {scanStats.scanned} 个视频 · {scanStats.noSubs} 个无字幕被跳过）
          </span>
        )}
      </div>

      {/* ── Player ─────────────────────────────────────────────────────────── */}
      {current && (
        <PlayerCard
          hit={current}
          allHits={hits}
          globalIdx={globalIdx}
          globalTotal={hits.length}
          keyword={query}
          onPrev={() => setGlobalIdx(i => Math.max(0, i - 1))}
          onNext={() => setGlobalIdx(i => Math.min(hits.length - 1, i + 1))}
          onJumpInstance={jumpToHit}
        />
      )}

      {/* ── Empty / idle ───────────────────────────────────────────────────── */}
      {!current && status.type !== "loading" && (
        <div style={{ textAlign:"center", padding:"36px 0 20px" }}>
          <div style={{ fontSize:42, marginBottom:14 }}>🎙️</div>
          <p style={{ fontSize:14, color:"#bbb", marginBottom:22 }}>
            {status.type === "idle" ? "搜索一个词，我们帮你找到它在真实对话中的用法" : "换个词语再试试"}
          </p>
          <p style={{ fontSize:11, color:"#ddd", marginBottom:10 }}>例如</p>
          <div style={{ display:"flex", gap:7, flexWrap:"wrap", justifyContent:"center" }}>
            {EXAMPLES.map(w => (
              <button key={w} className="ec" onClick={() => example(w)} style={{
                height:32, padding:"0 14px", fontSize:14,
                border:"1px solid rgba(0,0,0,0.09)", borderRadius:16,
                background:"#fafafa", color:"#666", cursor:"pointer",
                transition:"all 0.13s", fontFamily:"inherit",
              }}>{w}</button>
            ))}
          </div>
        </div>
      )}

      {/* ── Worker setup notice ────────────────────────────────────────────── */}
      {!isConfigured && (
        <div style={{
          marginTop:28, padding:"14px 16px",
          background:"rgba(229,57,53,0.04)", border:"1px solid rgba(229,57,53,0.18)",
          borderRadius:10, fontSize:13, color:"#c62828", lineHeight:1.75,
        }}>
          <strong>🔧 部署步骤</strong>
          <ol style={{ margin:"8px 0 0 18px", padding:0 }}>
            <li>前往 <strong>dash.cloudflare.com</strong> → Workers &amp; Pages → Create Worker</li>
            <li>将 <code>bilibili-worker-v2.js</code> 全部内容粘贴进编辑器，点击 Save &amp; Deploy</li>
            <li>复制 Worker URL（形如 <code>https://xxx.workers.dev</code>）</li>
            <li>将该 URL 粘贴到本文件顶部 <code>WORKER_URL</code> 常量</li>
          </ol>
        </div>
      )}
    </div>
  );
}
