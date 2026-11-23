// app.js  画面の表示とNFCの読み取り。記録の読み解きと判定は stake.js
import { DAY, TH, gainX, parseTag, newStake, addRead, hourlyRecords, darkRecords, ratio,
         timeModel, dailySeries, analyze } from "./stake.js";

const $ = id => document.getElementById(id);

// ---- このスマホのChromeの中に保存する ----
const KEY = "mstake.v1";
let db = { stakes: {} };
try { db = JSON.parse(localStorage.getItem(KEY)) || db; } catch (e) { /* 保存できない環境では記憶しない */ }
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { show("このスマホに記録を保存できませんでした。空き容量を確認してください。", "err"); }
}
// 最後に読み取った杭を開いておく
let current = Object.keys(db.stakes).sort((a, b) => db.stakes[b].reads.at(-1) - db.stakes[a].reads.at(-1))[0] ?? null;

// ---- 書式 ----
const fmtTime = t => new Date(t).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtDay = t => new Date(t).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
const fmtSlope = v => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(3) + "/日";
const stageClass = level => level >= TH.open ? "open" : level >= TH.heavy ? "light" : "heavy";

function show(text, cls = "") { $("msg").textContent = text; $("msg").className = "banner " + cls; }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// 1本の杭の記録から、画面に出すものをまとめて求める
function view(s) {
  const time = timeModel(s);
  const daily = dailySeries(s, time);
  const k = s.k || 1;
  const A = analyze(daily.map(d => ({ t: d.t, rfr: d.rfr === null ? null : d.rfr * k, bright: d.bright })));
  return { time, daily, k, A };
}

// ---- 杭の一覧(2本以上読んだときだけ出す) ----
function renderList() {
  const list = $("stakes"), ids = Object.keys(db.stakes);
  list.hidden = ids.length < 2;
  list.replaceChildren();
  ids.sort((a, b) => db.stakes[b].reads.at(-1) - db.stakes[a].reads.at(-1));
  for (const id of ids) {
    const s = db.stakes[id], st = view(s).A.state;
    const item = el("div", "item" + (id === current ? " sel" : ""));
    const mark = el("div", "mark");
    if (!st.hold) mark.style.background = `var(--${stageClass(st.level)})`;
    const text = el("div");
    text.append(el("div", "", s.name), el("div", "t2", `${st.hold ? "判定保留" : st.stage}　${fmtTime(s.reads.at(-1))} 読み取り`));
    item.append(mark, text);
    item.onclick = () => { current = id; render(); };
    list.append(item);
  }
}

// ---- 1本の杭 ----
function renderDetail() {
  const s = current && db.stakes[current];
  $("detail").hidden = !s;
  if (!s) return;
  const v = view(s);
  $("name").textContent = s.name;
  $("last-read").textContent = `${fmtTime(s.reads.at(-1))} 読み取り`;
  renderState(v.A.state);
  renderDaily(v.A);
  renderEvents(v.A.events);
  renderCheck(s, v);
  $("f-name").value = s.name;
  $("f-k").value = v.k.toFixed(2);
  $("settings-title").textContent = `名前と補正係数（k ${v.k.toFixed(2)}）`;
}

function renderState(st) {
  const basis = $("basis");
  basis.replaceChildren();
  if (st.hold) {
    $("state").className = "state";
    $("stage").textContent = "判定保留";
    basis.append(el("li", "", `直近10日の晴天日 ${st.nClear}日（判定には3日必要）`));
    return;
  }
  $("state").className = "state " + stageClass(st.level);
  $("stage").textContent = st.stage;
  basis.append(el("li", "", `R:FR ${st.level.toFixed(2)}（${fmtDay(st.from)}〜${fmtDay(st.to)}の晴天日3日の中央値）`));
  if (st.level < TH.open) basis.append(el("li", "", st.belowDays === null ? "記録の始めから0.9未満" : `0.9未満の継続 ${st.belowDays}日`));
  basis.append(el("li", "", st.slope === null ? "傾き 算出不可（直近7日の晴天日が4日未満）" : `傾き ${fmtSlope(st.slope)}（直近7日の晴天日${st.slopeN}日）`));
}

