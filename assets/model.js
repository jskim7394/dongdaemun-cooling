/* 운전 규칙·열환경 계산 (대시보드와 3D 비교 화면이 함께 쓴다) */
window.CoolModel = (() => {
  "use strict";
  const RULE = { mistTa: 30, mistRh: 70, dayStart: 10, dayEnd: 18, nightStart: 18, nightEnd: 21, nightTa: 27 };
  const EFF = { shade: 0.34, open: 0.27 };   // 증발 효율 (보수적)
  const DUTY = 10 / 15;                       // 10분 가동 · 5분 정지
  const MODE = {
    mist:    { label: "미스트 + 하부 살수", color: "#0E7C86" },
    flush:   { label: "하부 살수만 (고습)", color: "#3B6FB6" },
    night:   { label: "야간 방열 살수",     color: "#6B5CA5" },
    off:     { label: "정지",               color: "#A3AAB6" },
    passive: { label: "쿨페이브먼트만 (소화전 없음)", color: "#B7832F" },
    fire:    { label: "119 출동 · 급수 차단", color: "#C0392B" },
  };
  const TYPE_LABEL = {
    A: "유형 A · 기존 그늘막 + 지상식 소화전",
    BC: "유형 B/C 미확정 · 그늘막 없음 + 지상식 소화전",
    D: "유형 D · 35m 내 지상식 소화전 없음",
  };
  // 물 사용량 가정값 (화면에서 조정 가능)
  const WATER = { nozzlesPerPole: 10, lpmPerNozzle: 0.15, flushMm: 1.0, sidewalkM: 3 };

  // Stull(2011) 습구온도
  function wetBulb(t, rh) {
    return t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) + Math.atan(t + rh) - Math.atan(rh - 1.676331)
      + 0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) - 4.686035;
  }
  // 기상청 여름철 체감온도식
  function apparent(ta, tw) {
    return -0.2442 + 0.55399 * tw + 0.45535 * ta - 0.0022 * tw * tw + 0.00278 * tw * ta + 3.0;
  }
  function modeOf(seg, ta, rh, hour) {
    if (seg.seg_type === "D") return "passive";
    const day = hour >= RULE.dayStart && hour < RULE.dayEnd;
    if (day && ta >= RULE.mistTa) return rh < RULE.mistRh ? "mist" : "flush";
    if (hour >= RULE.nightStart && hour < RULE.nightEnd && ta >= RULE.nightTa) return "night";
    return "off";
  }
  const effFor = (seg) => (seg.seg_type === "A" ? EFF.shade : EFF.open);
  function effect(ta, rh, eff) {
    const tw = wetBulb(ta, rh);
    const dTa = -eff * (ta - tw) * DUTY;
    const dTapp = apparent(ta + dTa, tw) - apparent(ta, tw);  // 등엔탈피 가정: 습구온도 유지
    return { dTa, dTapp, tw };
  }
  function idw(lat, lon, sensors, key) {
    let num = 0, den = 0;
    for (const s of sensors) {
      const d = Math.hypot((s.lat - lat) * 111000, (s.lon - lon) * 88000) + 30;
      const w = 1 / (d * d);
      num += w * s[key]; den += w;
    }
    return den ? num / den : null;
  }
  // 한 시간 동안 구간 하나가 쓰는 물(L)
  function waterLiters(seg, mode, W = WATER) {
    const poles = seg.fh_above_35m || 0;
    const flush = seg.len_m * W.sidewalkM * W.flushMm;            // 1mm = 1L/㎡, 시간당 1회
    if (mode === "mist") return poles * W.nozzlesPerPole * W.lpmPerNozzle * 60 * DUTY + flush;
    if (mode === "flush" || mode === "night") return flush;
    return 0;
  }
  async function getJSON(path, fallback) {
    try {
      const r = await fetch(path + "?v=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (e) {
      return fallback;
    }
  }
  const WD16 = ["북", "북북동", "북동", "동북동", "동", "동남동", "남동", "남남동", "남", "남남서", "남서", "서남서", "서", "서북서", "북서", "북북서"];
  const wdName = (deg) => (deg == null || Number.isNaN(deg) ? "–" : WD16[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]);


  // ---- 미스트 폴대와 냉각 분포 (3D 화면과 같은 가정) ----
  const PLUME = { Lc: 7, La0: 8, LaPerWs: 1.5, zc: 2.2, zs: 1.6, driftPerWs: 2.5, driftMax: 10, zone: 10, capFrac: 0.5, ampMax: 2.5 };
  const LAT0 = 37.585, KY = 110990, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), LON0 = 127.05;
  const xy = (lat, lon) => [(lon - LON0) * KX, (lat - LAT0) * KY];
  // 폴대 위치 = 35m 안 지상식 소화전을 보행축 선에 투영한 지점 (8m 안 중복 제거)
  function poles(segments) {
    const out = [];
    segments.forEach((s, si) => {
      if (s.seg_type === "D") return;
      const line = s.coords.map(([la, lo]) => xy(la, lo));
      (s.nozzles || []).forEach(([lat, lon]) => {
        const [px, py] = xy(lat, lon);
        let best = null, bd = 1e9;
        for (let i = 0; i < line.length - 1; i++) {
          const [ax, ay] = line[i], [bx, by] = line[i + 1], dx = bx - ax, dy = by - ay;
          const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
          const qx = ax + t * dx, qy = ay + t * dy, d = Math.hypot(px - qx, py - qy);
          if (d < bd) { bd = d; best = [qx, qy]; }
        }
        if (out.some((n) => Math.hypot(n.x - best[0], n.y - best[1]) < 8)) return;
        out.push({ x: best[0], y: best[1], seg: si });
      });
    });
    return out;
  }
  function wind(ws, wd) {
    ws = ws || 0;
    const to = wd == null ? 0 : ((wd + 180) % 360) * Math.PI / 180;
    return { ux: Math.sin(to), uy: Math.cos(to), drift: Math.min(PLUME.driftMax, PLUME.driftPerWs * ws), La: PLUME.La0 + PLUME.LaPerWs * ws };
  }
  function kern(n, x, y, z, w) {
    const dx = x - (n.x + w.ux * w.drift), dy = y - (n.y + w.uy * w.drift);
    const a = dx * w.ux + dy * w.uy, c = -dx * w.uy + dy * w.ux;
    return Math.exp(-(a * a) / (w.La * w.La) - (c * c) / (PLUME.Lc * PLUME.Lc) - ((z - PLUME.zc) / PLUME.zs) ** 2);
  }
  // 구간 평균 저감폭(모형값)이 폴대 반경 10m 보행 영역 평균과 같아지도록 진폭을 맞춘다
  function amps(results, P, w) {
    return results.map((r, si) => {
      if (r.mode !== "mist") return 0;
      const mine = P.filter((n) => n.seg === si);
      if (!mine.length) return 0;
      let sum = 0, cnt = 0;
      mine.forEach((n) => {
        for (let gx = -PLUME.zone; gx <= PLUME.zone; gx += 2) for (let gy = -PLUME.zone; gy <= PLUME.zone; gy += 2) {
          if (gx * gx + gy * gy > PLUME.zone * PLUME.zone) continue;
          const x = n.x + gx, y = n.y + gy;
          sum += mine.reduce((a, m) => a + kern(m, x, y, 1.5, w), 0); cnt++;
        }
      });
      const m = sum / cnt;
      return m > 0 ? Math.max(r.dTa / m, PLUME.ampMax * r.dTa) : 0;
    });
  }
  // 보행 경로를 따라 5m마다 체감온도 계산 (걷는 속도 1.2m/s)
  const HEAT = { appThreshold: 33, walk: 1.2, step: 5 };
  function routeProfile(results, segIdx, P, w) {
    const A = amps(results, P, w);
    const caps = results.map((r) => (r.mode === "mist" ? -PLUME.capFrac * (r.ta - r.tw) : 0));
    const pts = [];
    let dist = 0;
    segIdx.forEach((si) => {
      const r = results[si];
      if (r.ta == null) return;
      const line = r.seg.coords.map(([la, lo]) => xy(la, lo));
      for (let i = 0; i < line.length - 1; i++) {
        const [ax, ay] = line[i], [bx, by] = line[i + 1], L = Math.hypot(bx - ax, by - ay);
        for (let d = 0; d < L; d += HEAT.step) {
          const x = ax + (bx - ax) * d / L, y = ay + (by - ay) * d / L;
          let dt = 0, cap = 0;
          P.forEach((n) => { if (A[n.seg] && Math.abs(n.x - x) < 40 && Math.abs(n.y - y) < 40) { dt += A[n.seg] * kern(n, x, y, 1.5, w); cap = Math.min(cap, caps[n.seg]); } });
          if (dt < cap) dt = cap;
          const tw = r.tw;
          pts.push({ d: dist, seg: si, base: apparent(r.ta, tw), on: apparent(r.ta + dt, tw), dTa: dt });
          dist += HEAT.step;
        }
      }
    });
    const dtMin = HEAT.step / HEAT.walk / 60;
    const over = (k) => pts.reduce((a, p) => a + Math.max(0, p[k] - HEAT.appThreshold) * dtMin, 0);
    // 체감온도가 1℃ 이상 낮아지는 쉼 구간
    const rests = [];
    let cur = null;
    pts.forEach((p) => {
      if (p.base - p.on >= 1) { if (!cur) { cur = { from: p.d, to: p.d }; rests.push(cur); } cur.to = p.d + HEAT.step; }
      else cur = null;
    });
    return { pts, length: dist, minutes: dist / HEAT.walk / 60, overBase: over("base"), overOn: over("on"), rests,
             maxDrop: pts.reduce((a, p) => Math.max(a, p.base - p.on), 0) };
  }

  return { PLUME, HEAT, poles, wind, kern, amps, routeProfile, RULE, EFF, DUTY, MODE, TYPE_LABEL, WATER, wetBulb, apparent, modeOf, effFor, effect, idw, waterLiters, getJSON, wdName };
})();
