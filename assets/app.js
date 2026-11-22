/* 동대문구 소화전 연계 쿨링 보행축 대시보드 */
(() => {
  "use strict";
  const M = window.CoolModel;
  const { RULE, MODE, TYPE_LABEL } = M;
  const W = { ...M.WATER };
  const SHORT = { mist: "미스트", flush: "살수만", night: "저녁 살수", off: "정지", passive: "쿨페이브먼트", fire: "119 차단", rain: "강우 정지" };
  const CNAME = { all: "보행축 전체", C1: "C1 왕산로", C2: "C2 전농로·사가정로", C3: "C3 회기로·이문로" };

  const S = { view: "live", data: {}, dayIdx: 0, hour: 14, playing: null, selected: null, segLayers: [],
              focus: "all", routeC: "C1", fireMode: false, fire: null, results: [], R: null, nearGrids: {} };
  const $ = (id) => document.getElementById(id);
  const fmt = (v, d = 1, u = "") => (v == null || Number.isNaN(v) ? "–" : v.toFixed(d) + u);
  const signed = (v, u = "℃") => (v == null ? "–" : (v > 0 ? "+" : "") + v.toFixed(1) + u);
  const distM = (a, b) => Math.hypot((a[0] - b[0]) * 111000, (a[1] - b[1]) * 88300);
  const inFocus = (seg) => S.focus === "all" || seg.corridor_id === S.focus;
  const focusName = () => CNAME[S.focus];

  // ---------------------------------------------------------------- 지도
  let layerHL, map, layerHyd, layerShade, layerTree, layerSdot, layerSeg, layerPop, layerFire;
  function initMap() {
    const bnd = S.data.boundary;
    map = L.map("map", { zoomControl: true, scrollWheelZoom: false, preferCanvas: true, maxZoom: 19, minZoom: 12 }).setView([37.5835, 127.052], 14);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, className: "base-tiles",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    // 동대문구 바깥을 흐리게 가린다
    if (bnd) {
      const ring = bnd.geometry.coordinates[0].map(([lo, la]) => [la, lo]);
      const world = [[33, 120], [33, 135], [43, 135], [43, 120]];
      map.createPane("maskPane"); map.getPane("maskPane").style.zIndex = 330; map.getPane("maskPane").style.pointerEvents = "none";
      L.polygon([world, ring], { pane: "maskPane", stroke: false, fillColor: "#F4F6FA", fillOpacity: 0.82, interactive: false }).addTo(map);
      L.polyline(ring.concat([ring[0]]), { pane: "maskPane", color: "#142A52", weight: 1.6, opacity: 0.8, dashArray: "5 4", interactive: false }).addTo(map);
      map.setMaxBounds(L.latLngBounds(ring).pad(0.35));
    }
    map.createPane("popPane"); map.getPane("popPane").style.zIndex = 340;
    map.createPane("vulnPane"); map.getPane("vulnPane").style.zIndex = 336; map.getPane("vulnPane").style.pointerEvents = "none";
    map.createPane("heatPane"); map.getPane("heatPane").style.zIndex = 345; map.getPane("heatPane").style.pointerEvents = "none";
    layerPop = L.geoJSON(S.data.population || { type: "FeatureCollection", features: [] }, {
      pane: "popPane",
      style: () => ({ weight: 0.4, color: "#ffffff", fillOpacity: 0.55, fillColor: "#EEF1F5" }),
      onEachFeature: (f, l) => l.on("mouseover", () => {
        const h = S.R ? S.R.hour : 14; const p = f.properties;
        l.bindTooltip(`250m 격자 · ${h}시 평균 생활인구 ${Math.round(p.pop[h]).toLocaleString()}명` +
          (p.old65 != null ? `<br>65세 이상 비중(14~17시) ${(p.old65 * 100).toFixed(0)}%` : ""), { className: "t-lbl", sticky: true }).openTooltip();
      }),
    });
    layerHyd = L.layerGroup(); layerTree = L.layerGroup();
    layerShade = L.layerGroup().addTo(map); layerSdot = L.layerGroup().addTo(map);
    layerHL = L.layerGroup().addTo(map); layerSeg = L.layerGroup().addTo(map); layerFire = L.layerGroup().addTo(map);

    (S.data.hydrants || []).forEach((h) => {
      L.circleMarker([h.lat, h.lon], { radius: h.type === 1 ? 2.6 : 2, weight: 0, fillOpacity: 0.55, fillColor: h.type === 1 ? "#1D3A66" : "#B9C2D0" })
        .bindTooltip((h.type === 1 ? "지상 소화전 · " : "지하 소화전 · ") + h.addr, { className: "t-lbl" }).addTo(layerHyd);
    });
    (S.data.trees || []).forEach((t) => {
      L.circleMarker([t[0], t[1]], { radius: 1.8, weight: 0, fillOpacity: 0.6, fillColor: "#3E8E5A" })
        .bindTooltip("가로수 · " + t[2], { className: "t-lbl" }).addTo(layerTree);
    });
    (S.data.shades || []).forEach((s) => {
      L.circleMarker([s.lat, s.lon], { radius: 3, weight: 1.2, color: "#2E7D4F", fillColor: "#fff", fillOpacity: 1 })
        .bindTooltip(s.type + " · " + s.name, { className: "t-lbl" }).addTo(layerShade);
    });
    S.data.segments.forEach((seg, i) => {
      const line = L.polyline(seg.coords, { weight: 7, opacity: 0.95, lineCap: "round", color: MODE.off.color })
        .on("click", () => { if (!S.fireMode) selectSeg(i); })
        .bindTooltip(`${seg.seg_id} · ${seg.landmark}`, { className: "t-lbl", sticky: true })
        .addTo(layerSeg);
      S.segLayers.push(line);
    });

    $("lyr-hyd").onchange = (e) => toggle(layerHyd, e.target.checked);
    $("lyr-shade").onchange = (e) => toggle(layerShade, e.target.checked);
    $("lyr-tree").onchange = (e) => toggle(layerTree, e.target.checked);
    $("lyr-sdot").onchange = (e) => toggle(layerSdot, e.target.checked);
    $("lyr-pop").onchange = (e) => toggle(layerPop, e.target.checked);

    ["lyr-shade", "lyr-hyd", "lyr-tree", "lyr-sdot", "lyr-pop"].forEach((id) => $(id).addEventListener("change", renderLegend));
    renderLegend();

    map.on("click", (e) => { if (!S.fireMode) return; S.fire = [e.latlng.lat, e.latlng.lng]; render(); });
  }
  function renderLegend() {
    const items = ["mist", "flush", "night", "rain", "off", "passive"].map((k) => `<span><i style="background:${MODE[k].color}"></i>${MODE[k].label}</span>`);
    if (S.fire) items.push(`<span><i style="background:${MODE.fire.color}"></i>${MODE.fire.label}</span>`);
    if ($("lyr-shade").checked) items.push(`<span><i class="dot-i" style="border:1.5px solid #2E7D4F;background:#fff"></i>그늘막</span>`);
    if ($("lyr-hyd").checked) items.push(`<span><i class="dot-i" style="background:#1D3A66"></i>지상 소화전</span><span><i class="dot-i" style="background:#B9C2D0"></i>지하 소화전</span>`);
    if ($("lyr-tree").checked) items.push(`<span><i class="dot-i" style="background:#3E8E5A"></i>가로수</span>`);
    if ($("lyr-sdot").checked) items.push(`<span><i class="dot-i" style="border:1.5px solid #142A52;background:#fff"></i>기온 센서</span>`);
    if ($("lyr-pop").checked) items.push(`<span><i style="background:linear-gradient(90deg,#EEF2F8,#41679F);width:28px"></i>생활인구</span>`);
    $("legend").innerHTML = items.join("");
  }
  function toggle(layer, on) { on ? layer.addTo(map) : map.removeLayer(layer); }

  function focusCorridor(c, animate = true) {
    S.focus = c;
    if (c !== "all") S.routeC = c;
    if (S.selected != null && !inFocus(S.data.segments[S.selected])) S.selected = null;
    document.querySelectorAll("#focus-btns button").forEach((b) => b.classList.toggle("on", b.dataset.c === c));
    const segs = S.data.segments.filter(inFocus);
    map.fitBounds(L.latLngBounds(segs.flatMap((s) => s.coords)).pad(c === "all" ? 0.12 : 0.25), { animate });
    render();
    renderForecast();
  }
  function selectSeg(i, zoom = false) {
    const seg = S.data.segments[i];
    if (!inFocus(seg)) { S.selected = i; focusCorridor(seg.corridor_id, false); }
    else { S.selected = i; render(); }
    if (zoom) {
      $("s1").scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => map.fitBounds(L.latLngBounds(seg.coords).pad(0.8), { maxZoom: 18 }), 350);
    }
  }

  // ---------------------------------------------------------------- 생활인구
  const POP_BINS = [500, 1000, 2000, 3000];
  const POP_COLORS = ["#EEF2F8", "#D3DEEE", "#A9BFDF", "#7396C6", "#41679F"];
  function popColor(v) { let i = 0; while (i < POP_BINS.length && v >= POP_BINS[i]) i++; return POP_COLORS[i]; }
  // 선택한 보행축 선에서 150m 안에 중심이 있는 250m 격자
  function nearGrids(focus) {
    if (S.nearGrids[focus]) return S.nearGrids[focus];
    const pts = S.data.segments.filter((s) => focus === "all" || s.corridor_id === focus).flatMap((s) => s.coords);
    const g = (S.data.population ? S.data.population.features : []).filter((f) => {
      const ring = f.geometry.coordinates[0];
      const lat = ring.reduce((a, c) => a + c[1], 0) / ring.length, lon = ring.reduce((a, c) => a + c[0], 0) / ring.length;
      return pts.some((m) => distM(m, [lat, lon]) < 150);
    });
    S.nearGrids[focus] = new Set(g);
    return S.nearGrids[focus];
  }

  // ---------------------------------------------------------------- 시점 자료
  const sdotAgeH = (lo) => (Date.now() - (Date.UTC(+lo.slice(0, 4), +lo.slice(4, 6) - 1, +lo.slice(6, 8), +lo.slice(8, 10)) - 9 * 3.6e6)) / 3.6e6;
  function readingsFor(view, dayIdx, hour) {
    const meta = new Map(S.data.sensors.map((s) => [s.serial, s]));
    if (view === "live") {
      const rt = S.data.realtime || {};
      const n = (S.data.kma || {}).ncst;
      let list = (rt.sensors || []).filter((s) => s.t != null && s.rh != null && meta.has(s.serial)).map((s) => ({ ...meta.get(s.serial), t: s.t, rh: s.rh }));
      const age = rt.latest_obs ? sdotAgeH(rt.latest_obs) : Infinity;
      const wind = n && typeof n.WSD === "number" ? { ws: n.WSD, wd: n.VEC, src: `기상청 실황 ${+n.time.slice(8, 10)}시` } : null;
      const rain = !!(n && ((+n.PTY || 0) > 0 || (+n.RN1 || 0) > 0));   // 강수형태·1시간 강수량
      if (n && typeof n.T1H === "number" && (age > 3 || !list.length)) {
        // S-DoT가 늦으면 기상청 실황 기온을 기준으로 하고, 센서 사이의 차이만 S-DoT에서 가져온다
        const mean = list.length ? list.reduce((a, s) => a + s.t, 0) / list.length : 0;
        list = list.map((s) => ({ ...s, t: n.T1H + (s.t - mean), rh: n.REH }));
        return { hour: +n.time.slice(8, 10), sensors: list, uniform: { t: n.T1H, rh: n.REH }, wind, rain, src: "kma", age, obs: rt.latest_obs, ncstTime: n.time };
      }
      const hour = rt.latest_obs ? +rt.latest_obs.slice(8, 10) : new Date().getHours();
      return { hour, sensors: list, uniform: null, wind, rain, src: list.length ? "sdot" : "none", age, obs: rt.latest_obs };
    }
    const day = S.data.replay.days[dayIdx];
    const rec = day && day.hours.find((h) => h.h === hour);
    if (!rec) return { hour, sensors: [], uniform: null, wind: null, src: "none" };
    const list = rec.s ? Object.entries(rec.s).filter(([k]) => meta.has(k)).map(([k, v]) => ({ ...meta.get(k), t: v[0], rh: v[1] })) : [];
    return { hour, sensors: list, uniform: { t: rec.ta, rh: rec.rh }, wind: rec.ws != null ? { ws: rec.ws, wd: rec.wd, src: "기상청 서울 관측" } : null, src: "replay", day };
  }
  function resultsFor(R, withFire = true) {
    return S.data.segments.map((seg) => {
      const mid = seg.coords[Math.floor(seg.coords.length / 2)];
      let ta = null, rh = null;
      if (R.sensors.length) { ta = M.idw(mid[0], mid[1], R.sensors, "t"); rh = M.idw(mid[0], mid[1], R.sensors, "rh"); }
      else if (R.uniform) { ta = R.uniform.t; rh = R.uniform.rh; }
      if (ta == null) return { seg, mode: "off", ta: null, rh: null };
      let mode = M.modeOf(seg, ta, rh, R.hour, R.rain);
      if (withFire && S.fire && seg.seg_type !== "D" && seg.coords.some((c) => distM(c, S.fire) <= 500)) mode = "fire";
      const e = M.effect(ta, rh, M.effFor(seg));
      const pave = seg.prescription.includes("쿨페이브먼트");
      const paveDT = pave ? (R.hour >= 10 && R.hour < 18 ? -0.5 : -0.1) : 0;   // Middel 외(2020): 낮 0.5℃, 밤 0.1℃
      return { seg, mode, ta, rh, tw: e.tw, app: M.apparent(ta, e.tw), dTa: mode === "mist" ? e.dTa : 0, dTapp: mode === "mist" ? e.dTapp : 0, pave, paveDT };
    });
  }
  function hottestIdx() {
    const days = S.data.replay.days;
    let hot = 0;
    days.forEach((d, i) => { if (Math.max(...d.hours.map((h) => h.ta)) > Math.max(...days[hot].hours.map((h) => h.ta))) hot = i; });
    return hot;
  }

  // ---------------------------------------------------------------- 그리기
  function render() {
    const R = readingsFor(S.view, S.dayIdx, S.hour);
    const results = resultsFor(R);
    S.R = R; S.results = results;
    const F = results.filter((r) => inFocus(r.seg));

    results.forEach((r, i) => {
      const on = inFocus(r.seg);
      const thin = S.ana !== "none";   // 분석 레이어를 볼 때는 선을 가늘게
      S.segLayers[i].setStyle({ color: MODE[r.mode].color, weight: thin ? (S.selected === i ? 4 : 2) : S.selected === i ? 12 : on ? 7 : 5, opacity: on ? 0.95 : 0.3, dashArray: r.mode === "fire" ? "2 9" : null });
    });

    layerHL.clearLayers();
    if (S.selected != null) {
      const sc = S.data.segments[S.selected].coords;
      L.polyline(sc, { color: "#142A52", weight: 22, opacity: 0.25, lineCap: "round", interactive: false }).addTo(layerHL);
      L.polyline(sc, { color: "#FFD23F", weight: 15, opacity: 1, lineCap: "round", interactive: false }).addTo(layerHL)
        .bindTooltip(`선택: ${S.data.segments[S.selected].seg_id}`, { permanent: true, direction: "top", className: "t-sel", offset: [0, -8] });
    }
    layerFire.clearLayers();
    if (S.fire) {
      L.circle(S.fire, { radius: 500, color: "#C0392B", weight: 1.5, fillOpacity: 0.06, dashArray: "4 4", interactive: false }).addTo(layerFire);
      L.circleMarker(S.fire, { radius: 6, color: "#fff", weight: 2, fillColor: "#C0392B", fillOpacity: 1 }).addTo(layerFire);
    }

    layerSdot.clearLayers();
    const valid = new Map(R.sensors.map((s) => [s.serial, s]));
    S.data.sensors.forEach((s) => {
      const v = valid.get(s.serial);
      const m = L.circleMarker([s.lat, s.lon], { radius: 3.5, weight: 1.5, color: v ? "#142A52" : "#A3AAB6", fillColor: v ? "#fff" : "#EEF0F3", fillOpacity: 1 });
      m.bindTooltip(`기온 센서 ${s.serial}<br>${s.addr}<br>${v ? `${fmt(v.t, 1, "℃")} · ${fmt(v.rh, 0, "%")}` : "정상값 없음"}`, { className: "t-lbl" });
      m.addTo(layerSdot);
    });

    // 선택 표시
    const segsF = S.data.segments.filter(inFocus);
    const lenKm = segsF.reduce((a, s) => a + s.len_m, 0) / 1000;
    $("sel-now").innerHTML = `현재 선택: <b>${focusName()}</b> · ${segsF.length}개 구간 · ${lenKm.toFixed(1)}km` +
      (S.selected != null ? ` · 구간 <b>${S.data.segments[S.selected].seg_id}</b>` : "");
    $("side-tag").textContent = "현재 선택: " + focusName();

    // 선택한 보행축 지표
    const ok = F.filter((r) => r.ta != null);
    const avg = (k) => (ok.length ? ok.reduce((a, r) => a + r[k], 0) / ok.length : null);
    const ta = avg("ta"), rh = avg("rh"), app = avg("app");
    const nMist = F.filter((r) => r.mode === "mist").length;
    const nFire = F.filter((r) => r.mode === "fire").length;
    const nHyd = F.filter((r) => r.seg.seg_type !== "D").length;
    $("k-ta").textContent = fmt(ta, 1, "℃");
    $("k-rh").textContent = fmt(rh, 0, "%");
    $("k-app").textContent = fmt(app, 1, "℃");
    $("k-on").textContent = ok.length ? `${nMist} / ${nHyd}` : "–";
    $("k-wind").textContent = R.wind ? `${M.wdName(R.wind.wd)}풍 ${fmt(R.wind.ws, 1, " m/s")}` : "–";
    $("k-wind-note").textContent = R.wind ? `${R.wind.src}` : (S.view === "live" ? "기상청 실황 수집 전" : "");
    const hh = R.hour;
    const near = nearGrids(S.focus);
    if (layerPop) layerPop.setStyle((f) => ({ weight: near.has(f) ? 1.4 : 0.4, color: near.has(f) ? "#142A52" : "#ffffff", fillOpacity: near.has(f) ? 0.7 : 0.35, fillColor: popColor(f.properties.pop[hh]) }));
    const popNear = [...near].reduce((a, f) => a + f.properties.pop[hh], 0);
    $("k-pop").textContent = near.size ? Math.round(popNear).toLocaleString() + "명" : "–";
    $("k-pop-note").textContent = near.size ? `${focusName()} 150m 안 250m 격자 ${near.size}개의 ${hh}시 평균 (지도에서 '생활인구'를 켜면 굵은 테두리로 표시)` : "";

    renderStamp(R);
    renderVerdict(R, F, { ta, rh, nMist, nFire });
    renderEffect(R, results, F);
    drawCool(R, results);
    drawVuln();
    renderLegend();
    const fu = TH ? focusUtci(R, results) : null;
    $("k-utci").textContent = fu ? `${fu.base.toFixed(1)}` : "–";
    $("k-utci-note").textContent = fu ? `${window.UTCI.category(fu.base)} · 시스템 가동 시 ${fu.on.toFixed(1)}${fu.shade != null ? ` · 그늘 ${Math.round(fu.shade * 100)}%` : ""}` : (TH ? "일사 자료가 있는 여름 재생에서 계산합니다" : "");
    renderDetail(results);
    renderTable();
    updateChartCursor();
  }

  function renderStamp(R) {
    const t = (s) => `${+s.slice(6, 8)}일 ${+s.slice(8, 10)}시`;
    if (S.view === "live") {
      if (R.src === "kma") {
        const lag = R.obs ? ` · S-DoT 최근 자료 ${t(R.obs)} (서울시 자료가 ${Math.round(R.age)}시간 늦게 올라와 기온 수준은 기상청 실황으로 보정)` : " · S-DoT 자료 없음";
        $("stamp").textContent = `판정 기준: 기상청 실황 ${t(R.ncstTime)}${lag}`;
      } else if (R.src === "sdot") {
        $("stamp").textContent = `판정 기준: S-DoT ${t(R.obs)} · 정상값 센서 ${R.sensors.length}대`;
      } else $("stamp").textContent = "실시간 자료 수집 전입니다. GitHub Actions에서 수집을 한 번 실행하세요.";
    } else {
      $("stamp").textContent = R.day ? `${R.day.label} · ${S.hour}시` : "재생 자료가 없습니다.";
      $("hour-label").textContent = S.hour + "시";
      document.querySelectorAll("#quick-hours button").forEach((b) => b.classList.toggle("on", +b.dataset.h === S.hour));
    }
  }

  function summerLink(text) { return ` <button class="link-btn" data-summer="1">${text}</button>`; }
  function bindSummer(root) {
    root.querySelectorAll("[data-summer]").forEach((b) => (b.onclick = () => {
      S.dayIdx = hottestIdx(); S.hour = 14; $("day-select").value = String(S.dayIdx); $("hour").value = 14;
      setView("replay"); $("s1").scrollIntoView({ behavior: "smooth" });
    }));
  }

  function renderVerdict(R, F, k) {
    const name = focusName();
    let html = "";
    const h = R.hour;
    const day = h >= RULE.dayStart && h < RULE.dayEnd, eve = h >= RULE.nightStart && h < RULE.nightEnd;
    if (k.ta == null) html = "아직 판단할 기온 자료가 없습니다.";
    else if (R.rain) html = `<b>비가 와서 모든 분사·살수를 멈췄습니다.</b> 기상청 실황에 강수가 잡히면 미스트와 바닥 살수를 자동으로 끕니다. 비가 이미 바닥과 공기를 식히고 습도를 올려 미스트 효과가 없기 때문입니다.`;
    else if (k.nMist) html = `<b>${name} ${F.length}개 구간 중 ${k.nMist}개 구간에서 미스트가 작동합니다.</b> 기온 ${fmt(k.ta, 1, "℃")}가 기준 30℃를 넘고, 습도 ${fmt(k.rh, 0, "%")}가 기준 70%보다 낮기 때문입니다.`;
    else if (F.some((r) => r.mode === "flush")) html = `<b>미스트 대신 바닥 살수만 합니다.</b> 기온 ${fmt(k.ta, 1, "℃")}는 기준을 넘었지만 습도 ${fmt(k.rh, 0, "%")}가 70% 이상이라 미스트가 잘 증발하지 않습니다.`;
    else if (F.some((r) => r.mode === "night")) html = `<b>저녁 바닥 살수 중입니다.</b> ${h}시에도 기온이 ${fmt(k.ta, 1, "℃")}로 27℃ 이상이라 낮 동안 데워진 보도를 식힙니다.`;
    else if (k.ta < RULE.mistTa && (day || !eve)) html = `<b>지금은 작동하지 않습니다.</b> 현재 기온 ${fmt(k.ta, 1, "℃")}가 가동 기준 30℃보다 낮습니다.`;
    else if (!day) html = `<b>지금은 작동하지 않습니다.</b> ${h}시는 운영 시간(낮 10~18시, 저녁 살수 18~21시)이 아닙니다.`;
    else html = "<b>지금은 작동하지 않습니다.</b>";
    if (k.nFire) html += ` <span class="fire-txt"><b>119 출동 우선:</b> 출동 지점 500m 안 ${k.nFire}개 구간의 소화전 급수를 자동으로 끊었습니다.</span>`;
    if (S.view === "live" && !k.nMist) html += `<br><span class="muted">여름 한낮에는 어떻게 달라지는지</span>${summerLink("2026년 여름 가장 더운 날 14시 보기")}`;
    $("verdict").innerHTML = html;
    bindSummer($("verdict"));
    $("fire-note").hidden = !S.fireMode;
    $("fire-note").textContent = S.fire ? `출동 지점 반경 500m 안의 구간은 소화전 물을 소방용으로 돌리기 위해 즉시 멈춥니다. 지도를 다시 누르면 지점이 바뀌고, 버튼을 한 번 더 누르면 해제됩니다.`
                                        : "지도에서 화재 출동 지점을 누르세요. 반경 500m 안의 구간은 소화전 급수를 즉시 끊습니다.";
  }

  // ---------------------------------------------------------------- ④ 효과
  let chartRoute;
  function renderEffect(R, results, F) {
    const pick = (types) => {
      const rs = F.filter((r) => types.includes(r.seg.seg_type) && r.mode === "mist");
      return rs.length ? { t: rs.reduce((a, r) => a + r.dTa, 0) / rs.length, a: rs.reduce((a, r) => a + r.dTapp, 0) / rs.length } : null;
    };
    const ab = pick(["A"]), c = pick(["BC"]);
    $("e-ab-t").textContent = ab ? signed(ab.t) : "가동 안 함";
    $("e-ab-a").textContent = ab ? signed(ab.a) : "–";
    $("e-c-t").textContent = c ? signed(c.t) : "가동 안 함";
    $("e-c-a").textContent = c ? signed(c.a) : "–";

    // 보행 경로: 지금 가동하지 않으면 여름 가장 더운 날 14시를 예시로
    const corr = S.routeC;
    document.querySelectorAll("#route-btns button").forEach((b) => b.classList.toggle("on", b.dataset.c === corr));
    const idx = S.data.segments.map((s, i) => (s.corridor_id === corr ? i : -1)).filter((i) => i >= 0).sort((a, b) => S.data.segments[a].seg_id.localeCompare(S.data.segments[b].seg_id));
    let Rr = R, rr = results, example = false;
    if (!idx.some((i) => results[i].mode === "mist") && S.data.replay.days.length) {
      Rr = readingsFor("replay", hottestIdx(), 14); rr = resultsFor(Rr, false); example = true;
    }
    const w = M.wind(Rr.wind && Rr.wind.ws, Rr.wind && Rr.wind.wd);
    const P = S.poles || (S.poles = M.poles(S.data.segments));
    const prof = M.routeProfile(rr, idx, P, w);
    S.prof = prof;

    const mistF = F.filter((r) => r.mode === "mist");
    let ans;
    if (mistF.length) {
      const t = mistF.reduce((a, r) => a + r.dTa, 0) / mistF.length, a = mistF.reduce((a, r) => a + r.dTapp, 0) / mistF.length;
      ans = `<b>미스트가 작동하는 구간에서 기온은 평균 ${Math.abs(t).toFixed(1)}℃, 체감온도는 ${Math.abs(a).toFixed(1)}℃ 낮아질 것으로 추정됩니다.</b> 폴대 바로 옆에서는 체감온도가 최대 ${prof.maxDrop.toFixed(1)}℃까지 내려갑니다.`;
    } else {
      ans = `<b>${focusName()}은 지금 가동하지 않아 냉각 효과가 없습니다.</b>`;
    }
    if (example) ans += `<br><span class="muted">아래 그래프는 예시로 ${Rr.day.label.split(" (")[0]} 14시(2026년 여름 가장 더운 날)를 보여 줍니다.</span>`;
    $("eff-answer").innerHTML = ans;

    // 지표: 기상청 체감온도 또는 UTCI
    const metric = S.metric || "app";
    document.querySelectorAll("#metric-btns button").forEach((b) => b.classList.toggle("on", b.dataset.m === metric));
    let series = prof.pts.map((p) => ({ d: p.d, len: p.len, base: p.base, on: p.on })), thr = 33, thrLbl = "폭염주의보 기준 체감 33℃", unitLbl = "체감", note = "";
    if (metric === "utci") {
      let Ru = Rr, ru = rr, pu = prof;
      if (!metFor(Ru)) { Ru = readingsFor("replay", hottestIdx(), 14); ru = resultsFor(Ru, false); pu = M.routeProfile(ru, idx, P, M.wind(Ru.wind && Ru.wind.ws, Ru.wind && Ru.wind.wd)); note = `UTCI는 일사 자료가 있는 여름 재생에서만 계산되어 ${Ru.day.label.split(" (")[0]} 14시를 보여 줍니다.`; }
      const fb = utciField(Ru, ru, false), fo = utciField(Ru, ru, true);
      series = fb ? pu.pts.map((p) => {
        const ids = nearPix(p.x, p.y, 12);
        const avg = (f) => { let a = 0, c = 0; ids.forEach((i) => { if (!Number.isNaN(f[i])) { a += f[i]; c++; } }); return c ? a / c : null; };
        return { d: p.d, len: p.len, base: avg(fb), on: avg(fo) };
      }).filter((q) => q.base != null) : [];
      thr = 38; thrLbl = "UTCI 38 (매우 강한 더위 스트레스 시작)"; unitLbl = "UTCI";
    }
    $("route-desc").textContent = metric === "utci"
      ? "보행축을 따라 걸으며 받는 열 스트레스(UTCI)입니다. 보행축 선 12m 안의 2m 격자 평균이라 건물·가로수 그늘이 있는 곳은 낮게, 햇빛이 드는 곳은 높게 나옵니다. 회색은 시설이 없을 때, 초록은 미스트와 바닥 살수를 할 때입니다." + (note ? " " + note : "")
      : "한쪽 끝에서 반대쪽 끝까지 걸어가며 느끼는 체감온도입니다. 회색은 시설이 없을 때, 초록은 가동할 때입니다. 미스트 폴대 근처를 지날 때마다 체감온도가 잠깐씩 내려가고, 폭염주의보 기준인 체감 33℃를 넘는 더위에 노출되는 양(넘은 온도 × 시간)이 줄어듭니다.";
    const over = (k) => series.reduce((a, p) => a + Math.max(0, p[k] - thr) * p.len / M.HEAT.walk / 60, 0);
    const oB = over("base"), oO = over("on");
    let rests = 0, inR = false;
    series.forEach((p) => { const r = p.base - p.on >= 1; if (r && !inR) rests++; inR = r; });
    const red = oB > 0 ? (1 - oO / oB) * 100 : 0;
    const gap = rests ? prof.length / rests : null;
    $("route-stats").innerHTML = `
      <div><span>걷는 거리</span><b>${(prof.length / 1000).toFixed(2)}km</b><em>약 ${Math.round(prof.minutes)}분</em></div>
      <div><span>${unitLbl} ${thr} 넘는 더위 노출</span><b>${oB.toFixed(0)} → ${oO.toFixed(0)}</b><em>℃·분, ${red > 0 ? `${red.toFixed(0)}% 감소` : "변화 없음"}</em></div>
      <div><span>${unitLbl} 1℃ 이상 낮아지는 쉼 구간</span><b>${rests}곳</b><em>${gap ? `평균 ${Math.round(gap)}m마다` : "없음"}</em></div>`;

    if (!chartRoute) {
      chartRoute = new Chart($("chart-route"), {
        type: "line",
        data: { datasets: [
          { label: "시설 없음", data: [], borderColor: "#9AA3AF", borderWidth: 1.6, pointRadius: 0, tension: 0.2 },
          { label: "시스템 가동", data: [], borderColor: "#0E7C86", backgroundColor: "rgba(14,124,134,0.12)", fill: "-1", borderWidth: 2, pointRadius: 0, tension: 0.2 },
          { label: "", data: [], borderColor: "#C0392B", borderWidth: 1, borderDash: [4, 4], pointRadius: 0 },
        ] },
        options: {
          maintainAspectRatio: false, animation: false, parsing: false,
          interaction: { mode: "index", intersect: false },
          plugins: { legend: { display: true, position: "bottom", labels: { boxWidth: 14, boxHeight: 2, font: { size: 11.5 } } },
                     tooltip: { callbacks: { title: (it) => `출발 후 ${Math.round(it[0].parsed.x)}m`, label: (c) => `${c.dataset.label} ${c.parsed.y.toFixed(1)}℃` } } },
          scales: { x: { type: "linear", grid: { display: false }, ticks: { callback: (v) => v + "m", maxTicksLimit: 7 } },
                    y: { grid: { color: "#EEF1F5" }, ticks: { callback: (v) => v + "℃" }, title: { display: true, text: "체감온도", font: { size: 11 } } } },
        },
      });
    }
    chartRoute.data.datasets[0].data = series.map((p) => ({ x: p.d, y: p.base }));
    chartRoute.data.datasets[1].data = series.map((p) => ({ x: p.d, y: p.on }));
    chartRoute.data.datasets[2].label = thrLbl;
    chartRoute.data.datasets[2].data = series.length ? [{ x: 0, y: thr }, { x: series[series.length - 1].d, y: thr }] : [];
    chartRoute.options.scales.y.title.text = metric === "utci" ? "UTCI" : "체감온도";
    chartRoute.update("none");
  }

  // ---------------------------------------------------------------- 민감도 분석
  function routeEval(metric) {
    const idx = S.data.segments.map((x, i) => (x.corridor_id === S.routeC ? i : -1)).filter((i) => i >= 0).sort((a, b) => S.data.segments[a].seg_id.localeCompare(S.data.segments[b].seg_id));
    const R = readingsFor("replay", hottestIdx(), 14), res = resultsFor(R, false);
    const P = S.poles || (S.poles = M.poles(S.data.segments));
    const prof = M.routeProfile(res, idx, P, M.wind(R.wind && R.wind.ws, R.wind && R.wind.wd));
    let series = prof.pts, thr = 33;
    if (metric === "utci") {
      const fb = utciField(R, res, false), fo = utciField(R, res, true);
      if (!fb) return null;
      series = prof.pts.map((p) => {
        const ids = nearPix(p.x, p.y, 12); let a = 0, b = 0;
        ids.forEach((i) => { a += fb[i]; b += fo[i]; });
        return ids.length ? { base: a / ids.length, on: b / ids.length, len: p.len } : null;
      }).filter(Boolean);
      thr = 38;
    }
    const over = (k) => series.reduce((a, p) => a + Math.max(0, p[k] - thr) * p.len, 0);
    const oB = over("base"), oO = over("on");
    const W_ = series.reduce((a, p) => a + p.len, 0), mean = (k) => series.reduce((a, p) => a + p[k] * p.len, 0) / W_;
    return { red: oB > 0 ? (1 - oO / oB) * 100 : 0, drop: mean("base") - mean("on") };
  }
  function sensTable() {
    const C = M.CFG, keep = { ...C };
    const cases = [
      ["기준값", {}],
      ["증발 효율 절반", { effScale: 0.5 }], ["증발 효율 1.5배", { effScale: 1.5 }],
      ["5분 가동 · 10분 정지", { onMin: 5 }], ["15분 연속 가동", { onMin: 15 }],
      ["골목 바람 절반", { windScale: 0.5 }],
      ["쿨페이브먼트 반사열 무시", { paveReflect: false }],
    ];
    const rows = cases.map(([lbl, ch]) => {
      Object.assign(C, keep, ch); fieldCache.clear();
      const a = routeEval("app"), u = routeEval("utci");
      return `<tr><td>${lbl}</td><td>${a ? a.drop.toFixed(2) + "℃" : "–"}</td><td>${a ? a.red.toFixed(0) + "%" : "–"}</td><td>${u ? u.drop.toFixed(2) + "℃" : "–"}</td><td>${u ? u.red.toFixed(0) + "%" : "–"}</td></tr>`;
    });
    Object.assign(C, keep); fieldCache.clear();
    const day = S.data.replay.days[hottestIdx()].label.split(" (")[0];
    $("sens-out").innerHTML = `<p class="muted small">${CNAME[S.routeC]} · ${day} 14시 · 보행축을 걸을 때 평균 저감과 더위 노출 감소율</p>
      <div class="table-wrap"><table class="mini sens-table"><thead><tr><th>가정</th><th>체감 평균 저감</th><th>체감 33℃ 노출 감소</th><th>UTCI 평균 저감</th><th>UTCI 38 노출 감소</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  }
  function initSens() {
    const C = M.CFG;
    const bind = (id, key, parse) => { const el = $(id); el.value = String(C[key]); el.onchange = () => { C[key] = parse(el.value); fieldCache.clear(); S.prio = null; computePriority(); render(); renderForecast(); }; };
    bind("cfg-eff", "effScale", parseFloat); bind("cfg-on", "onMin", parseInt); bind("cfg-wind", "windScale", parseFloat);
    bind("cfg-pave", "paveReflect", (v) => v === "true");
    $("sens-run").onclick = () => { $("sens-out").innerHTML = '<p class="muted small">계산 중…</p>'; setTimeout(sensTable, 30); };
  }

  // ---------------------------------------------------------------- 열 스트레스(UTCI)·위성 지표면온도
  const WETM = new Set(["mist", "flush", "night"]);
  let TH = null;
  function thermalInit() {
    const g = window.Thermal.load(S.data.solweig);
    if (!g) return;
    const segs = S.data.segments, P = S.poles || (S.poles = M.poles(segs));
    const lines = segs.map((s) => s.coords.map(([la, lo]) => M.xy(la, lo)));
    const n = g.n, px = new Float32Array(n), py = new Float32Array(n), pseg = new Int16Array(n), poleNear = new Array(n), hash = new Map();
    for (let i = 0; i < n; i++) {
      const [x, y] = M.xy(g.lat[i], g.lon[i]); px[i] = x; py[i] = y;
      let bd = 1e9, bs = 0;
      if (g.seg) { pseg[i] = g.seg[i]; } else lines.forEach((L, si) => { for (let j = 0; j < L.length - 1; j++) {
        const [ax, ay] = L[j], [bx, by] = L[j + 1], dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
        if (d < bd) { bd = d; bs = si; }
      } });
      if (!g.seg) pseg[i] = bs;
      poleNear[i] = P.map((p, k) => (Math.abs(p.x - x) < 40 && Math.abs(p.y - y) < 40 ? k : -1)).filter((k) => k >= 0);
      const key = Math.floor(x / 10) + "," + Math.floor(y / 10);
      (hash.get(key) || hash.set(key, []).get(key)).push(i);
    }
    TH = { g, px, py, pseg, poleNear, hash, P };
  }
  function nearPix(x, y, r) {
    const out = [];
    for (let a = Math.floor((x - r) / 10); a <= Math.floor((x + r) / 10); a++)
      for (let b = Math.floor((y - r) / 10); b <= Math.floor((y + r) / 10); b++)
        (TH.hash.get(a + "," + b) || []).forEach((i) => { if (Math.hypot(TH.px[i] - x, TH.py[i] - y) <= r) out.push(i); });
    return out;
  }
  function metFor(R) {
    if (!TH || R.src !== "replay" || !R.day) return null;
    const rec = R.day.hours.find((h) => h.h === R.hour);
    if (!rec || rec.sr == null) return null;
    const d = Date.parse(R.day.date + "T00:00:00Z"), doy = Math.round((d - Date.UTC(new Date(d).getUTCFullYear(), 0, 0)) / 864e5);
    return { doy, hour: R.hour, ws: rec.ws != null ? rec.ws : 1, sr: rec.sr, tg: rec.tg };
  }
  const fieldCache = new Map();
  function utciField(R, results, on) {
    const met = metFor(R);
    if (!met) return null;
    const C = M.CFG, key = `${R.day.date}|${R.hour}|${on}|${results.map((r) => r.mode[0]).join("")}|${C.effScale}|${C.onMin}|${C.windScale}|${C.paveReflect}`;
    if (fieldCache.has(key)) return fieldCache.get(key);
    const g = TH.g, n = g.n, out = new Float32Array(n), preps = new Map(), dts = new Float32Array(n);
    out.dT = dts;
    let A = null, caps = null, w = null;
    if (on) {
      w = M.wind(R.wind && R.wind.ws, R.wind && R.wind.wd);
      A = M.amps(results, TH.P, w);
      caps = results.map((r) => (r.mode === "mist" ? -M.PLUME.capFrac * (r.ta - r.tw) : 0));
    }
    for (let i = 0; i < n; i++) {
      const si = TH.pseg[i], r = results[si];
      if (r.ta == null) { out[i] = NaN; continue; }
      let p = preps.get(si);
      if (!p) { p = window.Thermal.prep({ ...met, ta: r.ta, rh: r.rh }); preps.set(si, p); }
      let dT = 0, wet = false, pave = false;
      if (on) {
        let cap = 0;
        TH.poleNear[i].forEach((k) => { const pl = TH.P[k]; if (A[pl.seg]) { dT += A[pl.seg] * M.kern(pl, TH.px[i], TH.py[i], 1.5, w); cap = Math.min(cap, caps[pl.seg]); } });
        if (dT < cap) dT = cap;
        wet = g.dist[i] <= 12 && WETM.has(r.mode);
        pave = g.dist[i] <= 12 && r.pave;
        if (pave) dT += r.paveDT;
        dts[i] = dT;
      }
      out[i] = window.Thermal.utciAt(p, i, dT, wet, pave);
    }
    if (fieldCache.size > 40) fieldCache.clear();
    fieldCache.set(key, out);
    return out;
  }
  const UTCI_C = [[46, [164, 22, 26]], [38, [228, 87, 46]], [32, [242, 158, 76]], [26, [246, 213, 92]], [-99, [156, 197, 161]]];
  const utciRGB = (u) => UTCI_C.find(([t]) => u > t)[1];
  let coolOverlay = null, vulnOverlay = null, VU = null;
  function cornersBounds(cs) {
    const la = cs.map((c) => c[1]), lo = cs.map((c) => c[0]);
    return [[Math.min(...la), Math.min(...lo)], [Math.max(...la), Math.max(...lo)]];
  }
  const DIFF_C = [[247, 251, 255], [198, 219, 239], [107, 174, 214], [33, 113, 181], [8, 48, 107]];
  function ramp(stops, u) {
    u = Math.max(0, Math.min(1, u)); const f = u * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(f)), w = f - k;
    return [0, 1, 2].map((j) => Math.round(stops[k][j] + (stops[k + 1][j] - stops[k][j]) * w));
  }
  function overlayFrom(pixels, w, h, bounds, old, pane) {
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d"), img = ctx.createImageData(w, h);
    pixels(img.data);
    ctx.putImageData(img, 0, 0);
    const url = cv.toDataURL();
    if (old) { old.setUrl(url); return old; }
    return L.imageOverlay(url, bounds, { pane, interactive: false }).addTo(map);
  }
  // 냉각 효과: 저감량(UTCI 차이) / 가동 전 / 가동 후
  function drawCool(R, results) {
    const on = S.ana === "cool";
    $("cool-tools").hidden = !on;
    if (!on || !TH) { if (coolOverlay) { map.removeLayer(coolOverlay); coolOverlay = null; } return; }
    const fb = utciField(R, results, false), fo = fb && utciField(R, results, true);
    if (!fb) {
      if (coolOverlay) { map.removeLayer(coolOverlay); coolOverlay = null; }
      $("cool-read").innerHTML = "햇빛 세기(일사) 자료가 필요해 <b>2026년 여름 재생</b>에서만 계산됩니다." + summerLink("여름 가장 더운 날 14시 보기");
      bindSummer($("cool-read"));
      return;
    }
    const mode = S.coolMode || "diff", g = TH.g, sw = g.sw;
    coolOverlay = overlayFrom((d) => {
      for (let i = 0; i < g.n; i++) {
        if (Number.isNaN(fb[i]) || !inFocus(S.data.segments[TH.pseg[i]])) continue;
        const o = (g.row[i] * sw.w + g.col[i]) * 4;
        let c, a = 225;
        if (mode === "diff") { const dv = fb[i] - fo[i]; c = ramp(DIFF_C, dv / 4); a = dv < 0.1 ? 60 : 235; }
        else c = utciRGB(mode === "on" ? fo[i] : fb[i]);
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = a;
      }
    }, sw.w, sw.h, cornersBounds(sw.corners), coolOverlay, "heatPane");
    S.cool = { fb, fo };
    const leg = mode === "diff"
      ? legendHtml(["0", "1", "2", "3", "4℃ 이상"], [0, 0.25, 0.5, 0.75, 1].map((u) => ramp(DIFF_C, u))) + '<span class="muted">UTCI(체감 열 스트레스)가 가동으로 낮아진 정도</span>'
      : legendHtml(["≤26", "26~32", "32~38", "38~46", ">46"], UTCI_C.slice().reverse().map((c) => c[1]), ["없음", "중간", "강함", "매우 강함", "극심"]);
    $("cool-read").innerHTML = leg + '<span class="muted" id="cool-cur">지도에 커서를 올리면 그 지점 값이 나옵니다.</span>';
  }
  function legendHtml(labels, cols, names) {
    return '<span class="mini-legend">' + labels.map((l, i) => `<span><i style="background:rgb(${cols[i].join(",")})"></i>${l}${names ? ` ${names[i]}` : ""}</span>`).join("") + "</span>";
  }
  // 열 취약성 (30m 연속값)
  const VULN_C = [[255, 247, 236], [253, 212, 158], [252, 141, 89], [215, 48, 31], [127, 0, 0]];
  function vulnInit() {
    const d = S.data.vuln;
    if (!d) return;
    const dec = (k) => Uint8Array.from(atob(d[k]), (c) => c.charCodeAt(0));
    VU = { ...d, v0: dec("v0"), v1: dec("v1"), hz: dec("hz"), ex: dec("ex"), se: dec("se"), c0: dec("c0"), c1: dec("c1") };
  }
  function drawVuln() {
    const on = S.ana === "vuln";
    $("vuln-tools").hidden = !on;
    if (!on || !VU) { if (vulnOverlay) { map.removeLayer(vulnOverlay); vulnOverlay = null; } return; }
    const mode = S.vulnMode || "v0", [w, s, e, n] = VU.bounds;
    vulnOverlay = overlayFrom((d) => {
      for (let i = 0; i < VU.w * VU.h; i++) {
        if (VU.v0[i] === 255) continue;
        let c, a = 200;
        if (mode === "diff") { const dv = (VU.v0[i] - VU.v1[i]) / 250; c = ramp(DIFF_C, dv / 0.2); a = dv < 0.005 ? 0 : 230; }
        else c = ramp(VULN_C, VU[mode][i] / 250);
        d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = a;
      }
    }, VU.w, VU.h, [[s, w], [n, e]], vulnOverlay, "vulnPane");
    $("vuln-read").innerHTML = (mode === "diff"
      ? legendHtml(["조금", "", "", "", "크게"], [0, 0.25, 0.5, 0.75, 1].map((u) => ramp(DIFF_C, u))) + '<span class="muted">시스템 도입으로 취약성이 낮아진 곳</span>'
      : legendHtml(["낮음", "", "", "", "높음"], [0, 0.25, 0.5, 0.75, 1].map((u) => ramp(VULN_C, u))) + '<span class="muted">뜨거운 곳·사람 많은 곳·고령층 많은 곳일수록 높고, 그늘·가로수·냉각시설이 있으면 낮아집니다</span>')
      + '<span class="muted" id="vuln-cur"></span>';
  }
  // 시범 우선순위: 열 취약성 × 가동 시 UTCI 저감 ÷ 사업비 (여름 가장 더운 날 14시 기준)
  function computePriority() {
    if (!TH || !VU || !S.data.replay.days.length) return;
    const R = readingsFor("replay", hottestIdx(), 14), res = resultsFor(R, false);
    const fb = utciField(R, res, false), fo = utciField(R, res, true);
    if (!fb) return;
    const n = S.data.segments.length, dU = new Float64Array(n), cnt = new Float64Array(n);
    for (let i = 0; i < TH.g.n; i++) { if (Number.isNaN(fb[i])) continue; dU[TH.pseg[i]] += fb[i] - fo[i]; cnt[TH.pseg[i]]++; }
    const [w, s0, e0, nn] = VU.bounds;
    const vAt = (la, lo) => { const c = Math.floor((lo - w) / (e0 - w) * VU.w), r = Math.floor((nn - la) / (nn - s0) * VU.h), v = VU.v0[r * VU.w + c]; return v === 255 ? null : v / 250; };
    const rows = S.data.segments.map((seg, si) => {
      const vs = seg.coords.map(([la, lo]) => vAt(la, lo)).filter((v) => v != null);
      const v = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0;
      const d = cnt[si] ? dU[si] / cnt[si] : 0;
      return { si, v, dU: d, raw: v * Math.max(0, d) / (seg.capex_krw / 1e7) };
    });
    const mx = Math.max(...rows.map((r) => r.raw)) || 1;
    rows.forEach((r) => (r.score = Math.round(r.raw / mx * 100)));
    [...rows].sort((a, b) => b.raw - a.raw).forEach((r, k) => (r.rank = k + 1));
    S.prio = rows;
    const top = [...rows].sort((a, b) => a.rank - b.rank).slice(0, 3).map((r) => S.data.segments[r.si].seg_id);
    $("prio-top").innerHTML = `시범 우선순위 상위: <b>${top.join(", ")}</b>`;
  }
  function onMapMove(e) {
    const { lat, lng } = e.latlng;
    if (S.ana === "vuln" && VU && $("vuln-cur")) {
      const [w, s0, e0, n] = VU.bounds, c = Math.floor((lng - w) / (e0 - w) * VU.w), r = Math.floor((n - lat) / (n - s0) * VU.h), i = r * VU.w + c;
      if (c >= 0 && c < VU.w && r >= 0 && r < VU.h && VU.v0[i] !== 255) {
        const pc = (a) => Math.round(a[i] / 2.5);
        $("vuln-cur").textContent = `커서 위치: 취약성 ${pc(VU.v0)} → 도입 후 ${pc(VU.v1)} (지표면온도 상위 ${100 - pc(VU.hz)}% · 생활인구 상위 ${100 - pc(VU.ex)}% · 고령 비중 상위 ${100 - pc(VU.se)}% · 대응력 ${pc(VU.c0)}→${pc(VU.c1)})`;
      } else $("vuln-cur").textContent = "";
    }
    if (S.ana === "cool" && TH && S.cool && $("cool-cur")) {
      const [x, y] = M.xy(lat, lng), ids = nearPix(x, y, 3);
      if (ids.length) {
        const i = ids[0], b = S.cool.fb[i], o = S.cool.fo[i], dt = S.cool.fo.dT ? S.cool.fo.dT[i] : 0;
        const p = window.Thermal.prep({ doy: 213, hour: S.R.hour, ta: 30, rh: 50, ws: 1, sr: 0 }), sh = p.hi >= 0 ? TH.g.shade(p.di, p.hi, i) : 2;
        $("cool-cur").textContent = `커서 위치(${["햇빛", "나무 그늘", "건물 그늘"][sh]}): UTCI ${b.toFixed(1)} → ${o.toFixed(1)} (${(o - b).toFixed(1)}), 기온 ${dt.toFixed(1)}℃`;
      } else $("cool-cur").textContent = "보행축 20m 밖이거나 건물 안입니다.";
    }
  }
  function focusUtci(R, results) {
    // 선택한 보행축 화소의 UTCI 평균과 그늘 비율
    const fb = utciField(R, results, false);
    if (!fb) return null;
    const fo = utciField(R, results, true);
    let a = 0, b = 0, c = 0, shd = 0;
    const met = metFor(R), p = window.Thermal.prep({ ...met, ta: 30, rh: 50 });
    for (let i = 0; i < TH.g.n; i++) {
      if (!inFocus(S.data.segments[TH.pseg[i]]) || Number.isNaN(fb[i])) continue;
      a += fb[i]; b += fo[i]; c++;
      if (p.hi >= 0 && TH.g.shade(p.di, p.hi, i) > 0) shd++;
    }
    return c ? { base: a / c, on: b / c, shade: p.hi >= 0 ? shd / c : null } : null;
  }
  function segThermal(si, R, results) {
    if (!TH) return null;
    const fb = utciField(R, results, false), fo = fb && utciField(R, results, true);
    const p14 = window.Thermal.prep({ doy: metFor(R) ? metFor(R).doy : 213, hour: 14, ta: 30, rh: 50, ws: 1, sr: 0 });
    let a = 0, b = 0, c = 0, sh = 0, m = 0;
    for (let i = 0; i < TH.g.n; i++) {
      if (TH.pseg[i] !== si) continue;
      m++; if (TH.g.shade(p14.di, p14.hi, i) > 0) sh++;
      if (fb && !Number.isNaN(fb[i])) { a += fb[i]; b += fo[i]; c++; }
    }
    return { shade14: m ? sh / m : null, base: c ? a / c : null, on: c ? b / c : null, dateLbl: TH.g.sw.dates[p14.di].label };
  }

  // ---------------------------------------------------------------- 표·상세
  function renderTable() {
    const rs = S.results;
    if (!rs.length) return;
    let order = rs.map((r, i) => i);
    if (S.sortPrio && S.prio) order.sort((a, b) => S.prio[a].rank - S.prio[b].rank);
    $("seg-body").innerHTML = order.map((i) => {
      const r = rs[i];
      if (!inFocus(r.seg)) return "";
      const s = r.seg;
      const type = s.seg_type === "BC" ? `B/C<span class="muted hide-m"> (${s.type_provisional} 잠정)</span>` : s.seg_type;
      return `<tr data-i="${i}" class="${S.selected === i ? "sel" : ""}">
        <td>${s.seg_id}</td><td class="loc">${s.landmark.replace(/\s*\(.*$/, "")}<span class="muted hide-m"> ${(s.landmark.match(/\((.*)\)/) || ["", ""])[1]}</span></td>
        <td>${type}</td><td class="nw"><i class="dot" style="background:${MODE[r.mode].color}"></i>${SHORT[r.mode]}</td>
        <td>${fmt(r.ta, 1, "℃")}</td><td>${r.mode === "mist" ? signed(r.dTa) : "–"}</td><td>${S.prio ? S.prio[i].rank + "위" : "–"}</td></tr>`;
    }).join("");
    document.querySelectorAll("#seg-body tr").forEach((tr) => { tr.onclick = () => selectSeg(+tr.dataset.i, true); });
  }

  function thermRow(si) {
    const t = segThermal(si, S.R, S.results);
    if (!t) return "";
    return `<dt>오후 2시 그늘</dt><dd>${t.shade14 != null ? Math.round(t.shade14 * 100) + "%" : "–"} <span class="muted">(${t.dateLbl} 기준, 건물·가로수)</span></dd>` +
      (t.base != null ? `<dt>지금 UTCI</dt><dd>${t.base.toFixed(1)} → 가동 시 ${t.on.toFixed(1)} <span class="muted">(${window.UTCI.category(t.base)})</span></dd>` : "");
  }
  function renderDetail(results) {
    if (S.selected == null) { $("seg-detail").innerHTML = '<span class="muted">지도의 선이나 구간 목록을 누르면 상세 정보가 나옵니다.</span>'; return; }
    const r = results[S.selected], s = r.seg;
    const type = s.seg_type === "BC" ? `${TYPE_LABEL.BC}<br><span class="muted">도로 위계로 본 잠정 구분: 유형 ${s.type_provisional}</span>` : TYPE_LABEL[s.seg_type];
    const now = r.mode === "mist" ? `미스트 작동 · 기온 ${signed(r.dTa)}, 체감 ${signed(r.dTapp)} 예상` : MODE[r.mode].label;
    $("seg-detail").innerHTML = `
      <p class="seg-sum"><span class="badge">${s.seg_id}</span> ${s.landmark}</p>
      <p class="seg-now">지금: <b>${now}</b> (${fmt(r.ta, 1, "℃")}, 습도 ${fmt(r.rh, 0, "%")})</p>
      <dl>
        <dt>유형</dt><dd>${type}</dd>
        <dt>설치 내용</dt><dd>${s.prescription}</dd>
        <dt>길이</dt><dd>${fmt(s.len_m, 0, "m")}</dd>
        <dt>지상 소화전</dt><dd>${s.fh_above_35m}기 (35m 이내)</dd>
        <dt>기존 그늘막</dt><dd>${s.shade_count}개소 (45m 이내)</dd>
        <dt>가로수</dt><dd>${s.tree_count}주 (20m 이내)</dd>
        <dt>보도 폭</dt><dd>미확인 (로드뷰 실측 필요)</dd>
        <dt>기준 센서</dt><dd>${s.nearest_sdot} (${s.nearest_sdot_m}m)</dd>
        <dt>쿨페이브먼트</dt><dd>${s.prescription.includes("쿨페이브먼트") ? "설치 (노면 −6℃, 기온 낮 −0.5℃, 반사열은 증가)" : "없음"}</dd>
        ${thermRow(S.selected)}
        ${S.prio ? `<dt>시범 우선순위</dt><dd><b>${S.prio[S.selected].rank}위</b> / 30 <span class="muted">(취약성 ${(S.prio[S.selected].v * 100).toFixed(0)} × 한여름 UTCI 저감 ${S.prio[S.selected].dU.toFixed(1)} ÷ 사업비)</span></dd>` : ""}
        <dt>구간 사업비</dt><dd>${(s.capex_krw / 10000).toLocaleString()}만 원</dd>
      </dl>`;
  }

  // ---------------------------------------------------------------- ③ 예보
  // 여름 예시: 2026년 여름 가장 더운 날 앞뒤 실제 관측값을 예보처럼 넣는다
  function exampleHours() {
    const days = S.data.replay.days, h = hottestIdx();
    return days.slice(Math.max(0, h - 1), h + 3).flatMap((d) => d.hours.map((x) => ({ time: d.date.replace(/-/g, "") + String(x.h).padStart(2, "0"), t: x.ta, rh: x.rh })));
  }
  function forecastHours() {
    if (S.fcSrc === "ex") return exampleHours();
    const k = S.data.kma || {};
    const byTime = new Map();
    ((k.short && k.short.rows) || []).forEach((r) => { if (r.TMP != null) byTime.set(r.time, { time: r.time, t: r.TMP, rh: r.REH, ws: r.WSD, pop: r.POP, pty: +r.PTY || 0 }); });
    ((k.ultra && k.ultra.rows) || []).forEach((r) => { if (r.T1H != null) byTime.set(r.time, { time: r.time, t: r.T1H, rh: r.REH, ws: r.WSD, pop: (byTime.get(r.time) || {}).pop, pty: +r.PTY || 0 }); });
    const rows = [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
    // 단기예보 뒷부분은 3시간 간격으로 온다. 빈 시간은 앞뒤 값을 직선 보간해 1시간 간격으로 맞춘다
    const toD = (t) => Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10));
    const toT = (ms) => { const d = new Date(ms); return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0") + String(d.getUTCHours()).padStart(2, "0"); };
    const out = [];
    rows.forEach((r, i) => {
      out.push(r);
      const n = rows[i + 1];
      if (!n) return;
      const gap = (toD(n.time) - toD(r.time)) / 3.6e6;
      if (gap <= 1 || gap > 6) return;
      for (let h = 1; h < gap; h++) {
        const w = h / gap, lerp = (a, b) => (a == null || b == null ? a : a + (b - a) * w);
        out.push({ time: toT(toD(r.time) + h * 3.6e6), t: lerp(r.t, n.t), rh: lerp(r.rh, n.rh), ws: lerp(r.ws, n.ws), pop: r.pop, pty: r.pty, interp: true });
      }
    });
    return out;
  }
  function renderFormula() {
    const segs = S.data.segments.filter((s) => inFocus(s) && s.seg_type !== "D");
    const poles = segs.reduce((a, s) => a + s.fh_above_35m, 0), len = segs.reduce((a, s) => a + s.len_m, 0);
    const mist = poles * W.nozzlesPerPole * W.lpmPerNozzle * 60 * M.DUTY, flush = len * W.sidewalkM * W.flushMm;
    $("w-formula").innerHTML = `${focusName()} 기준 · 미스트: 소화전 ${poles}기 × 노즐 ${W.nozzlesPerPole}개 × ${W.lpmPerNozzle}L/분 × 60분 × 가동 비율 ${M.CFG.onMin}/15 = <b>시간당 ${Math.round(mist).toLocaleString()}L</b><br>`
      + `바닥 살수: 구간 길이 ${Math.round(len).toLocaleString()}m × 폭 ${W.sidewalkM}m × ${W.flushMm}mm = <b>시간당 ${Math.round(flush).toLocaleString()}L</b> (미스트·살수만·저녁 살수 때 모두 사용)`;
  }
  function renderForecast() {
    renderFormula();
    if (!S.fcSrc) {   // 실제 예보에 가동 시간이 없으면(겨울철 등) 여름 예시로 시작
      S.fcSrc = "real";
      const real = forecastHours();
      if (!real.length || !real.some((h) => ["mist", "flush", "night"].includes(M.modeOf({ seg_type: "A" }, h.t, h.rh, +h.time.slice(8, 10), h.pty > 0)))) S.fcSrc = "ex";
    }
    document.querySelectorAll("#fc-src button").forEach((b) => b.classList.toggle("on", b.dataset.s === S.fcSrc));
    const hrs = forecastHours();
    const k = S.data.kma || {};
    if (!hrs.length) {
      $("fc-strip").innerHTML = ""; $("fc-legend").innerHTML = "";
      $("fc-answer").innerHTML = "아직 기상청 예보를 받지 못했습니다. GitHub Actions에서 수집을 한 번 실행하면 표시됩니다.";
      $("fc-body").innerHTML = `<tr><td colspan="6" class="muted">예보 자료 없음</td></tr>`;
      return;
    }
    const segs = S.data.segments.filter(inFocus);
    const modeAt = (h, dt) => M.modeOf({ seg_type: "A" }, h.t + dt, h.rh, +h.time.slice(8, 10), h.pty > 0);
    const days = {};
    hrs.forEach((h) => {
      const d = h.time.slice(0, 8);
      const o = days[d] || (days[d] = { tmax: -99, n: { mist: 0, flush: 0, night: 0 }, lo: 0, mid: 0, hi: 0, nHi: 0 });
      o.tmax = Math.max(o.tmax, h.t);
      [-1, 0, 1].forEach((dt) => {
        const mode = modeAt(h, dt);
        const Lw = segs.reduce((a, s) => a + M.waterLiters(s, s.seg_type === "D" ? "passive" : mode, W), 0);
        const on = mode === "mist" || mode === "flush" || mode === "night";
        if (dt === 0) { o.mid += Lw; if (on) o.n[mode]++; }
        if (dt === -1) o.lo += Lw;
        if (dt === 1) { o.hi += Lw; if (on) o.nHi++; }
      });
    });
    let prevDay = "";
    $("fc-strip").innerHTML = hrs.map((h) => {
      const d = h.time.slice(0, 8), hh = +h.time.slice(8, 10), mode = modeAt(h, 0);
      const dayLbl = d !== prevDay ? `<span class="fc-day">${+d.slice(4, 6)}/${+d.slice(6, 8)}</span>` : "";
      prevDay = d;
      return `${dayLbl}<span class="fc-h${h.interp ? " interp" : ""}" style="background:${MODE[mode].color}" title="${+d.slice(6, 8)}일 ${hh}시 · ${fmt(h.t, 0, "℃")} · 습도 ${fmt(h.rh, 0, "%")} · ${MODE[mode].label}${h.interp ? " (3시간 간격 예보 사이 보간)" : ""}">${hh % 3 === 0 ? hh : ""}</span>`;
    }).join("");
    $("fc-legend").innerHTML = ["mist", "flush", "night", "rain", "off"].map((m) => `<span><i style="background:${MODE[m].color}"></i>${MODE[m].label}</span>`).join("")
      + (hrs.some((h) => h.interp) ? `<span><i class="interp" style="background:${MODE.off.color}"></i>흐린 칸: 3시간 간격 예보 사이를 보간한 시간</span>` : "");
    const m3 = (l) => (l / 1000).toFixed(1);
    const E = Object.entries(days);
    $("fc-body").innerHTML = E.map(([d, o]) => {
      const on = o.n.mist + o.n.flush + o.n.night;
      return `<tr><td>${+d.slice(4, 6)}월 ${+d.slice(6, 8)}일</td><td>${fmt(o.tmax, 0, "℃")}</td>
        <td>${o.n.mist}시간</td><td>${o.n.flush}시간</td><td>${o.n.night}시간</td>
        <td>${on || o.nHi ? `${m3(o.mid)}㎥ <span class="muted">(${m3(o.lo)}~${m3(o.hi)})</span>` : "–"}</td></tr>`;
    }).join("");
    const tot = E.reduce((a, [, o]) => a + o.mid, 0), hrsOn = E.reduce((a, [, o]) => a + o.n.mist + o.n.flush + o.n.night, 0);
    const tmax = Math.max(...E.map(([, o]) => o.tmax));
    $("fc-answer").innerHTML = hrsOn
      ? `<b>${focusName()}은 ${S.fcSrc === "ex" ? "이 4일 동안" : `앞으로 ${E.length}일 동안`} 약 ${hrsOn}시간 가동하고, 물은 약 ${m3(tot)}㎥ 쓸 것으로 예상됩니다.</b> 날짜별 내역은 아래 표와 같습니다.`
      : `<b>${focusName()}은 앞으로 ${E.length}일 동안 가동할 시간이 없습니다.</b> 예보 최고기온 ${fmt(tmax, 0, "℃")}가 가동 기준 30℃보다 낮습니다. 위 <b>여름 예시</b>를 누르면 여름철 모습을 볼 수 있습니다.`;
    bindSummer($("fc-answer"));
    if (S.fcSrc === "ex") {
      $("fc-stamp").innerHTML = `<b>여름 예시</b>입니다. 2026년 여름 가장 더운 날 앞뒤 4일의 실제 관측값(S-DoT 동대문구 평균)을 예보 대신 넣어, 여름철에 이 화면이 어떻게 쓰이는지 보여 줍니다. 위 <b>실제 예보</b> 버튼을 누르면 기상청 예보로 돌아갑니다.`;
      return;
    }
    const base = k.short ? k.short.base : k.ultra.base;
    $("fc-stamp").textContent = `기상청 단기예보(${+base.slice(4, 6)}/${+base.slice(6, 8)} ${+base.slice(8, 10)}시 발표, 동대문구 격자)를 ②와 같은 규칙에 넣어 시간마다 가동 여부를 미리 판정했습니다. 칸 하나가 한 시간입니다.`;
  }
  function initAssume() {
    const bind = (id, key) => { const el = $(id); el.value = W[key]; el.oninput = () => { const v = parseFloat(el.value); if (!Number.isNaN(v)) { W[key] = v; renderForecast(); } }; };
    bind("w-noz", "nozzlesPerPole"); bind("w-lpm", "lpmPerNozzle"); bind("w-mm", "flushMm"); bind("w-sw", "sidewalkM");
  }

  // ---------------------------------------------------------------- ② 차트
  let chartT, chartRH;
  const bandPlugin = {
    id: "bands",
    beforeDatasetsDraw(chart, _args, opts) {
      const flags = opts.flags || [];
      const { ctx, chartArea: a, scales: { x } } = chart;
      if (!a || !flags.length) return;
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
        { label: "기상청", data: [], borderColor: "#6B7280", borderWidth: 1.5, borderDash: [2, 3], pointRadius: 0, tension: 0.25 },
      ] },
      options: {
        maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          title: { display: true, text: `${label} (기준 ${threshold}${unit})`, align: "start", color: "#142A52", font: { weight: "600", size: 13 } },
          tooltip: { callbacks: { label: (c) => c.datasetIndex === 0 ? `S-DoT ${c.parsed.y.toFixed(1)}${unit}` : c.datasetIndex === 2 ? `기상청 ${c.parsed.y.toFixed(1)}${unit}` : `기준 ${threshold}${unit}` } },
          bands: { flags: [], cursor: null },
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 8, autoSkip: true, maxRotation: 0 } },
          y: { suggestedMin: yMin, suggestedMax: yMax, grid: { color: "#EEF1F5" }, ticks: { callback: (v) => v + unit } },
        },
      },
    });
  }
  function seriesForView() {
    if (S.view === "live") {
      const ser = (S.data.realtime && S.data.realtime.series) || [];
      return { labels: ser.map((p) => `${+p.time.slice(6, 8)}일 ${+p.time.slice(8, 10)}시`), t: ser.map((p) => p.t), rh: ser.map((p) => p.rh), hours: ser.map((p) => +p.time.slice(8, 10)) };
    }
    const hs = (S.data.replay.days[S.dayIdx] || { hours: [] }).hours;
    return { labels: hs.map((h) => h.h + "시"), t: hs.map((h) => h.ta), rh: hs.map((h) => h.rh), hours: hs.map((h) => h.h),
             asos: hs.map((h) => (h.asos == null ? null : h.asos)), asosRh: hs.map((h) => (h.asos_rh == null ? null : h.asos_rh)) };
  }
  function updateCharts() {
    const d = seriesForView();
    const flags = d.t.map((t, i) => t >= RULE.mistTa && d.rh[i] < RULE.mistRh && d.hours[i] >= RULE.dayStart && d.hours[i] < RULE.dayEnd);
    [[chartT, d.t, RULE.mistTa, d.asos], [chartRH, d.rh, RULE.mistRh, d.asosRh]].forEach(([c, ys, th, asos]) => {
      c.data.labels = d.labels; c.data.datasets[0].data = ys; c.data.datasets[1].data = ys.map(() => th);
      c.data.datasets[2].data = asos || []; c.options.plugins.bands.flags = flags;
    });
    $("chart-note").textContent = S.view === "live"
      ? "최근 48시간 동대문구 S-DoT 센서 평균입니다. 서울시 자료가 늦게 올라오면 그래프 끝이 현재보다 앞설 수 있습니다."
      : "실선은 동대문구 S-DoT 센서 평균, 점선은 기상청 서울 관측값입니다. 세로 점선이 지금 보고 있는 시각입니다.";
    updateChartCursor();
  }
  function updateChartCursor() {
    if (!chartT) return;
    const d = seriesForView();
    const cur = S.view === "live" ? d.labels.length - 1 : d.hours.indexOf(S.hour);
    [chartT, chartRH].forEach((c) => { c.options.plugins.bands.cursor = cur; c.update("none"); });
  }

  // ---------------------------------------------------------------- 화면 전환·재생
  function setView(v) {
    S.view = v;
    $("tab-live").classList.toggle("on", v === "live"); $("tab-replay").classList.toggle("on", v === "replay");
    $("tab-live").setAttribute("aria-selected", v === "live"); $("tab-replay").setAttribute("aria-selected", v === "replay");
    $("replay-ctrl").hidden = v !== "replay";
    stopPlay();
    $("src-note").textContent = v === "live"
      ? "실시간 자료: 서울 열린데이터광장 S-DoT 환경정보(1시간 평균)와 기상청 초단기실황·단기예보를 GitHub Actions로 매시간 수집합니다."
      : "재생 자료: " + (S.data.replay.source || "") + ". " + (S.data.replay.note || "");
    updateCharts();
    render();
  }
  function stopPlay() {
    if (S.playing) { clearInterval(S.playing); S.playing = null; }
    $("play").textContent = "재생"; $("play").classList.remove("on");
  }
  function stepHour() {
    S.hour += 1;
    if (S.hour > 23) {   // 자정을 넘기면 다음 날로
      S.hour = 0;
      S.dayIdx = (S.dayIdx + 1) % S.data.replay.days.length;
      $("day-select").value = String(S.dayIdx);
      updateCharts();
    }
    $("hour").value = S.hour;
    render();
  }

  async function init() {
    const g = M.getJSON;
    const [segments, sensors, shades, hydrants, replay, realtime, population, trees, kma, boundary, vuln, solweig] = await Promise.all([
      g("data/segments.json", []), g("data/sensors.json", []), g("data/shades.json", []), g("data/hydrants.json", []),
      g("data/replay.json", { days: [] }), g("data/realtime.json", {}), g("data/population.json", null),
      g("data/trees.json", []), g("data/kma.json", {}), g("data/boundary.json", null),
      g("data/vuln.json", null), g("data/solweig.json", null),
    ]);
    S.data = { segments, sensors, shades, hydrants, replay, realtime, population, trees, kma, boundary, vuln, solweig };
    try { thermalInit(); } catch (e) { console.warn("열 스트레스 준비 실패", e); TH = null; }

    initMap();
    chartT = makeChart("chart-t", "기온", "#C0392B", RULE.mistTa, "℃", 22, 38);
    chartRH = makeChart("chart-rh", "습도", "#3B6FB6", RULE.mistRh, "%", 30, 100);

    const sel = $("day-select");
    sel.innerHTML = replay.days.map((d, i) => `<option value="${i}">${d.label}</option>`).join("");
    S.dayIdx = hottestIdx(); sel.value = String(S.dayIdx);
    sel.onchange = () => { S.dayIdx = +sel.value; updateCharts(); render(); };
    $("hour").oninput = (e) => { S.hour = +e.target.value; render(); };
    document.querySelectorAll("#quick-hours button").forEach((b) => { b.onclick = () => { stopPlay(); S.hour = +b.dataset.h; $("hour").value = S.hour; render(); }; });
    document.querySelectorAll("#focus-btns button").forEach((b) => { b.onclick = () => focusCorridor(b.dataset.c); });
    document.querySelectorAll("#route-btns button").forEach((b) => { b.onclick = () => { S.routeC = b.dataset.c; render(); }; });
    $("fire-btn").onclick = () => {
      S.fireMode = !S.fireMode; if (!S.fireMode) S.fire = null;
      $("fire-btn").classList.toggle("on", S.fireMode); $("map").classList.toggle("picking", S.fireMode);
      render();
    };
    $("play").onclick = () => {
      if (S.playing) return stopPlay();
      $("play").textContent = "일시정지"; $("play").classList.add("on");
      S.playing = setInterval(stepHour, 900);
    };
    $("tab-live").onclick = () => setView("live");
    $("tab-replay").onclick = () => setView("replay");

    initAssume();
    vulnInit();
    initSens();
    try { computePriority(); } catch (e) { console.warn("우선순위 계산 실패", e); }
    $("prio-sort").onclick = () => { S.sortPrio = !S.sortPrio; $("prio-sort").classList.toggle("on", S.sortPrio); renderTable(); };
    S.ana = "none";
    const chips = (sel, key) => document.querySelectorAll(sel + " button").forEach((b) => (b.onclick = () => {
      S[key] = b.dataset[Object.keys(b.dataset)[0]];
      document.querySelectorAll(sel + " button").forEach((x) => x.classList.toggle("on", x === b));
      render();
    }));
    chips("#ana-btns", "ana");
    $("ana-btns").addEventListener("click", () => {
      if (S.ana !== "cool" || map.getZoom() >= 16) return;
      const pts = S.data.segments.filter(inFocus).flatMap((x) => x.coords);
      const c = S.selected != null ? S.data.segments[S.selected].coords[2] : pts[Math.floor(pts.length / 2)];
      map.setView(c, 16, { animate: false });   // 냉각 효과는 보행축 20m 안만 계산하므로 확대해서 보여 준다
    }); chips("#cool-mode", "coolMode"); chips("#vuln-mode", "vulnMode");
    document.querySelectorAll("#fc-src button").forEach((b) => (b.onclick = () => { S.fcSrc = b.dataset.s; renderForecast(); }));
    document.querySelectorAll("#metric-btns button").forEach((b) => (b.onclick = () => { S.metric = b.dataset.m; render(); }));
    map.on("mousemove", onMapMove);
    map.fitBounds(L.latLngBounds(segments.flatMap((s) => s.coords)).pad(0.12), { animate: false });
    const hasLive = (realtime && realtime.sensors && realtime.sensors.length) || (kma && kma.ncst);
    setView(hasLive ? "live" : "replay");
    renderForecast();
  }

  init();
})();