function renderEvents(events) {
  const box = $("events");
  box.replaceChildren();
  $("events-title").textContent = `検出した変化 ${events.length}件`;
  if (!events.length) { box.append(el("p", "empty", "検出した変化はありません。")); return; }
  for (const e of [...events].reverse()) {
    const row = el("div", "ev");
    const body = el("div");
    if (e.kind === "step") {
      row.append(el("div", "d", fmtDay(e.t)));
      body.append(el("span", "k", e.type), `　R:FR ${e.from.toFixed(2)} → ${e.to.toFixed(2)}`);
    } else {
      row.append(el("div", "d", `${fmtDay(e.t)}〜${fmtDay(e.t1)}`));
      body.append(el("span", "k", e.type), `　${fmtSlope(e.slope)}`,
                  el("div", "note", e.type === "漸増" ? "食害・落葉の可能性" : "下草の繁茂または樹冠閉鎖"));
    }
    row.append(body);
    box.append(row);
  }
}

// ---- 杭の点検 ----
function renderCheck(s, v) {
  const hourly = hourlyRecords(s);
  const breaks = v.daily.filter(d => d.brk);
  const fails = hourly.filter(r => r.fail).length;
  const temps = v.daily.filter(d => d.tMax !== null);
  const hot = temps.reduce((m, d) => (!m || d.tMax > m.tMax ? d : m), null);
  const cold = temps.reduce((m, d) => (!m || d.tMin < m.tMin ? d : m), null);

  const issues = [];
  if (breaks.length) issues.push(`電源断 ${breaks.length}回`);
  if (fails) issues.push(`測定失敗 ${fails}件`);
  $("check-title").textContent = "杭の点検　" + (issues.length ? issues.join("・") : "電源断・測定失敗なし");

  const rows = [
    ["杭の番号", current],
    ["読み取り", `${fmtTime(s.reads.at(-1))}（通算${s.reads.length}回）`],
    ["日別の記録", v.daily.length ? `${fmtDay(v.daily[0].t)}〜${fmtDay(v.daily.at(-1).t)}（${v.daily.length}日分）` : "なし"],
    ["記録間隔", `${s.interval}分` + (s.battery ? `（電池運用、時刻の誤差 ±${s.interval / 2}分）` : "")],
    ["電源断", breaks.length ? breaks.map(d => fmtDay(d.t)).join("、") + "（それより前の時刻は推定）" : "なし"],
  ];
  if (fails) rows.push(["測定失敗", `${fails}件`]);
  if (hot) rows.push(["基板温度", `最高 ${hot.tMax}℃ ${fmtDay(hot.t)}・最低 ${cold.tMin}℃ ${fmtDay(cold.t)}`]);
  const dl = $("meta");
  dl.replaceChildren();
  for (const [a, b] of rows) dl.append(el("dt", "", a), el("dd", "", b));
  renderHourly(s, v);
}

// ---- グラフ ----
// 実際の表示幅で描き直すので、文字が伸び縮みしない
const charts = new Map();
const resizer = new ResizeObserver(entries => { for (const e of entries) charts.get(e.target)?.(); });
function chart(id, draw) {
  const fig = $(id), svg = fig.querySelector("svg");
  const paint = () => { const W = fig.clientWidth, H = fig.clientHeight; if (W > 0) svg.innerHTML = draw(W, H); };
  if (!charts.has(fig)) resizer.observe(fig);
  charts.set(fig, paint);
  paint();
}

function dateTicks(t0, t1, X, W, y) {
  const n = Math.max(2, Math.floor(W / 72)), out = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + (t1 - t0) * i / (n - 1);
    out.push(`<text x="${X(t)}" y="${y}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${fmtDay(t)}</text>`);
  }
  return out.join("");
}

