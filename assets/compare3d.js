/* 쿨링 보행축 3D 비교: 왼쪽 현재(미가동), 오른쪽 열저감 시스템 가동 */
(() => {
  "use strict";
  const M = window.CoolModel;
  const { Deck, MapView, TileLayer, BitmapLayer, PolygonLayer, PathLayer, PointCloudLayer, LineLayer, COORDINATE_SYSTEM, FlyToInterpolator } = deck;
  const $ = (id) => document.getElementById(id);
  const fmt = (v, d = 1, u = "") => (v == null || Number.isNaN(v) ? "–" : v.toFixed(d) + u);

  // ---- 좌표: 보행축 중심 기준 미터 좌표 ----
  let LON0, LAT0;
  const KY = 110990, KX = () => 111320 * Math.cos(LAT0 * Math.PI / 180);
  const toXY = (lat, lon) => [(lon - LON0) * KX(), (lat - LAT0) * KY];
  const toLL = (x, y) => [LON0 + x / KX(), LAT0 + y / KY];

  // ---- 냉각 커널 (경험식) ----
  const K = { Lc: 7, La0: 8, LaPerWs: 1.5, zc: 2.2, zs: 1.6, driftPerWs: 2.5, driftMax: 10, zone: 10, reach: 28, capFrac: 0.5, ampMax: 2.5 };
  const ZLEV = [0.3, 1, 1.8, 2.6, 3.6, 5, 7];
  const WET = new Set(["mist", "flush", "night"]);
  const SURF_DROP = 7;
  const PAVE_SURF = 6;   // 쿨페이브먼트 노면온도 하강 (Middel 외 2020)
  const RES = 3;          // 지면 래스터 해상도(m)
  const PT = 3;           // 3차원 점 간격(m, 래스터 해상도의 배수)

  // 색: 차가운 파랑 → 흰색 → 붉은색 (RdYlBu 계열)
  const STOPS = ["#313695", "#4575b4", "#74add1", "#abd9e9", "#e0f3f8", "#fee090", "#fdae61", "#f46d43", "#d73027", "#a50026"]
    .map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
  // 차이 색: 0℃ 흰색 → −6℃ 진한 파랑
  const DSTOPS = [[247, 247, 247], [209, 229, 240], [146, 197, 222], [67, 147, 195], [33, 102, 172], [5, 48, 97]];
  const DMAX = 6;
  function diffColor(d, out, o) {
    let u = -d / DMAX; u = u < 0 ? 0 : u > 1 ? 1 : u;
    const f = u * (DSTOPS.length - 1), i = Math.min(DSTOPS.length - 2, Math.floor(f)), w = f - i, a = DSTOPS[i], b = DSTOPS[i + 1];
    out[o] = a[0] + (b[0] - a[0]) * w; out[o + 1] = a[1] + (b[1] - a[1]) * w; out[o + 2] = a[2] + (b[2] - a[2]) * w;
  }
  function colorAt(t, lo, hi, out, o) {
    let u = (t - lo) / (hi - lo); u = u < 0 ? 0 : u > 1 ? 1 : u;
    const f = u * (STOPS.length - 1), i = Math.min(STOPS.length - 2, Math.floor(f)), w = f - i;
    const a = STOPS[i], b = STOPS[i + 1];
    out[o] = a[0] + (b[0] - a[0]) * w; out[o + 1] = a[1] + (b[1] - a[1]) * w; out[o + 2] = a[2] + (b[2] - a[2]) * w;
  }

  const S = { view: "replay", dayIdx: 0, hour: 14, playing: null, focus: "all", data: {}, vs: null };
  let G = {};          // 미리 계산한 기하 정보
  let deckgl, staticLayers = {}, dynLayers = {}, wind = null;

  // ---------------------------------------------------------------- 준비
  function prepare() {
    const segs = S.data.segments;
    const all = segs.flatMap((s) => s.coords);
    LAT0 = all.reduce((a, c) => a + c[0], 0) / all.length;
    LON0 = all.reduce((a, c) => a + c[1], 0) / all.length;
    const xy = all.map((c) => toXY(c[0], c[1]));
    const pad = 160;
    const x0 = Math.min(...xy.map((p) => p[0])) - pad, x1 = Math.max(...xy.map((p) => p[0])) + pad;
    const y0 = Math.min(...xy.map((p) => p[1])) - pad, y1 = Math.max(...xy.map((p) => p[1])) + pad;
    const nx = Math.ceil((x1 - x0) / RES), ny = Math.ceil((y1 - y0) / RES);
    G = { x0, y0, x1, y1, nx, ny };
    const sw = toLL(x0, y0), ne = toLL(x0 + nx * RES, y0 + ny * RES);
    G.bounds = [sw[0], sw[1], ne[0], ne[1]];

    // 건물 마스크 (래스터, 위가 북쪽)
    const cv = document.createElement("canvas"); cv.width = nx; cv.height = ny;
    const ctx = cv.getContext("2d"); ctx.fillStyle = "#000";
    S.data.buildings.forEach((b) => {
      ctx.beginPath();
      b.p.forEach(([lon, lat], i) => { const [x, y] = toXY(lat, lon); const px = (x - x0) / RES, py = ny - (y - y0) / RES; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.closePath(); ctx.fill();
    });
    const md = ctx.getImageData(0, 0, nx, ny).data;
    G.bmask = new Uint8Array(nx * ny);
    for (let i = 0; i < nx * ny; i++) G.bmask[i] = md[i * 4 + 3] > 100 ? 1 : 0;
    G.bctx = cv; // 지면 래스터에서 건물 부분 지우기용

    // 보행축까지 거리 (chamfer 거리변환). 쿨페이브먼트 구간까지 거리는 따로
    const distField = (list) => {
    const D = new Float32Array(nx * ny).fill(1e9);
    list.forEach((s) => {
      for (let i = 0; i < s.coords.length - 1; i++) {
        const a = toXY(...s.coords[i]), b = toXY(...s.coords[i + 1]);
        const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (RES / 2));
        for (let k = 0; k <= n; k++) {
          const x = a[0] + (b[0] - a[0]) * k / n, y = a[1] + (b[1] - a[1]) * k / n;
          const px = Math.round((x - x0) / RES), py = ny - 1 - Math.round((y - y0) / RES);
          if (px >= 0 && px < nx && py >= 0 && py < ny) D[py * nx + px] = 0;
        }
      }
    });
    const d1 = RES, d2 = RES * Math.SQRT2;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = y * nx + x; let v = D[i];
      if (x > 0) v = Math.min(v, D[i - 1] + d1);
      if (y > 0) { v = Math.min(v, D[i - nx] + d1); if (x > 0) v = Math.min(v, D[i - nx - 1] + d2); if (x < nx - 1) v = Math.min(v, D[i - nx + 1] + d2); }
      D[i] = v;
    }
    for (let y = ny - 1; y >= 0; y--) for (let x = nx - 1; x >= 0; x--) {
      const i = y * nx + x; let v = D[i];
      if (x < nx - 1) v = Math.min(v, D[i + 1] + d1);
      if (y < ny - 1) { v = Math.min(v, D[i + nx] + d1); if (x < nx - 1) v = Math.min(v, D[i + nx + 1] + d2); if (x > 0) v = Math.min(v, D[i + nx - 1] + d2); }
      D[i] = v;
    }
      return D;
    };
    const D = distField(segs);
    G.Dpave = distField(segs.filter((x) => x.prescription.includes("쿨페이브먼트")));
    G.alpha = new Uint8Array(nx * ny);
    for (let i = 0; i < nx * ny; i++) {
      const f = D[i] <= 40 ? 1 : D[i] >= 170 ? 0 : 1 - (D[i] - 40) / 130;
      G.alpha[i] = G.bmask[i] ? 0 : Math.round(215 * f);
    }

    // 미스트 폴대 위치 = 35m 이내 지상식 소화전을 보행축 선에 투영한 지점 (8m 안 중복 제거)
    G.noz = [];
    const project = (px, py, line) => {
      let best = null, bd = 1e9;
      for (let i = 0; i < line.length - 1; i++) {
        const [ax, ay] = line[i], [bx, by] = line[i + 1], dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
        const qx = ax + t * dx, qy = ay + t * dy, d = Math.hypot(px - qx, py - qy);
        if (d < bd) { bd = d; best = [qx, qy]; }
      }
      return best;
    };
    segs.forEach((s, si) => {
      if (s.seg_type === "D") return;
      const line = s.coords.map(([la, lo]) => toXY(la, lo));
      (s.nozzles || []).forEach(([lat, lon]) => {
        const [x, y] = project(...toXY(lat, lon), line);
        if (G.noz.some((n) => Math.hypot(n.x - x, n.y - y) < 8)) return;
        G.noz.push({ x, y, seg: si });
      });
    });
    const inMask = (x, y) => {
      const px = Math.floor((x - x0) / RES), py = ny - 1 - Math.floor((y - y0) / RES);
      return px < 0 || px >= nx || py < 0 || py >= ny ? 0 : G.bmask[py * nx + px];
    };
    // 3차원 점: 보행축 25m 안, 건물 밖. 노즐 영향권이면 노즐 목록을 붙인다
    const cells = new Map();
    for (let py = 0; py < ny; py += Math.round(PT / RES) || 1) for (let px = 0; px < nx; px += Math.round(PT / RES) || 1) {
      const i = py * nx + px;
      if (D[i] > 25 || G.bmask[i]) continue;
      const x = x0 + (px + 0.5) * RES, y = y0 + (ny - 1 - py + 0.5) * RES;
      cells.set(i, { x, y, nz: [], d: D[i], seg: -1, pave: G.Dpave[i] <= 12 });
    }
    cells.forEach((c) => G.noz.forEach((n, ni) => { if (Math.hypot(c.x - n.x, c.y - n.y) <= K.reach) c.nz.push(ni); }));
    // 가장 가까운 구간 (바닥 살수 범위 판정용)
    const segXY = segs.map((s) => s.coords.map(([la, lo]) => toXY(la, lo)));
    cells.forEach((c) => {
      let bd = 1e9;
      segXY.forEach((line, si) => line.forEach(([px, py], j) => {
        if (j === line.length - 1) return;
        const [qx, qy] = line[j + 1], dx = qx - px, dy = qy - py;
        const t = Math.max(0, Math.min(1, ((c.x - px) * dx + (c.y - py) * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(c.x - px - t * dx, c.y - py - t * dy);
        if (d < bd) { bd = d; c.seg = si; }
      }));
    });
    const cl = [...cells.values()];
    const N = cl.length * ZLEV.length;
    G.pts = { n: N, pos: new Float32Array(N * 3), col: new Uint8Array(N * 4), colOn: new Uint8Array(N * 4), cell: new Int32Array(N), z: new Float32Array(N) };
    G.cells = cl;
    let k = 0;
    // 높이 순서로 쌓아 위쪽 플룸이 지면 가열층 위에 그려지게 한다
    ZLEV.forEach((z) => cl.forEach((c, ci) => {
      G.pts.pos[k * 3] = c.x; G.pts.pos[k * 3 + 1] = c.y; G.pts.pos[k * 3 + 2] = z;
      G.pts.cell[k] = ci; G.pts.z[k] = z; k++;
    }));
    // 지면 래스터 중 노즐 영향권 픽셀
    const near = new Map();
    G.noz.forEach((n, ni) => {
      const r = K.reach;
      const px0 = Math.max(0, Math.floor((n.x - r - x0) / RES)), px1 = Math.min(nx - 1, Math.ceil((n.x + r - x0) / RES));
      const py0 = Math.max(0, Math.floor((n.y - r - y0) / RES)), py1 = Math.min(ny - 1, Math.ceil((n.y + r - y0) / RES));
      for (let px = px0; px <= px1; px++) for (let pyU = py0; pyU <= py1; pyU++) {
        const x = x0 + (px + 0.5) * RES, y = y0 + (pyU + 0.5) * RES;
        const d = Math.hypot(x - n.x, y - n.y);
        if (d > r) continue;
        const i = (ny - 1 - pyU) * nx + px;
        if (G.bmask[i]) continue;
        let e = near.get(i); if (!e) { e = { x, y, nz: [] }; near.set(i, e); }
        e.nz.push(ni);
        if (d <= K.zone) (n.zone || (n.zone = [])).push(i);
      }
    });
    G.near = near;
    // 구간별 서비스 구역(노즐 반경 12m 보행 영역)
    G.segZone = segs.map(() => new Set());
    G.noz.forEach((n) => (n.zone || []).forEach((i) => G.segZone[n.seg].add(i)));
  }

  // ---------------------------------------------------------------- 시점 자료
  function readings() {
    const meta = new Map(S.data.sensors.map((s) => [s.serial, s]));
    if (S.view === "live") {
      const rt = S.data.realtime || {};
      let list = (rt.sensors || []).filter((s) => s.t != null && s.rh != null && meta.has(s.serial)).map((s) => ({ ...meta.get(s.serial), t: s.t, rh: s.rh }));
      let hour = rt.latest_obs ? +rt.latest_obs.slice(8, 10) : new Date().getHours();
      const n = (S.data.kma || {}).ncst;
      const lo = rt.latest_obs;
      const age = lo ? (Date.now() - (Date.UTC(+lo.slice(0, 4), +lo.slice(4, 6) - 1, +lo.slice(6, 8), +lo.slice(8, 10)) - 9 * 3.6e6)) / 3.6e6 : Infinity;
      if (n && typeof n.T1H === "number" && (age > 3 || !list.length)) {
        // S-DoT가 늦으면 기상청 실황 기온을 기준으로 하고 센서 사이 차이만 S-DoT에서 가져온다 (대시보드와 같은 방식)
        const mean = list.length ? list.reduce((a, s) => a + s.t, 0) / list.length : 0;
        list = list.map((s) => ({ ...s, t: n.T1H + (s.t - mean), rh: n.REH }));
        hour = +n.time.slice(8, 10);
        return { hour, sensors: list, uniform: { t: n.T1H, rh: n.REH }, ws: n.WSD, wd: n.VEC, tg: null, rain: (+n.PTY || 0) > 0 || (+n.RN1 || 0) > 0,
                 label: `${+n.time.slice(4, 6)}월 ${+n.time.slice(6, 8)}일 ${hour}시 실시간(기상청 실황)` };
      }
      return { hour, sensors: list, uniform: null, ws: n && typeof n.WSD === "number" ? n.WSD : null, wd: n ? n.VEC : null, tg: null,
               label: rt.latest_obs ? `${+rt.latest_obs.slice(4, 6)}월 ${+rt.latest_obs.slice(6, 8)}일 ${hour}시 실시간` : "실시간 자료 없음" };
    }
    const day = S.data.replay.days[S.dayIdx];
    const rec = day && day.hours.find((h) => h.h === S.hour);
    if (!rec) return { hour: S.hour, sensors: [], uniform: null, label: "자료 없음" };
    const list = rec.s ? Object.entries(rec.s).filter(([k]) => meta.has(k)).map(([k, v]) => ({ ...meta.get(k), t: v[0], rh: v[1] })) : [];
    return { hour: S.hour, sensors: list, uniform: { t: rec.ta, rh: rec.rh }, ws: rec.ws, wd: rec.wd, tg: rec.tg,
             label: `${day.label.split(" (")[0]} ${S.hour}시` };
  }

  // ---------------------------------------------------------------- 계산
  function compute() {
    const R = readings();
    const { nx, ny, x0, y0 } = G;
    // 1) 기온장: 거리역가중을 15m 격자에서 계산 후 보간
    const step = 5, cx = Math.ceil(nx / step) + 1, cy = Math.ceil(ny / step) + 1;
    const coarse = new Float32Array(cx * cy);
    const sens = R.sensors.map((s) => ({ ...s, xy: toXY(s.lat, s.lon) }));
    for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
      const x = x0 + i * step * RES, y = y0 + (ny - j * step) * RES;
      if (!sens.length) { coarse[j * cx + i] = R.uniform ? R.uniform.t : NaN; continue; }
      let num = 0, den = 0;
      for (const s of sens) { const d = Math.hypot(s.xy[0] - x, s.xy[1] - y) + 30; const w = 1 / (d * d); num += w * s.t; den += w; }
      coarse[j * cx + i] = num / den;
    }
    const taAt = (px, py) => {
      const fx = px / step, fy = py / step, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
      const a = coarse[j * cx + i], b = coarse[j * cx + i + 1], c = coarse[(j + 1) * cx + i], d = coarse[(j + 1) * cx + i + 1];
      return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
    };
    // 2) 구간별 운전 판정과 모형 저감폭
    const segs = S.data.segments;
    const res = segs.map((seg) => {
      const mid = seg.coords[Math.floor(seg.coords.length / 2)];
      let ta = null, rh = null;
      if (R.sensors.length) { ta = M.idw(mid[0], mid[1], R.sensors, "t"); rh = M.idw(mid[0], mid[1], R.sensors, "rh"); }
      else if (R.uniform) { ta = R.uniform.t; rh = R.uniform.rh; }
      if (ta == null) return { seg, mode: "off", ta: null };
      const mode = M.modeOf(seg, ta, rh, R.hour, R.rain);
      const e = M.effect(ta, rh, M.effFor(seg));
      return { seg, mode, ta, rh, tw: e.tw, dTa: mode === "mist" ? e.dTa : 0, dTapp: mode === "mist" ? e.dTapp : 0 };
    });
    // 3) 바람에 따른 플룸 이동
    const ws = R.ws || 0;
    const to = R.wd == null ? 0 : ((R.wd + 180) % 360) * Math.PI / 180;   // 바람이 불어 가는 쪽
    const ux = Math.sin(to), uy = Math.cos(to);
    const drift = Math.min(K.driftMax, K.driftPerWs * ws), La = K.La0 + K.LaPerWs * ws;
    const kern = (n, x, y, z) => {
      const dx = x - (n.x + ux * drift), dy = y - (n.y + uy * drift);
      const a = dx * ux + dy * uy, c = -dx * uy + dy * ux;
      return Math.exp(-(a * a) / (La * La) - (c * c) / (K.Lc * K.Lc) - ((z - K.zc) / K.zs) ** 2);
    };
    // 4) 구간별 진폭: 노즐 반경 12m 보행 영역(1.5m 높이) 평균이 모형 저감폭과 같도록 보정
    const amp = new Float32Array(segs.length);
    res.forEach((r, si) => {
      if (r.mode !== "mist") return;
      const zone = G.segZone[si];
      if (!zone.size) return;
      let sum = 0;
      zone.forEach((i) => { const e = G.near.get(i); let v = 0; e.nz.forEach((ni) => { if (G.noz[ni].seg === si) v += kern(G.noz[ni], e.x, e.y, 1.5); }); sum += v; });
      const m = sum / zone.size;
      amp[si] = m > 0 ? Math.max(r.dTa / m, K.ampMax * r.dTa) : 0;   // 음수: 진폭은 모형 저감폭의 2.5배까지
    });
    // 국지 상한: 습구온도 강하량(기온 − 습구온도)의 50%를 넘게 식지 않는다
    const mistR = res.filter((r) => r.mode === "mist");
    const cap = mistR.length ? -K.capFrac * mistR.reduce((a, r) => a + (r.ta - r.tw), 0) / mistR.length : 0;
    const dT = (nzList, x, y, z) => { let v = 0; for (const ni of nzList) { const n = G.noz[ni]; if (amp[n.seg]) v += amp[n.seg] * kern(n, x, y, z); } return v < cap ? cap : v; };

    // 색 범위
    const valid = res.filter((r) => r.ta != null);
    const tMean = valid.length ? valid.reduce((a, r) => a + r.ta, 0) / valid.length : 25;
    const lo = Math.round(tMean) - 4, hi = Math.round(tMean) + 2;
    G.range = [lo, hi];

    // 5) 지면 래스터 (보행 높이 1.5m 기온)
    const paveAir = R.hour >= 10 && R.hour < 18 ? -0.5 : -0.1;   // Middel 외(2020): 낮 0.5℃, 밤 0.1℃
    const imgL = new ImageData(nx, ny), imgR = new ImageData(nx, ny);
    const rgb = [0, 0, 0];
    let minD = 0;
    for (let py = 0; py < ny; py++) for (let px = 0; px < nx; px++) {
      const i = py * nx + px, o = i * 4;
      const a = G.alpha[i]; if (!a) continue;
      const t = taAt(px, py);
      colorAt(t, lo, hi, rgb, 0);
      imgL.data[o] = rgb[0]; imgL.data[o + 1] = rgb[1]; imgL.data[o + 2] = rgb[2]; imgL.data[o + 3] = a;
      let t2 = t;
      if (G.Dpave[i] <= 12) t2 += paveAir;   // 쿨페이브먼트 기온 효과
      const e = G.near.get(i);
      if (e) { const d = dT(e.nz, e.x, e.y, 1.5); t2 += d; if (d < minD) minD = d; }
      if (S.diff) {   // 차이 보기: 가동 − 현재
        diffColor(t2 - t, rgb, 0);
        imgR.data[o] = rgb[0]; imgR.data[o + 1] = rgb[1]; imgR.data[o + 2] = rgb[2]; imgR.data[o + 3] = t2 - t < -0.1 ? 240 : Math.round(a * 0.35);
      } else {
        colorAt(t2, lo, hi, rgb, 0);
        imgR.data[o] = rgb[0]; imgR.data[o + 1] = rgb[1]; imgR.data[o + 2] = rgb[2]; imgR.data[o + 3] = Math.max(a, e && t2 < t - 0.15 ? 235 : 0);
      }
    }
    // 6) 3차원 점
    const P = G.pts;
    for (let k = 0; k < P.n; k++) {
      const c = G.cells[P.cell[k]], z = P.z[k];
      const px = (c.x - x0) / RES, py = ny - 1 - (c.y - y0) / RES;
      const ta = taAt(Math.max(0, Math.min(nx - 1, px)), Math.max(0, Math.min(ny - 1, py)));
      const excess = R.tg != null ? R.tg - ta : 0;
      const surf = excess * Math.exp(-z / 0.35);    // 지면 가열층
      // 바닥 살수: 보도·차도 가장자리(보행축 선 12m 안)의 노면온도를 최대 7℃ 낮춘다 (Hendel 외 2015 실측 6~7.5℃)
      const wet = c.seg >= 0 && c.d <= 12 && WET.has(res[c.seg].mode);
      let exOn = c.pave ? Math.max(0, excess - PAVE_SURF) : excess;
      if (wet) exOn = Math.max(0, exOn - SURF_DROP);
      const surfOn = exOn * Math.exp(-z / 0.35);
      const tb = ta + surf, ton = ta + surfOn + dT(c.nz, c.x, c.y, z) + (c.pave ? paveAir : 0);
      colorAt(tb, lo, hi, P.col, k * 4);
      if (S.diff) diffColor(ton - tb, P.colOn, k * 4); else colorAt(ton, lo, hi, P.colOn, k * 4);
      // 배경과 차이가 있는 점만 보이게: 왼쪽은 지면 가열층, 오른쪽은 지면 가열층 + 냉각 플룸
      const aS = Math.abs(surf) > 0.3 ? 30 + 70 * Math.min(1, Math.abs(surf) / 8) : 0;
      const d = ton - tb;
      P.col[k * 4 + 3] = aS;
      const aSon = Math.abs(surfOn) > 0.3 ? 30 + 70 * Math.min(1, Math.abs(surfOn) / 8) : 0;
      const dAir = dT(c.nz, c.x, c.y, z);
      P.colOn[k * 4 + 3] = S.diff ? (ton - tb < -0.25 ? 60 + 195 * Math.min(1, (tb - ton) / 3) : 0)
        : dAir < -0.25 ? 70 + 185 * Math.min(1, -dAir / 2) : aSon;
    }
    const toCanvas = (img) => { const c = document.createElement("canvas"); c.width = nx; c.height = ny; c.getContext("2d").putImageData(img, 0, 0); return c; };
    return { R, res, imgL: toCanvas(imgL), imgR: toCanvas(imgR), minD, ws, wd: R.wd, ux, uy, tMean };
  }

  // ---------------------------------------------------------------- 레이어
  const hexRGB = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  function tiles(id) {
    return new TileLayer({
      id, data: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", minZoom: 0, maxZoom: 19, tileSize: 256,
      renderSubLayers: (props) => {
        const [[w, s], [e, n]] = props.tile.boundingBox;
        return new BitmapLayer(props, { data: null, image: props.data, bounds: [w, s, e, n], desaturate: 0.9, opacity: 0.6 });
      },
    });
  }
  function buildStatic() {
    staticLayers.tilesL = tiles("L-tiles");
    staticLayers.tilesR = tiles("R-tiles");
    makeBld();
    // 동대문구 바깥은 흐리게 가린다
    const bnd = S.data.boundary;
    if (bnd) {
      const ring = bnd.geometry.coordinates[0];
      staticLayers.mask = new PolygonLayer({ id: "mask", data: [{ p: [[[120, 33], [135, 33], [135, 43], [120, 43]], ring] }], getPolygon: (d) => d.p,
        getFillColor: [238, 240, 243, 225], stroked: false, pickable: false, parameters: { depthCompare: "always", depthWriteEnabled: false } });
      staticLayers.bline = new PathLayer({ id: "bline", data: [{ p: ring }], getPath: (d) => d.p, getColor: [20, 42, 82, 200], getWidth: 2, widthUnits: "pixels",
        getDashArray: [6, 4], parameters: { depthCompare: "always" } });
    }
  }
  // 건물 표시: 불투명 / 반투명 / 숨김
  function makeBld() {
    const mode = S.bldMode || "solid";
    if (mode === "hide") { staticLayers.bld = null; return; }
    const solid = mode === "solid";
    staticLayers.bld = new PolygonLayer({
      id: "bld-" + mode, data: S.data.buildings, getPolygon: (b) => b.p, extruded: true, wireframe: !solid,
      getElevation: (b) => b.h || 3.3, getFillColor: solid ? [226, 229, 235] : [214, 219, 228, 70], getLineColor: [150, 160, 176, 90],
      opacity: 1, material: { ambient: 0.55, diffuse: 0.55, shininess: 8, specularColor: [40, 40, 40] }, pickable: false,
      parameters: solid ? {} : { depthWriteEnabled: false },
    });
  }
  function update() {
    const C = compute();
    S.last = C;
    const P = G.pts;
    const pts = (id, col) => new PointCloudLayer({
      id, coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS, coordinateOrigin: [LON0, LAT0],
      data: { length: P.n, attributes: { getPosition: { value: P.pos, size: 3 }, getColor: { value: col, size: 4, normalized: true } } },
      pointSize: 2.4, sizeUnits: "meters", material: false, updateTriggers: { getColor: S.stamp },
      parameters: { depthWriteEnabled: false },
    });
    S.stamp = (S.stamp || 0) + 1;
    const ground = (id, img) => new BitmapLayer({ id, image: img, bounds: G.bounds, parameters: { depthCompare: "always", depthWriteEnabled: false } });
    const segPaths = (id, on) => new PathLayer({
      id, data: C.res, getPath: (r) => r.seg.coords.map(([la, lo]) => [lo, la, 0.4]),
      getColor: (r) => (on ? hexRGB(M.MODE[r.mode].color) : [120, 128, 142]), getWidth: 3.2, widthUnits: "meters", widthMinPixels: 3,
      capRounded: true, jointRounded: true, pickable: true, updateTriggers: { getColor: S.stamp },
      parameters: { depthCompare: "always" },
    });
    dynLayers = {
      gL: ground("L-ground", C.imgL), gR: ground("R-ground", C.imgR),
      sL: segPaths("L-seg", false), sR: segPaths("R-seg", true),
      pL: pts("L-pts", P.col), pR: pts("R-pts", P.colOn),
    };
    wind = C.ws > 0.2 ? initWind(C) : null;
    draw();
    renderInfo(C);
  }
  function draw() {
    const L = staticLayers, D = dynLayers;
    const solid = (S.bldMode || "solid") === "solid";
    const layers = [L.tilesL, L.tilesR, L.mask, L.bline, D.gL, D.gR, D.sL, D.sR];
    if (solid) layers.push(L.bld, D.pL, D.pR); else layers.push(D.pL, D.pR, L.bld);   // 반투명이면 건물을 마지막에 겹쳐 그린다
    if (wind) layers.push(wind.layer());
    deckgl.setProps({ layers: layers.filter(Boolean) });
  }

  // 바람 입자 (풍향 표시용)
  function initWind(C) {
    const n = 700, { x0, x1, y0, y1 } = G;
    const sp = 4 + 7 * C.ws;   // 화면용 과장 속도 (m/프레임초)
    const p = Array.from({ length: n }, () => ({ x: x0 + Math.random() * (x1 - x0), y: y0 + Math.random() * (y1 - y0), age: Math.random() * 200 }));
    const src = new Float32Array(n * 3), dst = new Float32Array(n * 3);
    let last = performance.now();
    return {
      step() {
        const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
        p.forEach((q, i) => {
          q.x += C.ux * sp * dt * 3; q.y += C.uy * sp * dt * 3; q.age += 1;
          if (q.x < x0 || q.x > x1 || q.y < y0 || q.y > y1 || q.age > 260) { q.x = x0 + Math.random() * (x1 - x0); q.y = y0 + Math.random() * (y1 - y0); q.age = 0; }
          src[i * 3] = q.x - C.ux * 22; src[i * 3 + 1] = q.y - C.uy * 22; src[i * 3 + 2] = 4;
          dst[i * 3] = q.x; dst[i * 3 + 1] = q.y; dst[i * 3 + 2] = 4;
        });
      },
      layer() {
        return new LineLayer({
          id: "wind", coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS, coordinateOrigin: [LON0, LAT0],
          data: { length: n, attributes: { getSourcePosition: { value: src, size: 3 }, getTargetPosition: { value: dst, size: 3 } } },
          getColor: [255, 255, 255, 170], getWidth: 1.4, widthUnits: "pixels", updateTriggers: { getSourcePosition: performance.now() },
        });
      },
    };
  }
  function animate() {
    if (wind && !document.hidden) { wind.step(); draw(); }
    requestAnimationFrame(animate);
  }

  // ---------------------------------------------------------------- 화면 정보
  function renderInfo(C) {
    const R = C.R;
    const mist = C.res.filter((r) => r.mode === "mist");
    const ok = C.res.filter((r) => r.ta != null);
    const ta = ok.length ? ok.reduce((a, r) => a + r.ta, 0) / ok.length : null;
    const rh = ok.length ? ok.reduce((a, r) => a + r.rh, 0) / ok.length : null;
    const dTa = mist.length ? mist.reduce((a, r) => a + r.dTa, 0) / mist.length : null;
    const counts = {}; C.res.forEach((r) => (counts[r.mode] = (counts[r.mode] || 0) + 1));
    $("info").innerHTML = `
      <div>${R.label}</div>
      <div class="big">${fmt(ta, 1, "℃")} · ${fmt(rh, 0, "%")}</div>
      <div>바람 <b>${R.ws != null ? `${M.wdName(R.wd)}풍 ${fmt(R.ws, 1, " m/s")}` : "자료 없음"}</b></div>
      <div>지면온도 <b>${R.tg != null ? fmt(R.tg, 1, "℃") : "자료 없음"}</b> <span style="color:#7A8292">(ASOS)</span></div>
      <div>미스트 가동 <b>${mist.length}</b> / ${C.res.filter((r) => r.seg.seg_type !== "D").length} 구간</div>
      <div>구간 평균 기온 저감 <b>${dTa != null ? fmt(dTa, 1, "℃") : "–"}</b></div>
      <div>노즐 주변 최대 저감 <b>${C.minD < -0.05 ? fmt(C.minD, 1, "℃") : "–"}</b> <span style="color:#7A8292">(1.5m)</span></div>
      <div>쿨페이브먼트 <b>${C.res.filter((r) => r.seg.prescription.includes("쿨페이브먼트")).length}개 구간</b> · 기온 ${R.hour >= 10 && R.hour < 18 ? "−0.5" : "−0.1"}℃, 노면 −6℃</div>`;
    $("lbl-l").textContent = R.label;
    $("lbl-r").textContent = mist.length ? `미스트 ${mist.length}개 구간 가동` : (counts.flush ? "고습으로 하부 살수만" : counts.night ? "야간 방열 살수 (공기 냉각 없음)" : "가동 조건 아님");
    const [lo, hi] = G.range;
    $("lg-bar").style.background = `linear-gradient(90deg, ${STOPS.map((c) => `rgb(${c.join(",")})`).join(",")})`;
    $("lg-diff").hidden = !S.diff;
    $("lg-dbar").style.background = `linear-gradient(90deg, ${DSTOPS.slice().reverse().map((c) => `rgb(${c.join(",")})`).join(",")})`;
    $("lbl-r-title").textContent = S.diff ? "가동 − 현재 차이" : "열저감 시스템 가동";
    $("lg-ticks").innerHTML = Array.from({ length: hi - lo + 1 }, (_, i) => `<span>${lo + i}</span>`).filter((_, i, a) => a.length < 9 || i % 2 === 0).join("");
    $("lg-modes").innerHTML = ["mist", "flush", "night", "off", "passive"].map((m) => `<span><i style="background:${M.MODE[m].color}"></i>${M.MODE[m].label}</span>`).join("")
      + `<span><i style="background:#fff;border:1px solid #999;height:2px"></i>바람 입자</span>`;
    if (S.view === "replay") { $("hour-lbl").textContent = S.hour + "시"; $("hour").value = S.hour; }
    document.querySelectorAll("#quick button").forEach((b) => b.classList.toggle("on", S.view === "replay" && +b.dataset.h === S.hour));
  }

  // ---------------------------------------------------------------- 시점·조작
  function viewFor(c) {
    const segs = S.data.segments.filter((s) => c === "all" || s.corridor_id === c);
    const pts = segs.flatMap((s) => s.coords);
    const lats = pts.map((p) => p[0]), lons = pts.map((p) => p[1]);
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2 - (c === "all" ? 0.0012 : 0.0004), lon = (Math.min(...lons) + Math.max(...lons)) / 2;
    const narrow = window.innerWidth < 760;
    return { latitude: lat, longitude: lon, zoom: (c === "all" ? 14.0 : 15.9) - (narrow ? 0.5 : 0), pitch: 50, bearing: -18, maxPitch: 75, minZoom: 12, maxZoom: 19.5 };
  }
  function setVS(vs) { S.vs = vs; deckgl.setProps({ viewState: { left: vs, right: vs } }); }
  function makeViews() {
    const v = window.innerWidth < 760;
    return v
      ? [new MapView({ id: "left", x: 0, y: 0, width: "100%", height: "50%", controller: true }), new MapView({ id: "right", x: 0, y: "50%", width: "100%", height: "50%", controller: true })]
      : [new MapView({ id: "left", x: 0, y: 0, width: "50%", height: "100%", controller: true }), new MapView({ id: "right", x: "50%", y: 0, width: "50%", height: "100%", controller: true })];
  }

  async function init() {
    const g = M.getJSON;
    const [segments, sensors, buildings, replay, realtime, kma, boundary] = await Promise.all([
      g("data/segments.json", []), g("data/sensors.json", []), g("data/buildings_near.json", []),
      g("data/replay.json", { days: [] }), g("data/realtime.json", {}), g("data/kma.json", {}), g("data/boundary.json", null),
    ]);
    S.data = { segments, sensors, buildings, replay, realtime, kma, boundary };
    prepare();
    const f0 = (location.search.match(/focus=(C[123])/) || [])[1] || "all";
    const vs = viewFor(f0);
    deckgl = new Deck({
      parent: $("deck"), views: makeViews(), viewState: { left: vs, right: vs },
      onViewStateChange: ({ viewState }) => setVS(viewState),
      layerFilter: ({ layer, viewport }) => {
        if (layer.id.startsWith("L-")) return viewport.id === "left";
        if (layer.id.startsWith("R-")) return viewport.id === "right";
        return true;
      },
      getTooltip: ({ object, layer }) => {
        if (!object || !layer || !layer.id.includes("seg")) return null;
        const r = object, s = r.seg;
        const eff = r.mode === "mist" ? `<br>기온 ${fmt(r.dTa, 1, "℃")} · 체감 ${fmt(r.dTapp, 1, "℃")}` : "";
        return { html: `<b>${s.seg_id}</b> ${s.landmark}<br>${M.MODE[r.mode].label} · ${fmt(r.ta, 1, "℃")} · ${fmt(r.rh, 0, "%")}${eff}`, className: "deck-tooltip" };
      },
      controller: true,
    });
    S.vs = vs;
    window.addEventListener("resize", () => deckgl.setProps({ views: makeViews() }));
    buildStatic();

    const sel = $("day");
    sel.innerHTML = replay.days.map((d, i) => `<option value="${i}">${d.label}</option>`).join("");
    let hot = 0;
    replay.days.forEach((d, i) => { if (Math.max(...d.hours.map((h) => h.ta)) > Math.max(...replay.days[hot].hours.map((h) => h.ta))) hot = i; });
    S.dayIdx = hot; sel.value = String(hot);
    sel.onchange = () => { S.dayIdx = +sel.value; update(); };
    $("hour").oninput = (e) => { S.hour = +e.target.value; update(); };
    document.querySelectorAll("#quick button").forEach((b) => (b.onclick = () => { stop(); S.hour = +b.dataset.h; update(); }));
    document.querySelectorAll("#focus button").forEach((b) => (b.onclick = () => {
      document.querySelectorAll("#focus button").forEach((x) => x.classList.toggle("on", x === b));
      setVS({ ...viewFor(b.dataset.c), transitionDuration: 1200, transitionInterpolator: new FlyToInterpolator() });
    }));
    document.querySelectorAll("#focus button").forEach((x) => x.classList.toggle("on", x.dataset.c === f0));
    const hasLive = (realtime && realtime.sensors && realtime.sensors.length) || (kma && kma.ncst);
    document.querySelectorAll("#bld button").forEach((b) => (b.onclick = () => {
      S.bldMode = b.dataset.m; document.querySelectorAll("#bld button").forEach((x) => x.classList.toggle("on", x === b));
      makeBld(); draw();
    }));
    document.querySelectorAll("#rmode button").forEach((b) => (b.onclick = () => {
      S.diff = b.dataset.m === "diff"; document.querySelectorAll("#rmode button").forEach((x) => x.classList.toggle("on", x === b)); update();
    }));
    $("cv-btn").onclick = () => $("caveat").classList.toggle("open");
    $("v-live").disabled = !hasLive;
    if (!hasLive) $("v-live").title = "실시간 자료가 아직 없습니다";
    const setMode = (v) => {
      S.view = v; stop();
      $("v-live").classList.toggle("on", v === "live"); $("v-replay").classList.toggle("on", v === "replay");
      [sel, $("hour"), $("play")].forEach((el) => (el.disabled = v === "live"));
      update();
    };
    $("v-live").onclick = () => hasLive && setMode("live");
    $("v-replay").onclick = () => setMode("replay");
    $("play").onclick = () => {
      if (S.playing) return stop();
      $("play").textContent = "일시정지"; $("play").classList.add("on");
      S.playing = setInterval(() => {
        S.hour += 1;
        if (S.hour > 23) { S.hour = 0; S.dayIdx = (S.dayIdx + 1) % S.data.replay.days.length; sel.value = String(S.dayIdx); }   // 자정이 지나면 다음 날로
        update();
      }, 1600);
    };
    const t0 = performance.now();
    update();
    console.info("3D 계산", Math.round(performance.now() - t0), "ms, 점", G.pts.n, "노즐", G.noz.length);
    $("loading").style.display = "none";
    if (!/noanim/.test(location.search)) animate(); else window.__setVS = setVS;
  }
  function stop() {
    if (S.playing) { clearInterval(S.playing); S.playing = null; }
    $("play").textContent = "재생"; $("play").classList.remove("on");
  }

  init().catch((e) => { $("loading").textContent = "3D 화면을 불러오지 못했습니다: " + e.message; console.error(e); });
})();
