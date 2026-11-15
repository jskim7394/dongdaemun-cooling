/* 동대문구 소화전 연계 쿨링 보행축 대시보드 */
(() => {
  "use strict";

  // ---- 운전 규칙과 산정 계수 ----
  const RULE = { mistTa: 30, mistRh: 70, dayStart: 10, dayEnd: 18, nightStart: 18, nightEnd: 21, nightTa: 27 };
  const EFF = { shade: 0.34, open: 0.27 };   // 증발 효율 (보수적)
  const DUTY = 10 / 15;                       // 10분 가동 · 5분 정지
  const MODE = {
    mist:    { label: "미스트 + 하부 살수", color: "#0E7C86" },
    flush:   { label: "하부 살수만 (고습)", color: "#3B6FB6" },
    night:   { label: "야간 방열 살수",     color: "#6B5CA5" },
    off:     { label: "정지",               color: "#A3AAB6" },
    passive: { label: "쿨페이브먼트만 (소화전 없음)", color: "#B7832F" },
  };
  const TYPE_LABEL = { A: "유형 A · 기존 그늘막 + 지상식 소화전", B: "유형 B · 그늘막 신설 + 지상식 소화전",
                       C: "유형 C · 협소 보도, 그늘막 불가", D: "유형 D · 인근 지상식 소화전 없음" };

  // ---- 열환경 계산 ----
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
  function effect(ta, rh, eff) {
    const tw = wetBulb(ta, rh);
    const dTa = -eff * (ta - tw) * DUTY;
    const dTapp = apparent(ta + dTa, tw) - apparent(ta, tw);  // 등엔탈피 가정: 습구온도 유지
    return { dTa, dTapp, tw };
  }

  // ---- 상태 ----
  const S = { view: "live", data: {}, dayIdx: 0, hour: 14, playing: null, selected: null, segLayers: [] };
  const $ = (id) => document.getElementById(id);
  const fmt = (v, d = 1, u = "") => (v == null || Number.isNaN(v) ? "–" : v.toFixed(d) + u);
  const signed = (v) => (v == null ? "–" : (v > 0 ? "+" : "") + v.toFixed(1) + "℃");

  async function getJSON(path, fallback) {
    try {
      const r = await fetch(path + "?v=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (e) {
      return fallback;
    }
  }

  // ---- 지도 ----
  let map, layerHyd, layerShade, layerSdot, layerSeg, layerPop;
  function initMap() {
    map = L.map("map", { zoomControl: true, scrollWheelZoom: false, preferCanvas: true }).setView([37.5835, 127.052], 14);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19, subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    }).addTo(map);
    map.createPane("popPane"); map.getPane("popPane").style.zIndex = 350;
    layerPop = L.geoJSON(S.data.population || { type: "FeatureCollection", features: [] }, {
      pane: "popPane",
      style: () => ({ weight: 0.4, color: "#ffffff", fillOpacity: 0.55, fillColor: "#EEF1F5" }),
      onEachFeature: (f, l) => l.on("mouseover", () => {
        const h = currentHour(); const p = f.properties;
        l.bindTooltip(`250m 격자 ${p.id}<br>${h}시 평균 생활인구 ${Math.round(p.pop[h]).toLocaleString()}명` +
          (p.old65 != null ? `<br>65세 이상 비중(14~17시) ${(p.old65 * 100).toFixed(0)}%` : ""), { className: "t-lbl", sticky: true }).openTooltip();
      }),
    });
    layerHyd = L.layerGroup();
    layerShade = L.layerGroup().addTo(map);
    layerSdot = L.layerGroup().addTo(map);
    layerSeg = L.layerGroup().addTo(map);

    (S.data.hydrants || []).forEach((h) => {
      L.circleMarker([h.lat, h.lon], {
        radius: h.type === 1 ? 2.6 : 2, weight: 0, fillOpacity: 0.55,
        fillColor: h.type === 1 ? "#1D3A66" : "#B9C2D0",
      }).bindTooltip((h.type === 1 ? "지상식 소화전 · " : "지하식 소화전 · ") + h.addr, { className: "t-lbl" })
        .addTo(layerHyd);
    });
    (S.data.shades || []).forEach((s) => {
      L.circleMarker([s.lat, s.lon], { radius: 4, weight: 1.5, color: "#2E7D4F", fillColor: "#fff", fillOpacity: 1 })
        .bindTooltip(s.type + " · " + s.name, { className: "t-lbl" }).addTo(layerShade);
    });
    S.data.segments.forEach((seg, i) => {
      const line = L.polyline(seg.coords, { weight: 7, opacity: 0.95, lineCap: "round", color: MODE.off.color })
        .on("click", () => { S.selected = i; render(); })
        .addTo(layerSeg);
      S.segLayers.push(line);
    });
    const b = L.latLngBounds(S.data.segments.flatMap((s) => s.coords));
    map.fitBounds(b.pad(0.15));

    $("lyr-hyd").onchange = (e) => toggle(layerHyd, e.target.checked);
    $("lyr-shade").onchange = (e) => toggle(layerShade, e.target.checked);
    $("lyr-sdot").onchange = (e) => toggle(layerSdot, e.target.checked);
    $("lyr-pop").onchange = (e) => toggle(layerPop, e.target.checked);

    $("legend").innerHTML = Object.values(MODE)
      .map((m) => `<span><i style="background:${m.color}"></i>${m.label}</span>`).join("")
      + `<span><i style="background:#1D3A66;height:8px;width:8px;border-radius:50%"></i>지상식 소화전</span>`
      + `<span><i style="background:#fff;border:1.5px solid #2E7D4F;height:9px;width:9px;border-radius:50%"></i>그늘막</span>`
      + `<span><i style="background:linear-gradient(90deg,#EEF2F8,#41679F);width:28px"></i>생활인구 (짙을수록 많음)</span>`;
  }
  function toggle(layer, on) { on ? layer.addTo(map) : map.removeLayer(layer); }

  // ---- 생활인구 ----
  const POP_BINS = [500, 1000, 2000, 3000];
  const POP_COLORS = ["#EEF2F8", "#D3DEEE", "#A9BFDF", "#7396C6", "#41679F"];
  function popColor(v) { let i = 0; while (i < POP_BINS.length && v >= POP_BINS[i]) i++; return POP_COLORS[i]; }
  function currentHour() {
    if (S.view === "live") { const lo = S.data.realtime && S.data.realtime.latest_obs; return lo ? parseInt(lo.slice(8, 10), 10) : new Date().getHours(); }
    return S.hour;
  }
  function nearCorridorGrids() {
    // 보행축 구간 중심에서 150m 이내에 중심이 있는 격자
    if (S.nearGrids) return S.nearGrids;
    const mids = S.data.segments.map((g) => g.coords[Math.floor(g.coords.length / 2)]);
    S.nearGrids = (S.data.population ? S.data.population.features : []).filter((f) => {
      const ring = f.geometry.coordinates[0];
      const lat = ring.reduce((a, c) => a + c[1], 0) / ring.length, lon = ring.reduce((a, c) => a + c[0], 0) / ring.length;
      return mids.some((m) => Math.hypot((m[0] - lat) * 111000, (m[1] - lon) * 88000) < 150);
    });
    return S.nearGrids;
  }

  // ---- 현재 시점의 센서 값 ----
  function currentReadings() {
    // 반환: { hour, label, sensors: [{lat,lon,t,rh,serial}], uniform: {t,rh} | null }
    const sensorsMeta = new Map(S.data.sensors.map((s) => [s.serial, s]));
    if (S.view === "live") {
      const rt = S.data.realtime || {};
      const list = (rt.sensors || [])
        .filter((s) => s.t != null && s.rh != null && sensorsMeta.has(s.serial))
        .map((s) => ({ ...sensorsMeta.get(s.serial), t: s.t, rh: s.rh }));
      const hour = rt.latest_obs ? parseInt(rt.latest_obs.slice(8, 10), 10) : new Date().getHours();
      return { hour, sensors: list, uniform: null, raw: rt.sensors || [] };
    }
    const day = S.data.replay.days[S.dayIdx];
    const rec = day && day.hours.find((h) => h.h === S.hour);
    if (!rec) return { hour: S.hour, sensors: [], uniform: null, raw: [] };
    if (rec.s) {
      const list = Object.entries(rec.s).filter(([k]) => sensorsMeta.has(k))
        .map(([k, v]) => ({ ...sensorsMeta.get(k), t: v[0], rh: v[1] }));
      return { hour: S.hour, sensors: list, uniform: { t: rec.ta, rh: rec.rh }, raw: [] };
    }
    return { hour: S.hour, sensors: [], uniform: { t: rec.ta, rh: rec.rh }, raw: [] };
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

  // ---- 그리기 ----
  function render() {
    const R = currentReadings();
    const segs = S.data.segments;
    const results = segs.map((seg) => {
      const mid = seg.coords[Math.floor(seg.coords.length / 2)];
      let ta = null, rh = null;
      if (R.sensors.length) { ta = idw(mid[0], mid[1], R.sensors, "t"); rh = idw(mid[0], mid[1], R.sensors, "rh"); }
      else if (R.uniform) { ta = R.uniform.t; rh = R.uniform.rh; }
      if (ta == null) return { seg, mode: "off", ta: null, rh: null };
      const mode = modeOf(seg, ta, rh, R.hour);
      const eff = seg.seg_type === "C" ? EFF.open : EFF.shade;
      const e = effect(ta, rh, eff);
      return { seg, mode, ta, rh, tw: e.tw, dTa: mode === "mist" ? e.dTa : 0, dTapp: mode === "mist" ? e.dTapp : 0 };
    });

    results.forEach((r, i) => {
      S.segLayers[i].setStyle({ color: MODE[r.mode].color, weight: S.selected === i ? 11 : 7 });
    });

    // 센서 표시
    layerSdot.clearLayers();
    const valid = new Map(R.sensors.map((s) => [s.serial, s]));
    S.data.sensors.forEach((s) => {
      const v = valid.get(s.serial);
      const m = L.circleMarker([s.lat, s.lon], {
        radius: 6, weight: 2, color: v ? "#142A52" : "#A3AAB6", fillColor: "#fff", fillOpacity: 1,
        dashArray: v ? null : "2 2",
      });
      const txt = v ? `${fmt(v.t, 1, "℃")} · ${fmt(v.rh, 0, "%")}` : "정상값 없음";
      m.bindTooltip(`S-DoT ${s.serial}<br>${s.addr}<br>${txt}`, { className: "t-lbl" });
      if (v) m.bindTooltip(fmt(v.t, 1, "℃"), { permanent: true, direction: "top", offset: [0, -6], className: "t-lbl" });
      m.addTo(layerSdot);
    });

    // 평균 지표
    const ok = results.filter((r) => r.ta != null);
    const avg = (k) => (ok.length ? ok.reduce((a, r) => a + r[k], 0) / ok.length : null);
    const ta = avg("ta"), rh = avg("rh"), tw = ok.length ? avg("tw") : null;
    const nMist = results.filter((r) => r.mode === "mist").length;
    const nHyd = results.filter((r) => r.seg.seg_type !== "D").length;
    $("k-ta").textContent = fmt(ta, 1, "℃");
    $("k-rh").textContent = fmt(rh, 0, "%");
    $("k-tw").textContent = fmt(tw, 1, "℃");
    $("k-on").textContent = ok.length ? `${nMist} / ${nHyd}` : "–";
    const hh = currentHour();
    if (layerPop) layerPop.setStyle((f) => ({ weight: 0.4, color: "#ffffff", fillOpacity: 0.55, fillColor: popColor(f.properties.pop[hh]) }));
    const near = nearCorridorGrids();
    const popNear = near.reduce((a, f) => a + f.properties.pop[hh], 0);
    $("k-pop").textContent = near.length ? Math.round(popNear).toLocaleString() + "명" : "–";
    $("k-pop-note").textContent = near.length ? `보행축 150m 이내 250m 격자 ${near.length}개, ${hh}시 평균 생활인구(체류 인구 상한)` : "";

    let verdict = "";
    if (ta == null) verdict = S.view === "live" ? "아직 수집된 실시간 자료가 없습니다. Actions에서 수집을 한 번 실행하세요." : "선택한 시각의 자료가 없습니다.";
    else if (nMist) verdict = `<b>미스트 가동.</b> 기온 ${RULE.mistTa}℃ 이상, 상대습도 ${RULE.mistRh}% 미만 조건을 충족했습니다.`;
    else if (results.some((r) => r.mode === "flush")) verdict = `<b>하부 살수만 운영.</b> 기온은 높지만 상대습도가 ${RULE.mistRh}% 이상이라 미스트를 멈췄습니다.`;
    else if (results.some((r) => r.mode === "night")) verdict = `<b>야간 방열 살수.</b> 저녁 기온이 ${RULE.nightTa}℃ 이상 유지되고 있습니다.`;
    else verdict = `<b>정지.</b> 가동 조건(10~18시, 기온 ${RULE.mistTa}℃ 이상)에 해당하지 않습니다.`;
    $("verdict").innerHTML = verdict;

    // 예상 저감 (가동 시에만)
    const pick = (types) => {
      const rs = results.filter((r) => types.includes(r.seg.seg_type) && r.mode === "mist");
      if (!rs.length) return null;
      return { t: rs.reduce((a, r) => a + r.dTa, 0) / rs.length, a: rs.reduce((a, r) => a + r.dTapp, 0) / rs.length };
    };
    const ab = pick(["A", "B"]), c = pick(["C"]);
    $("e-ab-t").textContent = ab ? signed(ab.t) : "가동 안 함";
    $("e-ab-a").textContent = ab ? signed(ab.a) : "–";
    $("e-c-t").textContent = c ? signed(c.t) : "가동 안 함";
    $("e-c-a").textContent = c ? signed(c.a) : "–";

    // 시각 표시
    if (S.view === "live") {
      const rt = S.data.realtime || {};
      const lo = rt.latest_obs;
      const when = lo ? `${lo.slice(0, 4)}-${lo.slice(4, 6)}-${lo.slice(6, 8)} ${lo.slice(8, 10)}시` : "–";
      let stale = "";
      if (rt.updated_utc) {
        const age = (Date.now() - Date.parse(rt.updated_utc.replace("Z", ":00Z"))) / 3.6e6;
        if (age > 3) stale = " · 마지막 수집 후 " + Math.round(age) + "시간 경과";
      }
      $("stamp").textContent = lo ? `최근 관측 ${when} · 정상값 센서 ${R.sensors.length}대${stale}` : "실시간 자료 수집 전입니다.";
    } else {
      const day = S.data.replay.days[S.dayIdx];
      $("stamp").textContent = day ? `${day.label} · ${S.hour}시` : "재생 자료가 없습니다.";
      $("hour-label").textContent = S.hour + "시";
    }

    renderDetail(results);
    updateChartCursor();
  }

  function renderDetail(results) {
    if (S.selected == null) return;
    const r = results[S.selected], s = r.seg;
    const eff = s.seg_type === "C" ? "노출 0.27" : "그늘 0.34";
    $("seg-detail").innerHTML = `
      <span class="badge">${s.seg_id}</span> ${s.landmark}
      <dl>
        <dt>유형</dt><dd>${TYPE_LABEL[s.seg_type] || s.seg_type}</dd>
        <dt>처방</dt><dd>${s.prescription}</dd>
        <dt>보도 유효폭</dt><dd>${fmt(s.sidewalk_width_m, 1, "m")}</dd>
        <dt>지상식 소화전</dt><dd>${s.fh_above_35m}기 (35m 이내)</dd>
        <dt>기존 그늘막</dt><dd>${s.shade_count}개소</dd>
        <dt>구간 사업비</dt><dd>${(s.capex_krw / 10000).toLocaleString()}만 원</dd>
        <dt>현재 판정</dt><dd>${MODE[r.mode].label}</dd>
        <dt>기온·습도</dt><dd>${fmt(r.ta, 1, "℃")} · ${fmt(r.rh, 0, "%")}</dd>
        <dt>예상 저감</dt><dd>${r.mode === "mist" ? `기온 ${signed(r.dTa)}, 체감 ${signed(r.dTapp)} (효율 ${eff})` : "가동하지 않음"}</dd>
      </dl>`;
  }

  // ---- 차트 ----
  let chartT, chartRH;
  const bandPlugin = {
    id: "bands",
    beforeDatasetsDraw(chart, _args, opts) {
      const flags = opts.flags || [];
      const { ctx, chartArea: a, scales: { x } } = chart;
      if (!a) return;
      ctx.save();
      ctx.fillStyle = "rgba(14,124,134,0.12)";
      const n = flags.length, step = n > 1 ? (x.getPixelForValue(1) - x.getPixelForValue(0)) : a.width;
      flags.forEach((f, i) => {
        if (!f) return;
        const cx = x.getPixelForValue(i);
        ctx.fillRect(Math.max(a.left, cx - step / 2), a.top, Math.min(step, a.right - (cx - step / 2)), a.bottom - a.top);
      });
      const cur = opts.cursor;
      if (cur != null && cur >= 0) {
        const cx = x.getPixelForValue(cur);
        ctx.strokeStyle = "#142A52"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(cx, a.top); ctx.lineTo(cx, a.bottom); ctx.stroke();
      }
      ctx.restore();
    },
  };
  Chart.register(bandPlugin);
  Chart.defaults.font.family = 'Pretendard, "Malgun Gothic", sans-serif';
  Chart.defaults.color = "#4A5160";

  function makeChart(id, label, color, threshold, unit, yMin, yMax) {
    return new Chart($(id), {
      type: "line",
      data: { labels: [], datasets: [
        { label, data: [], borderColor: color, borderWidth: 2, pointRadius: 0, tension: 0.25 },
        { label: "기준선", data: [], borderColor: "#9AA3AF", borderWidth: 1, borderDash: [4, 4], pointRadius: 0 },
        { label: "기상청 ASOS", data: [], borderColor: "#6B7280", borderWidth: 1.5, borderDash: [2, 3], pointRadius: 0, tension: 0.25 },
      ] },
      options: {
        maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          title: { display: true, text: label, align: "start", color: "#142A52", font: { weight: "600", size: 13 } },
          tooltip: { callbacks: { label: (c) => c.datasetIndex === 0 ? `S-DoT ${label} ${c.parsed.y.toFixed(1)}${unit}` : c.datasetIndex === 2 ? `ASOS ${c.parsed.y.toFixed(1)}${unit}` : `기준 ${threshold}${unit}` } },
          bands: { flags: [], cursor: null },
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 9, autoSkip: true } },
          y: { suggestedMin: yMin, suggestedMax: yMax, grid: { color: "#EEF1F5" }, ticks: { callback: (v) => v + unit } },
        },
      },
    });
  }

  function seriesForView() {
    if (S.view === "live") {
      const ser = (S.data.realtime && S.data.realtime.series) || [];
      return {
        labels: ser.map((p) => `${p.time.slice(6, 8)}일 ${p.time.slice(8, 10)}시`),
        t: ser.map((p) => p.t), rh: ser.map((p) => p.rh),
        hours: ser.map((p) => parseInt(p.time.slice(8, 10), 10)),
      };
    }
    const day = S.data.replay.days[S.dayIdx];
    const hs = day ? day.hours : [];
    return { labels: hs.map((h) => h.h + "시"), t: hs.map((h) => h.ta), rh: hs.map((h) => h.rh), hours: hs.map((h) => h.h),
             asos: hs.map((h) => (h.asos == null ? null : h.asos)) };
  }

  function updateCharts() {
    const d = seriesForView();
    const flags = d.t.map((t, i) => t >= RULE.mistTa && d.rh[i] < RULE.mistRh && d.hours[i] >= RULE.dayStart && d.hours[i] < RULE.dayEnd);
    [[chartT, d.t, RULE.mistTa], [chartRH, d.rh, RULE.mistRh]].forEach(([c, ys, th]) => {
      c.data.labels = d.labels;
      c.data.datasets[0].data = ys;
      c.data.datasets[1].data = ys.map(() => th);
      if (c === chartT) c.data.datasets[2].data = d.asos || [];
      c.options.plugins.bands.flags = flags;
    });
    $("chart-title").textContent = S.view === "live" ? "최근 48시간 기온과 상대습도 (동대문구 S-DoT 평균)" : "하루 동안의 기온과 상대습도";
    updateChartCursor();
  }
  function updateChartCursor() {
    if (!chartT) return;
    const d = seriesForView();
    const cur = S.view === "live" ? d.labels.length - 1 : d.hours.indexOf(S.hour);
    [chartT, chartRH].forEach((c) => { c.options.plugins.bands.cursor = cur; c.update("none"); });
  }

  // ---- 화면 전환 ----
  function setView(v) {
    S.view = v;
    $("tab-live").classList.toggle("on", v === "live");
    $("tab-replay").classList.toggle("on", v === "replay");
    $("tab-live").setAttribute("aria-selected", v === "live");
    $("tab-replay").setAttribute("aria-selected", v === "replay");
    $("replay-ctrl").hidden = v !== "replay";
    stopPlay();
    $("src-note").textContent = v === "live"
      ? "실시간 자료: 서울 열린데이터광장 S-DoT 환경정보(1시간 평균), GitHub Actions로 매시간 수집."
      : "재생 자료: " + (S.data.replay.source || "") + ". " + (S.data.replay.note || "");
    updateCharts();
    render();
  }
  function stopPlay() {
    if (S.playing) { clearInterval(S.playing); S.playing = null; }
    $("play").textContent = "재생"; $("play").classList.remove("on");
  }

  async function init() {
    const [segments, sensors, shades, hydrants, replay, realtime, population] = await Promise.all([
      getJSON("data/segments.json", []), getJSON("data/sensors.json", []),
      getJSON("data/shades.json", []), getJSON("data/hydrants.json", []),
      getJSON("data/replay.json", { days: [] }), getJSON("data/realtime.json", {}),
      getJSON("data/population.json", null),
    ]);
    S.data = { segments, sensors, shades, hydrants, replay, realtime, population };

    initMap();
    chartT = makeChart("chart-t", "기온", "#C0392B", RULE.mistTa, "℃", 22, 38);
    chartRH = makeChart("chart-rh", "상대습도", "#3B6FB6", RULE.mistRh, "%", 30, 100);

    const sel = $("day-select");
    sel.innerHTML = replay.days.map((d, i) => `<option value="${i}">${d.label}</option>`).join("");
    let hot = 0;
    replay.days.forEach((d, i) => { if (Math.max(...d.hours.map((h) => h.ta)) > Math.max(...replay.days[hot].hours.map((h) => h.ta))) hot = i; });
    S.dayIdx = hot; sel.value = String(hot);
    sel.onchange = () => { S.dayIdx = +sel.value; updateCharts(); render(); };
    $("hour").oninput = (e) => { S.hour = +e.target.value; render(); };
    $("play").onclick = () => {
      if (S.playing) return stopPlay();
      $("play").textContent = "일시정지"; $("play").classList.add("on");
      S.playing = setInterval(() => {
        S.hour = (S.hour + 1) % 24; $("hour").value = S.hour; render();
      }, 900);
    };
    $("tab-live").onclick = () => setView("live");
    $("tab-replay").onclick = () => setView("replay");

    const hasLive = realtime && realtime.sensors && realtime.sensors.length;
    setView(hasLive ? "live" : "replay");
  }

  init();
})();