function renderDaily(A) {
  const pts = A.pts;
  $("daily-title").textContent = pts.length ? `R:FR　${fmtDay(pts[0].t)}〜${fmtDay(pts.at(-1).t)}` : "R:FR";
  chart("daily", (W, H) => {
    if (!pts.length) return `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">日中の記録がまだありません</text>`;
    const L = 30, R = W - 6, T = 22, B = H - 20;
    const t0 = pts[0].t, t1 = Math.max(pts.at(-1).t, t0 + DAY);
    const vmax = Math.max(1.3, ...pts.map(p => p.rfr)) * 1.05;
    const X = t => L + (t - t0) / (t1 - t0) * (R - L), Y = v => B - v / vmax * (B - T);
    let s = "";
    // 段階の帯
    s += `<rect x="${L}" y="${T}" width="${R - L}" height="${Y(TH.open) - T}" fill="var(--open-band)"/>`;
    s += `<rect x="${L}" y="${Y(TH.open)}" width="${R - L}" height="${Y(TH.heavy) - Y(TH.open)}" fill="var(--light-band)"/>`;
    s += `<rect x="${L}" y="${Y(TH.heavy)}" width="${R - L}" height="${B - Y(TH.heavy)}" fill="var(--heavy-band)"/>`;
    s += [0, TH.heavy, TH.open].map(v => `<text x="${L - 4}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`).join("");
    // 漸増・漸減の期間
    for (const e of A.events.filter(e => e.kind === "trend"))
      s += `<rect x="${X(e.t)}" y="${T + 2}" width="${Math.max(3, X(e.t1) - X(e.t))}" height="4" rx="2" fill="var(--trend)"/>`;
    // 日別の値
    s += `<polyline fill="none" stroke="var(--primary)" stroke-opacity=".45" stroke-width="1.5" points="${pts.map(p => `${X(p.t)},${Y(p.rfr)}`).join(" ")}"/>`;
    s += pts.map(p => p.clear
      ? `<circle cx="${X(p.t)}" cy="${Y(p.rfr)}" r="3.5" fill="var(--primary)"/>`
      : `<circle cx="${X(p.t)}" cy="${Y(p.rfr)}" r="3" fill="#fff" stroke="var(--primary)" stroke-width="1.5"/>`).join("");
    // 下刈り・急増・急減
    for (const e of A.events.filter(e => e.kind === "step")) {
      const x = X(e.t), right = x > R - 48;
      s += `<line x1="${x}" x2="${x}" y1="${T}" y2="${B}" stroke="var(--error)" stroke-width="1.5" stroke-dasharray="4 3"/>`;
      s += `<text x="${right ? x - 4 : x + 4}" y="${T - 8}" text-anchor="${right ? "end" : "start"}" style="fill:var(--error)">${e.type}</text>`;
    }
    return s + dateTicks(t0, t1, X, R - L, H - 4);
  });
}

function renderHourly(s, v) {
  const recs = hourlyRecords(s);
  const lastSeq = Math.max(-1, ...recs.map(r => r.seq), ...darkRecords(s).map(d => d.seq + d.len - 1));
  const recent = recs.filter(r => r.seq > lastSeq - 72).map(r => ({ ...r, t: v.time(r.seq) })).filter(r => r.t !== null);
  chart("hourly", (W, H) => {
    if (!recent.length) return `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">記録がありません</text>`;
    const L = 30, R = W - 6, T = 6, B = H - 20;
    const t0 = recent[0].t - 1800000, t1 = recent.at(-1).t + 1800000;
    const X = t => L + (t - t0) / (t1 - t0) * (R - L);
    const bright = r => r.fail ? 0 : Math.log10(1 + r.all / gainX(r.g));
    const bmax = Math.max(1, ...recent.map(bright));
    const rs = recent.map(r => ratio(r)).filter(x => x !== null).map(x => x * v.k);
    const vmax = Math.max(1.5, ...rs), Y = x => B - x / vmax * (B - T);
    const bw = Math.max(1, (R - L) / 72 - 1);
    let out = recent.map(r => { const h = bright(r) / bmax * (B - T); return `<rect x="${X(r.t) - bw / 2}" y="${B - h}" width="${bw}" height="${h}" fill="var(--secondary-container)"/>`; }).join("");
    out += [0.5, 1].map(x => `<line x1="${L}" x2="${R}" y1="${Y(x)}" y2="${Y(x)}" stroke="var(--outline-variant)"/><text x="${L - 4}" y="${Y(x) + 4}" text-anchor="end">${x}</text>`).join("");
    // 夜の間(記録の番号が飛んだところ)では線を切る
    let d = "", prevSeq = -2;
    for (const r of recent) {
      const x = ratio(r);
      if (x === null) continue;
      d += `${r.seq === prevSeq + 1 ? "L" : "M"}${X(r.t)},${Y(x * v.k)} `;
      prevSeq = r.seq;
    }
    out += `<path d="${d}" fill="none" stroke="var(--primary)" stroke-width="2"/>`;
    for (let t = new Date(t0).setHours(24, 0, 0, 0); t < t1; t += DAY)
      out += `<line x1="${X(t)}" x2="${X(t)}" y1="${T}" y2="${B}" stroke="var(--outline)" stroke-dasharray="3 3"/><text x="${X(t) + 3}" y="${H - 4}">${fmtDay(t)}</text>`;
    return out;
  });
}

