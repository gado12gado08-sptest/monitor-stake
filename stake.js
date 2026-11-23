// stake.js  杭のタグの記録を読み解き、日別の値と判定を出す(画面には触れない)
// タグの中の配置は firmware/stake/tag.h と stake.ino の説明と対応している

export const DAY = 86400000;

// 判定の境目。すべて仮の値で、現地の試験で決め直す
export const TH = {
  open: 0.9,       // R:FRがこれ以上なら開放
  heavy: 0.5,      // これ未満なら競合・重度
  step: 0.25,      // 前後3日の中央値がこれ以上変わったら段差(下刈りなど)
  slope: 0.015,    // 1日あたりの傾きがこれ以上なら漸増・漸減
  clearFrac: 0.6,  // その日の明るさが、過去21日の明るい日の6割以上なら晴天日
  envDays: 21,
  winDays: 7,      // 傾きを求める期間
};

export function gainX(g) { return g === 0 ? 0.5 : 2 ** (g - 1); }

// ---- タグのペイロード(記録形式 版1)を読む ----
const CODE_DARK = 14, CODE_FAIL = 15;

export function parseTag(dv) {
  const u8 = o => dv.getUint8(o), i8 = o => dv.getInt8(o);
  const u16 = o => dv.getUint16(o, true), u32 = o => dv.getUint32(o, true);
  if (String.fromCharCode(u8(0), u8(1), u8(2), u8(3)) !== "MSTK") throw new Error("管理モニター杭の記録ではありません。");
  if (u8(4) !== 1) throw new Error(`この形式（版${u8(4)}）には対応していません。`);

  const rsz = u8(5), dsz = u8(6), block = u8(7), hcap = u16(8), dcap = u16(10);
  const hCount = u16(14), hNext = u16(16), dCount = u16(18), dNext = u16(20), flags = u8(23);
  const seqTotal = u32(24), lastBlock = u32(28), ssl = u32(32), oldestSeq = u32(40);
  const HDR = 48, aD = HDR + hcap * rsz;

  // 毎時記録: 古い順に並べ直し、何回目の記録かを振る。夜のまとめは時間数の分だけ番号を進める
  const hourly = [], dark = [];
  let seq = oldestSeq;
  for (let i = 0; i < hCount; i++) {
    const o = HDR + ((hNext + hcap - hCount + i) % hcap) * rsz;
    const code = u8(o + 6) & 0x0f, brk = (u8(o + 6) & 0x80) !== 0, temp = i8(o + 7);
    if (code === CODE_DARK) {
      dark.push({ seq, len: u16(o), temp, brk });
      seq += u16(o);
    } else {
      hourly.push({ seq, red: u16(o), far: u16(o + 2), all: u16(o + 4), g: code, temp, brk, fail: code === CODE_FAIL });
      seq++;
    }
  }
  if (seq !== seqTotal) throw new Error(`記録の並びが合いません（${seq}/${seqTotal}）。`);

  // 日別の要約: 古い順
  const blocks = [];
  const first = dCount < dcap ? 0 : dNext;
  for (let i = 0; i < dCount; i++) {
    const o = aD + ((first + i) % dcap) * dsz, med = u16(o + 4);
    blocks.push({ idx: lastBlock - (dCount - 1 - i), allMax: u16(o), g: u8(o + 2), tMax: i8(o + 3), tMin: i8(o + 7),
                  rfr: med === 0xffff ? null : med / 1000, n: u8(o + 6) & 0x3f, brk: (u8(o + 6) & 0x80) !== 0 });
  }
  return {
    interval: u16(12), block, seqTotal, oldestSeq, session: u32(44),
    battery: (flags & 1) !== 0, demo: (flags & 4) !== 0,
    secSinceLast: ssl === 0xffffffff ? null : ssl,
    hourly, dark, blocks,
  };
}

