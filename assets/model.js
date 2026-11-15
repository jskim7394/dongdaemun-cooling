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

  return { RULE, EFF, DUTY, MODE, TYPE_LABEL, WATER, wetBulb, apparent, modeOf, effFor, effect, idw, waterLiters, getJSON, wdName };
})();
