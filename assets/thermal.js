/* 보행자 열 스트레스: SOLWEIG(Lindberg 외 2008) 방식을 단순화한 평균복사온도 + UTCI
   - 그림자·하늘 조망률(SVF)·지표 유형은 scripts/solweig_pre.py로 2m 격자에 미리 계산 (data/solweig.json)
   - 여기서는 시각별 기상(기온·습도·풍속·일사·지면온도)을 받아 화소마다 평균복사온도와 UTCI를 계산한다 */
window.Thermal = (() => {
  "use strict";
  const SIG = 5.67e-8, AK = 0.7, EP = 0.97;
  // 지표 유형: 1 포장, 2 초지·농지, 3 숲, 4 물, 5 나지
  const ALB = { 1: 0.15, 2: 0.2, 3: 0.15, 4: 0.08, 5: 0.25 }, ALB_W = 0.2, EW = 0.9, EG = 0.95;
  let G = null;

  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  function load(sw) {
    if (!sw || !sw.n) return null;
    const idx = new Uint32Array(b64(sw.idx).buffer);
    const svf = b64(sw.svf), lc = b64(sw.lc), dist = b64(sw.dist), sh = b64(sw.shade);
    const nd = sw.dates.length, nh = sw.hours.length, n = sw.n, per = Math.ceil(n / 4);
    const shade = (di, hi, i) => (sh[(di * nh + hi) * per + (i >> 2)] >> (2 * (i & 3))) & 3;   // 0 햇빛, 1 나무 그늘, 2 건물 그늘
    // 화소 중심 좌표 (EPSG:5186 → 위경도는 네 모서리 선형 보간; 6km 범위라 오차 1m 미만)
    const [c0, c1, , c3] = sw.corners;
    const lat = new Float32Array(n), lon = new Float32Array(n), col = new Uint16Array(n), row = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      const r = Math.floor(idx[i] / sw.w), c = idx[i] % sw.w;
      row[i] = r; col[i] = c;
      const u = (c + 0.5) / sw.w, v = (r + 0.5) / sw.h;
      lon[i] = c0[0] + (c1[0] - c0[0]) * u + (c3[0] - c0[0]) * v;
      lat[i] = c0[1] + (c1[1] - c0[1]) * u + (c3[1] - c0[1]) * v;
    }
    const seg = sw.seg ? b64(sw.seg) : null;   // 가장 가까운 구간 번호 (미리 계산)
    G = { sw, n, svf, lc, dist, shade, lat, lon, row, col, nd, nh, seg };
    return G;
  }

  // 태양 위치 (NOAA 근사), hour는 한국 시각 소수
  function sun(doy, hour, la = 37.585, lo = 127.05) {
    const g = 2 * Math.PI / 365 * (doy - 1 + (hour - 12) / 24);
    const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    const dec = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    const ha = ((hour * 60 + eq + 4 * lo - 540) / 4 - 180) * Math.PI / 180, lat = la * Math.PI / 180;
    const cz = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
    return { alt: 90 - Math.acos(Math.max(-1, Math.min(1, cz))) * 180 / Math.PI };
  }
  // 수평면 전천일사 → 직달(법선)·산란 (Erbs 외 1982)
  function split(Gh, alt, doy) {
    const sb = Math.sin(alt * Math.PI / 180);
    if (Gh <= 0 || sb <= 0.03) return { I: 0, D: Math.max(0, Gh) };
    const I0 = 1367 * (1 + 0.033 * Math.cos(2 * Math.PI * doy / 365));
    const kt = Math.min(1, Gh / (I0 * sb));
    const kd = kt <= 0.22 ? 1 - 0.09 * kt : kt <= 0.8 ? 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4 : 0.165;
    const D = kd * Gh;
    return { I: Math.min(1000, (Gh - D) / sb), D };
  }
  const es = (t) => window.UTCI.esHpa(t);
  const K4 = (t) => SIG * (t + 273.15) ** 4;

  // met: {doy, hour, ta, rh, ws, sr(MJ/㎡), tg(지면온도)}; 반환: 시각별 공통값
  function prep(met) {
    const nearest = G.sw.dates.reduce((b, d, i) => (Math.abs(d.doy - met.doy) < Math.abs(G.sw.dates[b].doy - met.doy) ? i : b), 0);
    const hi = G.sw.hours.indexOf(met.hour);
    const s = sun(met.doy, met.hour - 0.5);
    const Gh = (met.sr || 0) * 1e6 / 3600;
    const { I, D } = split(Gh, s.alt, met.doy);
    const ea = met.rh / 100 * es(met.ta);
    const eSky = Math.min(1, 1.24 * Math.pow(ea / (met.ta + 273.15), 1 / 7));
    const a = Math.max(0, s.alt);
    const fp = 0.308 * Math.cos((a * (0.998 - a * a / 50000)) * Math.PI / 180);
    return { ...met, di: nearest, hi, alt: s.alt, I, D, Gh, Lsky: eSky * K4(met.ta), fp, sinb: Math.sin(a * Math.PI / 180), dayOk: hi >= 0 && Gh > 0 };
  }
  // 화소 i의 평균복사온도. wet: 바닥 살수로 노면이 젖었는지
  function tmrt(p, i, wet = false, pave = false) {
    const svf = G.svf[i] / 250, lc = G.lc[i] || 1;
    const sh = p.hi >= 0 ? G.shade(p.di, p.hi, i) : 2;
    const sdir = sh === 0 ? 1 : sh === 1 ? 0.03 : 0;
    const tgx = p.tg != null ? p.tg - p.ta : 0;
    let tg;
    if (lc === 4) tg = p.ta - 1;
    else if (lc === 1 || lc === 5) tg = p.ta + tgx * (0.15 + 0.85 * (sh === 0 ? 1 : 0));
    else tg = p.ta + tgx * (0.1 + 0.4 * (sh === 0 ? 1 : 0));
    const paved = lc === 1 || lc === 5;
    if (pave && paved && sh === 0) tg -= 6;                               // 쿨페이브먼트: 햇빛 받는 노면 최대 6℃ 하강 (Middel 외 2020)
    if (wet && paved) tg = Math.max(p.ta - 1, tg - 7);   // Hendel 외(2015) 노면 6~7.5℃ 하강
    const tw = p.ta + 0.2 * tgx;
    const alb = pave && paved ? 0.35 : ALB[lc] || 0.15;                   // 쿨페이브먼트 반사율
    const Kdn = p.D * svf + p.I * p.sinb * sdir;
    const Kup = alb * Kdn;
    const Klat = 0.5 * (p.D * svf + ALB_W * p.Gh * (1 - svf)) + 0.5 * Kup;
    const Lwall = EW * K4(tw), Lup = EG * K4(tg);
    const Ldn = svf * p.Lsky + (1 - svf) * Lwall;
    const Llat = 0.5 * (svf * p.Lsky + (1 - svf) * Lwall) + 0.5 * Lup;
    const S = AK * (0.06 * (Kdn + Kup) + 0.88 * Klat) + AK * p.fp * p.I * sdir + EP * (0.06 * (Ldn + Lup) + 0.88 * Llat);
    return Math.pow(S / (EP * SIG), 0.25) - 273.15;
  }
  // 미스트로 기온이 dT만큼 내려갈 때 습구온도를 유지한 상대습도
  function rhAfter(ta, rh, dT) {
    if (!dT) return rh;
    const tw = window.CoolModel.wetBulb(ta, rh);
    const ea = es(tw) - 0.000662 * 1013 * (ta + dT - tw);
    return Math.min(100, Math.max(1, ea / es(ta + dT) * 100));
  }
  function utciAt(p, i, dT = 0, wet = false, pave = false) {
    return window.UTCI.utci(p.ta + dT, tmrt(p, i, wet, pave), p.ws, rhAfter(p.ta, p.rh, dT));
  }
  return { load, prep, tmrt, utciAt, rhAfter, sun, get grid() { return G; } };
})();