// 24件分の記録から日別の代表値を出す(杭の要約と同じ計算)。
// 代表値は、明るさが上位6件の 赤/遠赤 の中央値。夜のまとめは温度にだけ使う
export function summarize(recs) {
  let best = null, tMax = null, tMin = null, brk = false, n = 0;
  const cand = [];
  for (const r of recs) {
    if (r.brk) brk = true;
    if (r.temp !== null) { tMax = tMax === null ? r.temp : Math.max(tMax, r.temp); tMin = tMin === null ? r.temp : Math.min(tMin, r.temp); }
    if (r.dark || r.fail) continue;
    n++;
    const bright = r.all * 2 ** (12 - r.g);
    if (!best || bright >= best.bright) best = { bright, all: r.all, g: r.g };
    if (r.far >= 20) cand.push({ bright, q: Math.min(65000, Math.floor(r.red * 1000 / r.far)) });
  }
  const pick = cand.sort((a, b) => b.bright - a.bright).slice(0, 6).map(c => c.q).sort((a, b) => a - b);
  const m = pick.length >> 1;
  const med = !pick.length ? null : (pick.length % 2 ? pick[m] : Math.floor((pick[m - 1] + pick[m]) / 2)) / 1000;
  return { allMax: best ? best.all : 0, g: best ? best.g : CODE_FAIL, tMax, tMin, rfr: med, n, brk };
}

// ---- スマホに残す杭の記録 ----
// h: 毎時記録 {seq: [赤, 遠赤, 全体, ゲイン, 温度, 印(1=電源断 2=測定失敗)]}
// d: 夜のまとめ {seq: [時間数, 最低温度, 電源断]}
// b: 日別の要約 {番号: [全体, ゲイン, 最高温度, 最低温度, 代表値×1000(なければ-1), 件数, 電源断]}
// anchors: 読み取った時刻と、その時点の最新の記録番号(時刻の推定に使う)
export function newStake(id) {
  return { name: "杭 " + (id.replace(/[^0-9a-f]/gi, "").slice(-4).toUpperCase() || id), k: 1,
           interval: 60, block: 24, h: {}, d: {}, b: {}, anchors: [], reads: [] };
}

// 読み取った記録を足し合わせる。杭側で記録が消されていたら、古い記録を捨てて true を返す
export function addRead(s, p, readAt) {
  const seenMax = s.anchors.reduce((m, a) => Math.max(m, a.seq), -1);
  const restarted = (s.session !== undefined && s.session !== p.session) || p.seqTotal - 1 < seenMax;
  if (restarted) { s.h = {}; s.d = {}; s.b = {}; s.anchors = []; }
  Object.assign(s, { session: p.session, interval: p.interval, block: p.block, battery: p.battery, demo: p.demo });
  for (const r of p.hourly) s.h[r.seq] = [r.red, r.far, r.all, r.g, r.temp, (r.brk ? 1 : 0) | (r.fail ? 2 : 0)];
  for (const r of p.dark) s.d[r.seq] = [r.len, r.temp, r.brk ? 1 : 0];
  for (const b of p.blocks) s.b[b.idx] = [b.allMax, b.g, b.tMax, b.tMin, b.rfr === null ? -1 : Math.round(b.rfr * 1000), b.n, b.brk ? 1 : 0];
  if (p.seqTotal > 0) s.anchors.push({ at: readAt, seq: p.seqTotal - 1, ssl: p.secSinceLast });
  s.anchors = s.anchors.slice(-200);
  s.reads = [...s.reads, readAt].slice(-500);
  return restarted;
}

export function hourlyRecords(s) {
  return Object.keys(s.h).map(Number).sort((a, b) => a - b).map(seq => {
    const [red, far, all, g, temp, f] = s.h[seq];
    return { seq, red, far, all, g, temp, brk: (f & 1) !== 0, fail: (f & 2) !== 0 };
  });
}

