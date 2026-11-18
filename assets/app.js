/* 동대문구 소화전 연계 쿨링 보행축 대시보드 */
(() => {
  "use strict";
  const M = window.CoolModel;
  const { RULE, MODE, TYPE_LABEL } = M;
  const W = { ...M.WATER };
  const SHORT = { mist: "미스트", flush: "살수만", night: "저녁 살수", off: "정지", passive: "쿨페이브먼트", fire: "119 차단" };
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
  let map, layerHyd, layerShade, layerTree, layerSdot, layerSeg, layerPop, layerFire;
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
    layerSeg = L.layerGroup().addTo(map); layerFire = L.layerGroup().addTo(map);

    (S.data.hydrants || []).forEach((h) => {
      L.circleMarker([h.lat, h.lon], { radius: h.type === 1 ? 2.6 : 2, weight: 0, fillOpacity: 0.55, fillColor: h.type === 1 ? "#1D3A66" : "#B9C2D0" })
        .bindTooltip((h.type === 1 ? "지상 소화전 · " : "지하 소화전 · ") + h.addr, { className: "t-lbl" }).addTo(layerHyd);
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

    $("legend").innerHTML = ["mist", "flush", "night", "off", "passive", "fire"].map((k) => `<span><i style="background:${MODE[k].color}"></i>${MODE[k].label}</span>`).join("")
      + `<span><i style="background:#fff;border:1.5px solid #2E7D4F;height:9px;width:9px;border-radius:50%"></i>그늘막</span>`
      + `<span><i style="background:#fff;border:2px solid #142A52;height:10px;width:10px;border-radius:50%"></i>기온 센서(S-DoT)</span>`
      + `<span><i style="background:linear-gradient(90deg,#EEF2F8,#41679F);width:28px"></i>생활인구 (짙을수록 많음)</span>`;

    map.on("click", (e) => { if (!S.fireMode) return; S.fire = [e.latlng.lat, e.latlng.lng]; render(); });
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
  function selectSeg(i) {
    const seg = S.data.segments[i];
    if (!inFocus(seg)) { S.selected = i; focusCorridor(seg.corridor_id); }
    else { S.selected = i; render(); }
    const row = document.querySelector(`#seg-body tr[data-i="${i}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
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
      if (n && typeof n.T1H === "number" && (age > 3 || !list.length)) {
        // S-DoT가 늦으면 기상청 실황 기온을 기준으로 하고, 센서 사이의 차이만 S-DoT에서 가져온다
        const mean = list.length ? list.reduce((a, s) => a + s.t, 0) / list.length : 0;
        list = list.map((s) => ({ ...s, t: n.T1H + (s.t - mean), rh: n.REH }));
        return { hour: +n.time.slice(8, 10), sensors: list, uniform: { t: n.T1H, rh: n.REH }, wind, src: "kma", age, obs: rt.latest_obs, ncstTime: n.time };
      }
      const hour = rt.latest_obs ? +rt.latest_obs.slice(8, 10) : new Date().getHours();
      return { hour, sensors: list, uniform: null, wind, src: list.length ? "sdot" : "none", age, obs: rt.latest_obs };
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
      let mode = M.modeOf(seg, ta, rh, R.hour);
      if (withFire && S.fire && seg.seg_type !== "D" && seg.coords.some((c) => distM(c, S.fire) <= 500)) mode = "fire";
      const e = M.effect(ta, rh, M.effFor(seg));
      return { seg, mode, ta, rh, tw: e.tw, app: M.apparent(ta, e.tw), dTa: mode === "mist" ? e.dTa : 0, dTapp: mode === "mist" ? e.dTapp : 0 };
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
      S.segLayers[i].setStyle({ color: MODE[r.mode].color, weight: S.selected === i ? 12 : on ? 7 : 5, opacity: on ? 0.95 : 0.3, dashArray: r.mode === "fire" ? "2 9" : null });
    });

    layerFire.clearLayers();
    if (S.fire) {
      L.circle(S.fire, { radius: 500, color: "#C0392B", weight: 1.5, fillOpacity: 0.06, dashArray: "4 4", interactive: false }).addTo(layerFire);
      L.circleMarker(S.fire, { radius: 6, color: "#fff", weight: 2, fillColor: "#C0392B", fillOpacity: 1 }).addTo(layerFire);
    }

    layerSdot.clearLayers();
    const valid = new Map(R.sensors.map((s) => [s.serial, s]));
    S.data.sensors.forEach((s) => {
      const v = valid.get(s.serial);
      const m = L.circleMarker([s.lat, s.lon], { radius: 6, weight: 2, color: v ? "#142A52" : "#A3AAB6", fillColor: "#fff", fillOpacity: 1, dashArray: v ? null : "2 2" });
      m.bindTooltip(`기온 센서 ${s.serial}<br>${s.addr}<br>${v ? `${fmt(v.t, 1, "℃")} · ${fmt(v.rh, 0, "%")}` : "정상값 없음"}`, { className: "t-lbl" });
      if (v) m.bindTooltip(fmt(v.t, 1, "℃"), { permanent: true, direction: "top", offset: [0, -6], className: "t-lbl" });
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

    const red = prof.overBase > 0 ? (1 - prof.overOn / prof.overBase) * 100 : 0;
    const gap = prof.rests.length ? prof.length / prof.rests.length : null;
    $("route-stats").innerHTML = `
      <div><span>걷는 거리</span><b>${(prof.length / 1000).toFixed(2)}km</b><em>약 ${Math.round(prof.minutes)}분</em></div>
      <div><span>체감 33℃ 넘는 더위 노출</span><b>${prof.overBase.toFixed(0)} → ${prof.overOn.toFixed(0)}</b><em>℃·분, ${red > 0 ? `${red.toFixed(0)}% 감소` : "변화 없음"}</em></div>
      <div><span>체감 1℃ 이상 시원한 쉼 구간</span><b>${prof.rests.length}곳</b><em>${gap ? `평균 ${Math.round(gap)}m마다` : "없음"}</em></div>`;

    const data = prof.pts;
    if (!chartRoute) {
      chartRoute = new Chart($("chart-route"), {
        type: "line",
        data: { datasets: [
          { label: "시설 없음", data: [], borderColor: "#9AA3AF", borderWidth: 1.6, pointRadius: 0, tension: 0.2 },
          { label: "시스템 가동", data: [], borderColor: "#0E7C86", backgroundColor: "rgba(14,124,134,0.12)", fill: "-1", borderWidth: 2, pointRadius: 0, tension: 0.2 },
          { label: "폭염주의보 기준 체감 33℃", data: [], borderColor: "#C0392B", borderWidth: 1, borderDash: [4, 4], pointRadius: 0 },
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
    chartRoute.data.datasets[0].data = data.map((p) => ({ x: p.d, y: p.base }));
    chartRoute.data.datasets[1].data = data.map((p) => ({ x: p.d, y: p.on }));
    chartRoute.data.datasets[2].data = data.length ? [{ x: 0, y: 33 }, { x: data[data.length - 1].d, y: 33 }] : [];
    chartRoute.update("none");
  }

  // ---------------------------------------------------------------- 표·상세
  function renderTable() {
    const rs = S.results;
    if (!rs.length) return;
    $("seg-body").innerHTML = rs.map((r, i) => {
      if (!inFocus(r.seg)) return "";
      const s = r.seg;
      const type = s.seg_type === "BC" ? `B/C<span class="muted hide-m"> (${s.type_provisional} 잠정)</span>` : s.seg_type;
      return `<tr data-i="${i}" class="${S.selected === i ? "sel" : ""}">
        <td>${s.seg_id}</td><td class="loc">${s.landmark.replace(/\s*\(.*$/, "")}<span class="muted hide-m"> ${(s.landmark.match(/\((.*)\)/) || ["", ""])[1]}</span></td>
        <td>${type}</td><td class="nw"><i class="dot" style="background:${MODE[r.mode].color}"></i>${SHORT[r.mode]}</td>
        <td>${fmt(r.ta, 1, "℃")}</td><td>${r.mode === "mist" ? signed(r.dTa) : "–"}</td></tr>`;
    }).join("");
    document.querySelectorAll("#seg-body tr").forEach((tr) => { tr.onclick = () => { const i = +tr.dataset.i; selectSeg(i); map.panTo(S.data.segments[i].coords[2]); }; });
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
        <dt>구간 사업비</dt><dd>${(s.capex_krw / 10000).toLocaleString()}만 원</dd>
      </dl>`;
  }

  // ---------------------------------------------------------------- ③ 예보
  function forecastHours() {
    const k = S.data.kma || {};
    const byTime = new Map();
    ((k.short && k.short.rows) || []).forEach((r) => { if (r.TMP != null) byTime.set(r.time, { time: r.time, t: r.TMP, rh: r.REH, ws: r.WSD, pop: r.POP }); });
    ((k.ultra && k.ultra.rows) || []).forEach((r) => { if (r.T1H != null) byTime.set(r.time, { time: r.time, t: r.T1H, rh: r.REH, ws: r.WSD, pop: (byTime.get(r.time) || {}).pop }); });
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
        out.push({ time: toT(toD(r.time) + h * 3.6e6), t: lerp(r.t, n.t), rh: lerp(r.rh, n.rh), ws: lerp(r.ws, n.ws), pop: r.pop, interp: true });
      }
    });
    return out;
  }
  function renderFormula() {
    const segs = S.data.segments.filter((s) => inFocus(s) && s.seg_type !== "D");
    const poles = segs.reduce((a, s) => a + s.fh_above_35m, 0), len = segs.reduce((a, s) => a + s.len_m, 0);
    const mist = poles * W.nozzlesPerPole * W.lpmPerNozzle * 60 * M.DUTY, flush = len * W.sidewalkM * W.flushMm;
    $("w-formula").innerHTML = `${focusName()} 기준 · 미스트: 소화전 ${poles}기 × 노즐 ${W.nozzlesPerPole}개 × ${W.lpmPerNozzle}L/분 × 60분 × 가동 비율 ⅔ = <b>시간당 ${Math.round(mist).toLocaleString()}L</b><br>`
      + `바닥 살수: 구간 길이 ${Math.round(len).toLocaleString()}m × 폭 ${W.sidewalkM}m × ${W.flushMm}mm = <b>시간당 ${Math.round(flush).toLocaleString()}L</b> (미스트·살수만·저녁 살수 때 모두 사용)`;
  }
  function renderForecast() {
    renderFormula();
    const hrs = forecastHours();
    const k = S.data.kma || {};
    if (!hrs.length) {
      $("fc-strip").innerHTML = ""; $("fc-legend").innerHTML = "";
      $("fc-answer").innerHTML = "아직 기상청 예보를 받지 못했습니다. GitHub Actions에서 수집을 한 번 실행하면 표시됩니다.";
      $("fc-body").innerHTML = `<tr><td colspan="6" class="muted">예보 자료 없음</td></tr>`;
      return;
    }
    const segs = S.data.segments.filter(inFocus);
    const modeAt = (h, dt) => M.modeOf({ seg_type: "A" }, h.t + dt, h.rh, +h.time.slice(8, 10));
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
    $("fc-legend").innerHTML = ["mist", "flush", "night", "off"].map((m) => `<span><i style="background:${MODE[m].color}"></i>${MODE[m].label}</span>`).join("")
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
      ? `<b>${focusName()}은 앞으로 ${E.length}일 동안 약 ${hrsOn}시간 가동하고, 물은 약 ${m3(tot)}㎥ 쓸 것으로 예상됩니다.</b> 날짜별 내역은 아래 표와 같습니다.`
      : `<b>${focusName()}은 앞으로 ${E.length}일 동안 가동할 시간이 없습니다.</b> 예보 최고기온 ${fmt(tmax, 0, "℃")}가 가동 기준 30℃보다 낮습니다.<br><span class="muted">여름에는 하루 미스트 6~8시간, 저녁 살수 1~3시간이 잡힙니다.</span>${summerLink("여름 재생으로 보기")}`;
    bindSummer($("fc-answer"));
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
    const [segments, sensors, shades, hydrants, replay, realtime, population, trees, kma, boundary] = await Promise.all([
      g("data/segments.json", []), g("data/sensors.json", []), g("data/shades.json", []), g("data/hydrants.json", []),
      g("data/replay.json", { days: [] }), g("data/realtime.json", {}), g("data/population.json", null),
      g("data/trees.json", []), g("data/kma.json", {}), g("data/boundary.json", null),
    ]);
    S.data = { segments, sensors, shades, hydrants, replay, realtime, population, trees, kma, boundary };

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
    map.fitBounds(L.latLngBounds(segments.flatMap((s) => s.coords)).pad(0.12), { animate: false });
    const hasLive = (realtime && realtime.sensors && realtime.sensors.length) || (kma && kma.ncst);
    setView(hasLive ? "live" : "replay");
    renderForecast();
  }

  init();
})();