function render() { renderList(); renderDetail(); }

// ---- 読み取り ----
let reader = null;   // 一度始めた読み取りは、ページを開いている間ずっと受け付ける
const WAIT = "スマホの背面を杭のタグに当ててください。震えてから表示まで1〜2秒かかるので、そのまま当てたままにしてください。";

function receive(id, p) {
  if (!db.stakes[id]) db.stakes[id] = newStake(id);
  const restarted = addRead(db.stakes[id], p, Date.now());
  save();
  current = id;
  render();
  return restarted;
}

$("scan").onclick = async () => {
  if (!("NDEFReader" in window)) { show("このブラウザではNFCを使えません。Android版のChromeで開いてください。", "err"); return; }
  if (reader) { show(WAIT, "wait"); return; }
  try {
    reader = new NDEFReader();
    await reader.scan();
    reader.onreading = e => {
      const rec = e.message.records.find(r => r.mediaType === "application/x-mstake");
      if (!rec) { show("このタグには杭の記録がありません。", "err"); return; }
      try {
        const restarted = receive(e.serialNumber || "番号不明", parseTag(rec.data));
        const name = db.stakes[current].name;
        show(`読み取り完了 ${new Date().toLocaleTimeString("ja-JP")}　${name}` + (db.stakes[current].demo ? "（試験用データ）" : "") +
             (restarted ? "　杭の記録が消去されていたため、このスマホの記録も新しく始めました。" : "　続けて別の杭も読めます。"), "ok");
        navigator.vibrate?.([60, 80, 60]);
      } catch (err) { show(err.message, "err"); }
    };
    reader.onreadingerror = () => show("読み取りに失敗しました。当てたまま2秒ほど動かさないでください。", "err");
    show(WAIT, "wait");
  } catch (err) {
    reader = null;
    show(`読み取りを開始できませんでした（${err.message}）。`, "err");
  }
};

// ---- 名前と補正係数 ----
$("b-save").onclick = () => {
  const s = db.stakes[current];
  const k = parseFloat($("f-k").value);
  s.name = $("f-name").value.trim() || s.name;
  if (k > 0 && k < 5) s.k = k;
  save(); render();
  show("保存しました。", "ok");
};

$("b-csv").onclick = () => {
  const s = db.stakes[current], time = timeModel(s), k = s.k || 1;
  const lines = ["時刻（推定）,R:FR（補正後）,赤,遠赤,全体,ゲイン,基板温度,電源断,区分"];
  for (const r of [...hourlyRecords(s), ...darkRecords(s)].sort((a, b) => a.seq - b.seq)) {
    const t = time(r.seq), when = t === null ? "" : new Date(t).toISOString();
    if (r.dark) lines.push(`${when},,,,,,${r.temp},${r.brk ? 1 : 0},夜間${r.len}時間`);
    else {
      const x = ratio(r);
      lines.push(`${when},${x === null ? "" : (x * k).toFixed(3)},${r.red},${r.far},${r.all},${r.fail ? "" : gainX(r.g)},${r.temp},${r.brk ? 1 : 0},${r.fail ? "測定失敗" : ""}`);
    }
  }
  const a = el("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type: "text/csv" }));
  a.download = `${s.name}.csv`;
  a.click();
};

// 削除は2回押したときだけ実行する
let deleteArmed = false;
$("b-del").onclick = () => {
  if (!deleteArmed) {
    deleteArmed = true;
    $("b-del").textContent = "もう一度押すと削除";
    setTimeout(() => { deleteArmed = false; $("b-del").textContent = "このスマホの記録を削除"; }, 4000);
    return;
  }
  deleteArmed = false;
  $("b-del").textContent = "このスマホの記録を削除";
  delete db.stakes[current];
  current = null;
  save(); render();
  show("このスマホに保存していた記録を削除しました。杭のタグの記録は残っています。");
};

render();