export function darkRecords(s) {
  return Object.keys(s.d).map(Number).sort((a, b) => a - b).map(seq => {
    const [len, temp, brk] = s.d[seq];
    return { seq, dark: true, len, temp, brk: brk === 1 };
  });
}

// 赤/遠赤(補正前)。暗すぎる記録と測定失敗は null
export function ratio(r) { return r.fail || r.far < 20 ? null : r.red / r.far; }

// ---- 時刻の推定 ----
// 杭は時計を持たないので、読み取った時刻から記録の数だけさかのぼる。
// 電源断で区切られた区間ごとに、その区間の中で最も新しい読み取りを基準にする
export function timeModel(s) {
  const breaks = [...hourlyRecords(s), ...darkRecords(s)].filter(r => r.brk).map(r => r.seq).sort((a, b) => a - b);
  const segment = q => breaks.filter(b => b <= q).length;
  const best = {};
  for (const a of s.anchors) { const g = segment(a.seq); if (!best[g] || a.at > best[g].at) best[g] = a; }
  const latest = s.anchors.reduce((m, a) => (!m || a.at > m.at ? a : m), null);
  return q => {
    const a = best[segment(q)] || latest;
    if (!a) return null;
    const lag = a.ssl === null ? s.interval * 30000 : a.ssl * 1000;   // 電池運用では最後の記録の時刻が不明なので、間隔の半分とする
    return a.at - lag - (a.seq - q) * s.interval * 60000;
  };
}

// ---- 日別の値 ----
// 24件そろっていればスマホの毎時記録から、なければ杭の要約から取る
export function dailySeries(s, time) {
  const B = s.block, recs = [...hourlyRecords(s), ...darkRecords(s)];
  const idxs = new Set([...Object.keys(s.b).map(Number), ...recs.map(r => Math.floor(r.seq / B))]);
  const out = [];
  for (const i of [...idxs].sort((a, b) => a - b)) {
    const inBlock = recs.filter(r => r.seq >= i * B && r.seq < (i + 1) * B);
    const covered = inBlock.reduce((n, r) => n + (r.dark ? r.len : 1), 0);
    let d = null;
    if (covered === B) d = summarize(inBlock);
    else if (s.b[i]) { const [allMax, g, tMax, tMin, rfr, n, brk] = s.b[i]; d = { allMax, g, tMax, tMin, rfr: rfr < 0 ? null : rfr / 1000, n, brk: brk === 1 }; }
    else if (covered >= B / 2) d = summarize(inBlock);
    if (!d) continue;
    out.push({ idx: i, t: time(i * B + B / 2), ...d, bright: d.g <= 12 ? d.allMax / gainX(d.g) : null });
  }
  return out;
}

// ---- 判定 ----
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function slopeOf(ps) {   // 1日あたりの傾き(最小二乗)
  if (ps.length < 2) return null;
  const xs = ps.map(p => p.t / DAY), ys = ps.map(p => p.rfr);
  const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  return sxx > 0 ? sxy / sxx : null;
}

export function stageOf(level) {
  return level >= TH.open ? "植栽初期・開放" : level >= TH.heavy ? "下草競合・軽度" : "下草競合・重度";
}

