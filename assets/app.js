/* 동대문구 소화전 연계 쿨링 보행축 대시보드 */
(() => {
  "use strict";
  const M = window.CoolModel;
  const { RULE, EFF, MODE, TYPE_LABEL } = M;
  const W = { ...M.WATER };

  // ---- 상태 ----
  const S = { view: "live", data: {}, dayIdx: 0, hour: 14, playing: null, selected: null, segLayers: [],
              focus: "all", fireMode: false, fire: null, results: [] };
  const $ = (id) => document.getElementById(id);
  const fmt = (v, d = 1, u = "") => (v == null || Number.isNaN(v) ? "–" : v.toFixed(d) + u);
  const signed = (v) => (v == null ? "–" : (v > 0 ? "+" : "") + v.toFixed(1) + "℃");
  const distM = (a, b) => Math.hypot((a[0] - b[0]) * 111000, (a[1] - b[1]) * 88300);

  // ---- 지도 ----
  let map, layerHyd, layerShade, layerTree, layerSdot, layerSeg, layerPop, layerFire;
  function initMap() {
    map = L.map("map", { zoomControl: true, scrollWheelZoom: false, preferCanvas: true, maxZoom: 19 }).setView([37.5835, 127.052], 14);
    // 배경지도: OpenStreetMap 표준 타일 (API 키 불필요, 19단계까지 확대 가능). 색은 CSS(.base-tiles)로 회색 처리
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, className: "base-tiles",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
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
    layerTree = L.layerGroup();
    layerShade = L.layerGroup().addTo(map);
    layerSdot = L.layerGroup().addTo(map);
    layerSeg = L.layerGroup().addTo(map);
    layerFire = L.layerGroup().addTo(map);

    (S.data.hydrants || []).forEach((h) => {
      L.circleMarker([h.lat, h.lon], {
        radius: h.type === 1 ? 2.6 : 2, weight: 0, fillOpacity: 0.55,
        fillColor: h.type === 1 ? "#1D3A66" : "#B9C2D0",
      }).bindTooltip((h.type === 1 ? "지상식 소화전 · " : "지하식 소화전 · ") + h.addr, { className: "t-lbl" })
        .addTo(layerHyd);
    });
    (S.data.trees || []).forEach((t) => {
      L.circleMarker([t[0], t[1]], { radius: 1.8, weight: 0, fillOpacity: 0.6, fillColor: "#3E8E5A" })
        .bindTooltip("가로수 · " + t[2], { className: "t-lbl" }).addTo(layerTree);
    });
    (S.data.shades || []).forEach((s) => {
      L.circleMarker([s.lat, s.lon], { radius: 4, weight: 1.5, color: "#2E7D4F", fillColor: "#fff", fillOpacity: 1 })
        .bindTooltip(s.type + " · " + s.name, { className: "t-lbl" }).addTo(layerShade);
    });
    S.data.segments.forEach((seg, i) => {
      const line = L.polyline(seg.coords, { weight: 7, opacity: 0.95, lineCap: "round", color: MODE.off.color })
        .on("click", () => selectSeg(i))
        .bindTooltip(`${seg.seg_id} · ${seg.landmark}`, { className: "t-lbl", sticky: true })
        .addTo(layerSeg);
      S.segLayers.push(line);
    });
    focusCorridor("all", false);

    $("lyr-hyd").onchange = (e) => toggle(layerHyd, e.target.checked);
    $("lyr-shade").onchange = (e) => toggle(layerShade, e.target.checked);
    $("lyr-tree").onchange = (e) => toggle(layerTree, e.target.checked);
    $("lyr-sdot").onchange = (e) => toggle(layerSdot, e.target.checked);
    $("lyr-pop").onchange = (e) => toggle(layerPop, e.target.checked);

    $("legend").innerHTML = Object.values(MODE)
      .map((m) => `<span><i style="background:${m.color}"></i>${m.label}</span>`).join("")
      + `<span><i style="background:#1D3A66;height:8px;width:8px;border-radius:50%"></i>지상식 소화전</span>`
      + `<span><i style="background:#fff;border:1.5px solid #2E7D4F;height:9px;width:9px;border-radius:50%"></i>그늘막</span>`
      + `<span><i style="background:#3E8E5A;height:6px;width:6px;border-radius:50%"></i>가로수</span>`
      + `<span><i style="background:linear-gradient(90deg,#EEF2F8,#41679F);width:28px"></i>생활인구 (짙을수록 많음)</span>`;

    // 119 출동 가정: 지도를 누른 지점 반경 500m 구간의 급수를 끊는다
    map.on("click", (e) => {
      if (!S.fireMode) return;
      S.fire = [e.latlng.lat, e.latlng.lng];
      render();
    });
  }
  function toggle(layer, on) { on ? layer.addTo(map) : map.removeLayer(layer); }

  function focusCorridor(c, animate = true) {
    S.focus = c;
    document.querySelectorAll("#focus-btns button").forEach((b) => b.classList.toggle("on", b.dataset.c === c));
    const segs = S.data.segments.filter((s) => c === "all" || s.corridor_id === c);
    const b = L.latLngBounds(segs.flatMap((s) => s.coords));
    map.fitBounds(b.pad(c === "all" ? 0.12 : 0.25), { animate });
    renderTable();
  }
  function selectSeg(i) {
    S.selected = i;
    render();
    const row = document.querySelector(`#seg-body tr[data-i="${i}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
  }

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

  // ---- 현재 시점의 센서·바람 ----
  function currentReadings() {
    const sensorsMeta = new Map(S.data.sensors.map((s) => [s.serial, s]));
    if (S.view === "live") {
      const rt = S.data.realtime || {};
      const list = (rt.sensors || [])
        .filter((s) => s.t != null && s.rh != null && sensorsMeta.has(s.serial))
        .map((s) => ({ ...sensorsMeta.get(s.serial), t: s.t, rh: s.rh }));
      const hour = rt.latest_obs ? parseInt(rt.latest_obs.slice(8, 10), 10) : new Date().getHours();
      const n = (S.data.kma && S.data.kma.ncst) || null;
      const wind = n && typeof n.WSD === "number" ? { ws: n.WSD, wd: n.VEC, src: `기상청 초단기실황 ${n.base.slice(8, 10)}시` } : null;
      return { hour, sensors: list, uniform: null, wind };
    }
    const day = S.data.replay.days[S.dayIdx];
    const rec = day && day.hours.find((h) => h.h === S.hour);
    if (!rec) return { hour: S.hour, sensors: [], uniform: null, wind: null };
    const wind = rec.ws != null ? { ws: rec.ws, wd: rec.wd, src: "기상청 서울 ASOS" } : null;
    const list = rec.s ? Object.entries(rec.s).filter(([k]) => sensorsMeta.has(k))
      .map(([k, v]) => ({ ...sensorsMeta.get(k), t: v[0], rh: v[1] })) : [];
    return { hour: S.hour, sensors: list, uniform: { t: rec.ta, rh: rec.rh }, wind };
  }

  // ---- 그리기 ----
  function render() {
    const R = currentReadings();
    const segs = S.data.segments;
    const results = segs.map((seg) => {
      const mid = seg.coords[Math.floor(seg.coords.length / 2)];
      let ta = null, rh = null;
      if (R.sensors.length) { ta = M.idw(mid[0], mid[1], R.sensors, "t"); rh = M.idw(mid[0], mid[1], R.sensors, "rh"); }
      else if (R.uniform) { ta = R.uniform.t; rh = R.uniform.rh; }
      if (ta == null) return { seg, mode: "off", ta: null, rh: null };
      let mode = M.modeOf(seg, ta, rh, R.hour);
      if (S.fire && seg.seg_type !== "D" && seg.coords.some((c) => distM(c, S.fire) <= 500)) mode = "fire";
      const e = M.effect(ta, rh, M.effFor(seg));
      return { seg, mode, ta, rh, tw: e.tw, dTa: mode === "mist" ? e.dTa : 0, dTapp: mode === "mist" ? e.dTapp : 0 };
    });
    S.results = results;

    results.forEach((r, i) => {
      S.segLayers[i].setStyle({ color: MODE[r.mode].color, weight: S.selected === i ? 11 : 7, dashArray: r.mode === "fire" ? "2 9" : null });
    });

    // 119 표시
    layerFire.clearLayers();
    if (S.fire) {
      L.circle(S.fire, { radius: 500, color: "#C0392B", weight: 1.5, fillOpacity: 0.06, dashArray: "4 4", interactive: false }).addTo(layerFire);
      L.circleMarker(S.fire, { radius: 6, color: "#fff", weight: 2, fillColor: "#C0392B", fillOpacity: 1 }).addTo(layerFire);
    }

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
    const nFire = results.filter((r) => r.mode === "fire").length;
    const nHyd = results.filter((r) => r.seg.seg_type !== "D").length;
    $("k-ta").textContent = fmt(ta, 1, "℃");
    $("k-rh").textContent = fmt(rh, 0, "%");
    $("k-tw").textContent = fmt(tw, 1, "℃");
    $("k-on").textContent = ok.length ? `${nMist} / ${nHyd}` : "–";
    $("k-wind").textContent = R.wind ? `${M.wdName(R.wind.wd)}풍 ${fmt(R.wind.ws, 1, " m/s")}` : "–";
    $("k-wind-note").textContent = R.wind ? `${R.wind.src} · 풍향 ${Math.round(R.wind.wd)}°` : (S.view === "live" ? "기상청 실황 수집 전" : "");
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
    else if (nFire) verdict = "";
    else verdict = `<b>정지.</b> 가동 조건(10~18시, 기온 ${RULE.mistTa}℃ 이상)에 해당하지 않습니다.`;
    if (nFire) verdict += ` <b class="fire-txt">119 출동 우선.</b> 출동 지점 500m 이내 ${nFire}개 구간의 소화전 급수를 자동 차단합니다.`;
    $("verdict").innerHTML = verdict;
    $("fire-note").hidden = !S.fireMode;
    $("fire-note").textContent = S.fire ? `출동 지점 반경 500m 안의 ${nFire}개 구간을 차단했습니다. 지도를 다시 누르면 지점이 바뀌고, 버튼을 한 번 더 누르면 해제됩니다.`
                                        : "지도에서 출동 지점을 누르세요. 반경 500m 안의 구간은 소화전 급수를 즉시 끊습니다.";

    // 예상 저감 (가동 시에만)
    const pick = (types) => {
      const rs = results.filter((r) => types.includes(r.seg.seg_type) && r.mode === "mist");
      if (!rs.length) return null;
      return { t: rs.reduce((a, r) => a + r.dTa, 0) / rs.length, a: rs.reduce((a, r) => a + r.dTapp, 0) / rs.length };
    };
    const ab = pick(["A"]), c = pick(["BC"]);
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
      document.querySelectorAll("#quick-hours button").forEach((b) => b.classList.toggle("on", +b.dataset.h === S.hour));
    }

    renderDetail(results);
    renderTable();
    updateChartCursor();
  }

  function renderTable() {
    const rs = S.results;
    if (!rs.length) return;
    $("seg-body").innerHTML = rs.map((r, i) => {
      if (S.focus !== "all" && r.seg.corridor_id !== S.focus) return "";
      const s = r.seg;
      const type = s.seg_type === "BC" ? `B/C<span class="muted">(${s.type_provisional} 잠정)</span>` : s.seg_type;
      return `<tr data-i="${i}" class="${S.selected === i ? "sel" : ""}">
        <td>${s.seg_id}</td><td class="loc">${s.landmark.replace(/\s*\(.*$/, "")}<span class="muted"> ${(s.landmark.match(/\((.*)\)/) || ["", ""])[1]}</span></td>
        <td>${type}</td><td><i class="dot" style="background:${MODE[r.mode].color}"></i>${MODE[r.mode].label.split(" (")[0]}</td>
        <td>${fmt(r.ta, 1, "℃")}</td><td>${r.mode === "mist" ? signed(r.dTa) : "–"}</td></tr>`;
    }).join("");
    document.querySelectorAll("#seg-body tr").forEach((tr) => { tr.onclick = () => { const i = +tr.dataset.i; selectSeg(i); map.panTo(S.data.segments[i].coords[2]); }; });
  }

  function renderDetail(results) {
    if (S.selected == null) return;
    const r = results[S.selected], s = r.seg;
    const eff = s.seg_type === "A" ? "그늘 0.34" : "노출 0.27";
    const type = s.seg_type === "BC" ? `${TYPE_LABEL.BC}<br><span class="muted">도로 위계로 본 잠정 구분: 유형 ${s.type_provisional}</span>` : TYPE_LABEL[s.seg_type];
    $("seg-detail").innerHTML = `
      <span class="badge">${s.seg_id}</span> ${s.landmark}
      <dl>
        <dt>보행축</dt><dd>${s.corridor_name}</dd>
        <dt>유형</dt><dd>${type}</dd>
        <dt>처방</dt><dd>${s.prescription}</dd>
        <dt>연장</dt><dd>${fmt(s.len_m, 0, "m")}</dd>
        <dt>보도 유효폭</dt><dd>미확인 (로드뷰 실측 필요)</dd>
        <dt>지상식 소화전</dt><dd>${s.fh_above_35m}기 (35m 이내, 지하식 ${s.fh_under_35m}기)</dd>
        <dt>기존 그늘막</dt><dd>${s.shade_count}개소 (45m 이내)</dd>
        <dt>가로수</dt><dd>${s.tree_count}주 (20m 이내)</dd>
        <dt>기준 S-DoT</dt><dd>${s.nearest_sdot} (${s.nearest_sdot_m}m)</dd>
        <dt>구간 사업비</dt><dd>${(s.capex_krw / 10000).toLocaleString()}만 원</dd>
        <dt>현재 판정</dt><dd>${MODE[r.mode].label}</dd>
        <dt>기온·습도</dt><dd>${fmt(r.ta, 1, "℃")} · ${fmt(r.rh, 0, "%")}</dd>
        <dt>예상 저감</dt><dd>${r.mode === "mist" ? `기온 ${signed(r.dTa)}, 체감 ${signed(r.dTapp)} (효율 ${eff})` : "가동하지 않음"}</dd>
      </dl>`;
  }

  // ---- 예보 기반 예측 ----
  function forecastHours() {
    const k = S.data.kma || {};
    const byTime = new Map();
    ((k.short && k.short.rows) || []).forEach((r) => { if (r.TMP != null) byTime.set(r.time, { time: r.time, t: r.TMP, rh: r.REH, ws: r.WSD, pop: r.POP }); });
    ((k.ultra && k.ultra.rows) || []).forEach((r) => { if (r.T1H != null) byTime.set(r.time, { time: r.time, t: r.T1H, rh: r.REH, ws: r.WSD, pop: (byTime.get(r.time) || {}).pop }); });
    return [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
  }
  function renderForecast() {
    const hrs = forecastHours();
    const k = S.data.kma || {};
    if (!hrs.length) {
      $("fc-strip").innerHTML = "";
      $("fc-body").innerHTML = `<tr><td colspan="6" class="muted">아직 기상청 예보를 받지 못했습니다. Actions에서 수집을 한 번 실행하면 표시됩니다.</td></tr>`;
      return;
    }
    const segs = S.data.segments;
    const modeAt = (h, dt) => M.modeOf({ seg_type: "A" }, h.t + dt, h.rh, +h.time.slice(8, 10));
    const days = {};
    hrs.forEach((h) => {
      const d = h.time.slice(0, 8);
      const o = days[d] || (days[d] = { tmax: -99, n: { mist: 0, flush: 0, night: 0 }, lo: 0, mid: 0, hi: 0, nLo: 0, nHi: 0 });
      o.tmax = Math.max(o.tmax, h.t);
      [-1, 0, 1].forEach((dt) => {
        const mode = modeAt(h, dt);
        const L = segs.reduce((a, s) => a + M.waterLiters(s, s.seg_type === "D" ? "passive" : mode, W), 0);
        const on = mode === "mist" || mode === "flush" || mode === "night";
        if (dt === 0) { o.mid += L; if (on) o.n[mode]++; }
        if (dt === -1) { o.lo += L; if (on) o.nLo++; }
        if (dt === 1) { o.hi += L; if (on) o.nHi++; }
      });
    });
    // 시간 띠
    let prevDay = "";
    $("fc-strip").innerHTML = hrs.map((h) => {
      const d = h.time.slice(0, 8), hh = +h.time.slice(8, 10), mode = modeAt(h, 0);
      const dayLbl = d !== prevDay ? `<span class="fc-day">${+d.slice(4, 6)}/${+d.slice(6, 8)}</span>` : "";
      prevDay = d;
      return `${dayLbl}<span class="fc-h" style="background:${MODE[mode].color}" title="${+d.slice(6, 8)}일 ${hh}시 · ${fmt(h.t, 0, "℃")} · 습도 ${fmt(h.rh, 0, "%")} · ${MODE[mode].label}">${hh % 3 === 0 ? hh : ""}</span>`;
    }).join("");
    $("fc-legend").innerHTML = ["mist", "flush", "night", "off"].map((m) => `<span><i style="background:${MODE[m].color}"></i>${MODE[m].label}</span>`).join("");
    const m3 = (l) => (l / 1000).toFixed(1);
    $("fc-body").innerHTML = Object.entries(days).map(([d, o]) => {
      const on = o.n.mist + o.n.flush + o.n.night;
      return `<tr><td>${+d.slice(4, 6)}월 ${+d.slice(6, 8)}일</td><td>${fmt(o.tmax, 0, "℃")}</td>
        <td>${o.n.mist}시간</td><td>${o.n.flush}시간</td><td>${o.n.night}시간</td>
        <td>${on || o.nHi ? `${m3(o.mid)}㎥ <span class="muted">(${m3(o.lo)}~${m3(o.hi)})</span>` : "가동 없음"}</td></tr>`;
    }).join("");
    const base = k.short ? k.short.base : k.ultra.base;
    $("fc-stamp").textContent = `기상청 단기예보 ${base.slice(4, 6)}/${base.slice(6, 8)} ${base.slice(8, 10)}시 발표 기준(동대문구 격자 61, 127). 소화전이 있는 ${segs.filter((s) => s.seg_type !== "D").length}개 구간에 같은 운전 규칙을 적용한 예보 기반 추정입니다.`;
  }
  function initAssume() {
    const bind = (id, key) => { const el = $(id); el.value = W[key]; el.oninput = () => { const v = parseFloat(el.value); if (!Number.isNaN(v)) { W[key] = v; renderForecast(); } }; };
    bind("w-noz", "nozzlesPerPole"); bind("w-lpm", "lpmPerNozzle"); bind("w-mm", "flushMm"); bind("w-sw", "sidewalkM");
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
             asos: hs.map((h) => (h.asos == null ? null : h.asos)), asosRh: hs.map((h) => (h.asos_rh == null ? null : h.asos_rh)) };
  }

  function updateCharts() {
    const d = seriesForView();
    const flags = d.t.map((t, i) => t >= RULE.mistTa && d.rh[i] < RULE.mistRh && d.hours[i] >= RULE.dayStart && d.hours[i] < RULE.dayEnd);
    [[chartT, d.t, RULE.mistTa, d.asos], [chartRH, d.rh, RULE.mistRh, d.asosRh]].forEach(([c, ys, th, asos]) => {
      c.data.labels = d.labels;
      c.data.datasets[0].data = ys;
      c.data.datasets[1].data = ys.map(() => th);
      c.data.datasets[2].data = asos || [];
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
      ? "실시간 자료: 서울 열린데이터광장 S-DoT 환경정보(1시간 평균)와 기상청 초단기실황·단기예보, GitHub Actions로 매시간 수집."
      : "재생 자료: " + (S.data.replay.source || "") + ". " + (S.data.replay.note || "");
    updateCharts();
    render();
  }
  function stopPlay() {
    if (S.playing) { clearInterval(S.playing); S.playing = null; }
    $("play").textContent = "재생"; $("play").classList.remove("on");
  }

  async function init() {
    const g = M.getJSON;
    const [segments, sensors, shades, hydrants, replay, realtime, population, trees, kma] = await Promise.all([
      g("data/segments.json", []), g("data/sensors.json", []),
      g("data/shades.json", []), g("data/hydrants.json", []),
      g("data/replay.json", { days: [] }), g("data/realtime.json", {}),
      g("data/population.json", null), g("data/trees.json", []), g("data/kma.json", {}),
    ]);
    S.data = { segments, sensors, shades, hydrants, replay, realtime, population, trees, kma };

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
    document.querySelectorAll("#quick-hours button").forEach((b) => { b.onclick = () => { stopPlay(); S.hour = +b.dataset.h; $("hour").value = S.hour; render(); }; });
    document.querySelectorAll("#focus-btns button").forEach((b) => { b.onclick = () => focusCorridor(b.dataset.c); });
    $("fire-btn").onclick = () => {
      S.fireMode = !S.fireMode; if (!S.fireMode) S.fire = null;
      $("fire-btn").classList.toggle("on", S.fireMode);
      $("map").classList.toggle("picking", S.fireMode);
      render();
    };
    $("play").onclick = () => {
      if (S.playing) return stopPlay();
      $("play").textContent = "일시정지"; $("play").classList.add("on");
      S.playing = setInterval(() => {
        S.hour = (S.hour + 1) % 24; $("hour").value = S.hour; render();
      }, 900);
    };
    $("tab-live").onclick = () => setView("live");
    $("tab-replay").onclick = () => setView("replay");

    initAssume();
    renderForecast();
    const hasLive = realtime && realtime.sensors && realtime.sensors.length;
    setView(hasLive ? "live" : "replay");
  }

  init();
})();