// days: [{t, rfr(補正後), bright}]
// 返す値 pts: 晴天日かどうかを付けた日別の値 / events: 段差と漸増・漸減 / state: 現在の段階
export function analyze(days) {
  const pts = days.filter(d => d.rfr !== null && d.t !== null).map(d => ({ ...d }));

  // 晴天日と曇天日: 過去21日の明るさの90パーセンタイルを、その杭の晴天の明るさとみなす
  for (const p of pts) {
    const past = pts.filter(q => q.t <= p.t && q.t > p.t - TH.envDays * DAY && q.bright > 0).map(q => q.bright).sort((a, b) => a - b);
    const env = past.length ? past[Math.floor((past.length - 1) * 0.9)] : null;
    p.clear = !env || !(p.bright > 0) || p.bright >= TH.clearFrac * env;
  }
  const clear = pts.filter(p => p.clear);

  // 段差: 晴天日の前3日と後3日の中央値の差。日付は、間にある曇天日も含めて前日からの変化が最も大きい日
  const stepDay = (ta, tb, sign) => {
    const seg = pts.filter(p => p.t >= ta && p.t <= tb);
    let best = tb, bv = -Infinity;
    for (let j = 1; j < seg.length; j++) { const v = sign * (seg[j].rfr - seg[j - 1].rfr); if (v > bv) { bv = v; best = seg[j].t; } }
    return best;
  };
  const events = [];
  for (let i = 1; i < clear.length; i++) {
    const prev = clear.slice(Math.max(0, i - 3), i).filter(p => clear[i].t - p.t <= TH.winDays * DAY);
    if (!prev.length) continue;
    const last = events.at(-1);
    if (last && clear[i].t - last.t <= 3 * DAY) continue;
    const before = median(prev.map(p => p.rfr)), after = median(clear.slice(i, i + 3).map(p => p.rfr));
    const jump = clear[i].rfr - clear[i - 1].rfr;
    if (after - before >= TH.step && jump >= TH.step * 0.8)
      events.push({ kind: "step", type: before < TH.open ? "下刈り" : "急増", t: stepDay(clear[i - 1].t, clear[i].t, 1), from: before, to: after });
    else if (before - after >= TH.step && -jump >= TH.step * 0.8)
      events.push({ kind: "step", type: "急減", t: stepDay(clear[i - 1].t, clear[i].t, -1), from: before, to: after });
  }
  const steps = events.slice();
  const crossesStep = (ta, tb) => steps.some(e => e.t > ta && e.t <= tb);

  // 漸増・漸減: 各晴天日の直近7日(段差をまたがない)の傾きが、同じ向きで3日以上続いた期間
  const segs = [];
  for (const p of clear) {
    const w = clear.filter(q => q.t <= p.t && q.t > p.t - TH.winDays * DAY && !crossesStep(q.t, p.t));
    const slope = w.length >= 4 ? slopeOf(w) : null;
    const dir = slope === null ? null : slope >= TH.slope ? "up" : slope <= -TH.slope ? "down" : null;
    if (!dir) continue;
    const cur = segs.at(-1);
    if (cur && cur.dir === dir && w[0].t <= cur.t1 + 3 * DAY && !crossesStep(cur.t1, p.t)) { cur.t1 = p.t; cur.slopes.push(slope); }
    else segs.push({ dir, t0: w[0].t, t1: p.t, slopes: [slope] });
  }
  for (const s of segs) if (s.t1 - s.t0 >= 3 * DAY)
    events.push({ kind: "trend", type: s.dir === "up" ? "漸増" : "漸減", t: s.t0, t1: s.t1, slope: median(s.slopes) });
  events.sort((a, b) => a.t - b.t);

  // 現在の段階: 直近10日の晴天日が3日以上あるときだけ判定する
  const lastT = pts.length ? pts.at(-1).t : 0;
  const recent = clear.filter(p => lastT - p.t <= 10 * DAY);
  const state = { hold: recent.length < 3, nClear: recent.length };
  if (!state.hold) {
    const last3 = recent.slice(-3);
    state.level = median(last3.map(p => p.rfr));
    state.from = last3[0].t;
    state.to = last3.at(-1).t;
    state.stage = stageOf(state.level);
    if (state.level < TH.open) {
      const lastOpen = clear.filter(p => p.rfr >= TH.open).at(-1);
      state.belowDays = lastOpen ? Math.round((state.to - lastOpen.t) / DAY) : null;
    }
    const w = clear.filter(q => q.t > lastT - TH.winDays * DAY && !crossesStep(q.t, lastT));
    state.slope = w.length >= 4 ? slopeOf(w) : null;
    state.slopeN = w.length;
  }
  return { pts, events, state };
}
