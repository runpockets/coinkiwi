// Zero-dependency SVG chart & sparkline renderer for CoinKiwi.

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatAxisTime(ts, range = "24h") {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  if (range === "24h") {
    const hrs = String(d.getHours()).padStart(2, "0");
    const mins = String(d.getMinutes()).padStart(2, "0");
    if (hrs === "00" && mins === "00") {
      return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    }
    return `${hrs}:${mins}`;
  }
  if (range === "7d" || range === "1m" || range === "3m") {
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

function formatTooltipDate(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function renderSparklineSvg(points, isUp = true) {
  const valid = Array.isArray(points)
    ? points.filter((n) => typeof n === "number" && Number.isFinite(n))
    : [];
  const w = 135;
  const h = 44;
  const stroke = isUp ? "var(--ck-up)" : "var(--ck-down)";

  if (valid.length < 2) {
    return `<svg class="ck-sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <line x1="2" y1="${h / 2}" x2="${w - 2}" y2="${h / 2}" stroke="var(--ck-border)" stroke-width="1.5" stroke-dasharray="3 3" />
    </svg>`;
  }

  let min = Infinity;
  let max = -Infinity;
  for (const v of valid) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || Math.abs(max) * 0.01 || 1;
  const padY = 4;
  const innerH = h - padY * 2;
  const coords = valid.map((v, i) => {
    const x = ((i / (valid.length - 1)) * (w - 4) + 2).toFixed(1);
    const y = (padY + innerH - ((v - min) / span) * innerH).toFixed(1);
    return `${x},${y}`;
  });

  return `<svg class="ck-sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polyline
      fill="none"
      stroke="${stroke}"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      points="${coords.join(" ")}"
    />
  </svg>`;
}

const chartObservers = new WeakMap();

function observeResize(container, draw) {
  const prev = chartObservers.get(container);
  if (prev) prev.disconnect();
  if (typeof ResizeObserver === "undefined") return;
  let lastW = Math.round(container.clientWidth);
  let rafId = 0;
  const ro = new ResizeObserver((entries) => {
    const nextW = Math.round(entries[0]?.contentRect?.width || container.clientWidth);
    if (nextW > 40 && Math.abs(nextW - lastW) >= 4) {
      lastW = nextW;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        draw();
      });
    }
  });
  ro.observe(container);
  chartObservers.set(container, ro);
}

export function renderOverviewChart(container, history, { formatCompact, isUp = true }) {
  const valid = Array.isArray(history)
    ? history.filter((p) => Number.isFinite(p?.cap) && Number.isFinite(p?.date))
    : [];
  if (valid.length < 2) {
    container.innerHTML = `<div class="ck-chart-empty">Chart data unavailable</div>`;
    return;
  }

  function draw() {
    const w = Math.max(260, Math.round(container.clientWidth) || 420);
    const h = 152;
    const padL = 6;
    const padR = 54;
    const padT = 10;
    const padB = 24;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const vals = valid.map((p) => p.cap);
    const vols = valid.map((p) => p.volume || 0);
    const rawMin = Math.min(...vals);
    const rawMax = Math.max(...vals);
    const padRange = (rawMax - rawMin) * 0.14 || rawMax * 0.01 || 1;
    const minVal = rawMin - padRange;
    const maxVal = rawMax + padRange;
    const valSpan = maxVal - minVal || 1;
    const maxVol = Math.max(...vols, 1);

    const color = isUp ? "#22a047" : "#e15241";
    const gradId = `ov-grad-${Math.random().toString(36).slice(2, 8)}`;

    const pts = valid.map((p, i) => {
      const x = padL + (i / (valid.length - 1)) * plotW;
      const y = padT + plotH - ((p.cap - minVal) / valSpan) * plotH;
      return { x, y, p };
    });

    const linePath = pts
      .map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
      .join(" ");
    const areaPath = `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${(padT + plotH).toFixed(1)} L${pts[0].x.toFixed(1)},${(padT + plotH).toFixed(1)} Z`;

    // 4 horizontal gridlines & Y ticks
    const yTicks = [0, 0.33, 0.66, 1].map((t) => {
      const val = maxVal - t * valSpan;
      const y = padT + t * plotH;
      return { y, label: formatCompact(val) };
    });

    // Scale X ticks gently to available width
    const xCount = w >= 620 ? 6 : 4;
    const xTicks = [];
    for (let i = 0; i < xCount; i += 1) {
      const idx = Math.round(((i + 0.5) / xCount) * (valid.length - 1));
      xTicks.push({
        x: pts[idx].x,
        label: formatAxisTime(valid[idx].date, "24h"),
      });
    }

    // Volume baseline bars
    const barW = Math.max(2, Math.min(10, plotW / valid.length - 3));
    const volBars = pts
      .map((pt) => {
        const barH = Math.max(3, ((pt.p.volume || 0) / maxVol) * (plotH * 0.22));
        return `<rect x="${(pt.x - barW / 2).toFixed(1)}" y="${(padT + plotH - barH).toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="1" fill="var(--ck-vol-bar)" />`;
      })
      .join("");

    container.innerHTML = `
      <svg class="ck-overview-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="24-hour Global Market Cap Chart">
        <defs>
          <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.28" />
            <stop offset="100%" stop-color="${color}" stop-opacity="0.02" />
          </linearGradient>
        </defs>
        ${yTicks
          .map(
            (t) =>
              `<line x1="${padL}" y1="${t.y.toFixed(1)}" x2="${padL + plotW}" y2="${t.y.toFixed(1)}" stroke="var(--ck-grid)" stroke-width="1" />
               <text x="${w - 4}" y="${(t.y + 3.5).toFixed(1)}" text-anchor="end" class="ck-axis-text">${esc(t.label)}</text>`,
          )
          .join("")}
        ${volBars}
        <path d="${areaPath}" fill="url(#${gradId})" />
        <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        <text x="${(padL + plotW - 6).toFixed(1)}" y="${(padT + plotH - 8).toFixed(1)}" text-anchor="end" class="ck-watermark">coinkiwi</text>
        ${xTicks
          .map(
            (t) =>
              `<text x="${t.x.toFixed(1)}" y="${h - 6}" text-anchor="middle" class="ck-axis-text">${esc(t.label)}</text>`,
          )
          .join("")}
      </svg>
    `;
  }

  draw();
  observeResize(container, draw);
}

export function renderDetailChart(
  container,
  history,
  {
    metric = "rate",
    range = "24h",
    formatAxis,
    formatTooltipValue,
    formatCompact,
  },
) {
  const valid = Array.isArray(history)
    ? history.filter((p) => Number.isFinite(p?.[metric]) && Number.isFinite(p?.date))
    : [];

  if (valid.length < 2) {
    container.innerHTML = `<div class="ck-detail-chart-empty">No historical data available for this timeframe.</div>`;
    return;
  }

  function draw() {
    const w = Math.max(300, Math.round(container.clientWidth) || 860);
    const h = w < 560 ? 280 : 360;
    const padL = 8;
    const padR = 76;
    const padT = 16;
    const padB = 30;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const vals = valid.map((p) => p[metric]);
    const vols = valid.map((p) => p.volume || 0);
    const firstVal = vals[0];
    const lastVal = vals[vals.length - 1];
    const isUp = lastVal >= firstVal;

    const rawMin = Math.min(...vals);
    const rawMax = Math.max(...vals);
    const margin = (rawMax - rawMin) * 0.08 || Math.abs(rawMax) * 0.01 || 1;
    const minVal = rawMin - margin;
    const maxVal = rawMax + margin;
    const valSpan = maxVal - minVal || 1;
    const maxVol = Math.max(...vols, 1);

    const color = isUp ? "#22a047" : "#e15241";
    const gradId = `dt-grad-${Math.random().toString(36).slice(2, 8)}`;

    const pts = valid.map((p, i) => {
      const x = padL + (i / (valid.length - 1)) * plotW;
      const y = padT + plotH - ((p[metric] - minVal) / valSpan) * plotH;
      return { x, y, p };
    });

    const linePath = pts
      .map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
      .join(" ");
    const areaPath = `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${(padT + plotH).toFixed(1)} L${pts[0].x.toFixed(1)},${(padT + plotH).toFixed(1)} Z`;

    const yTickCount = 6;
    const yTicks = [];
    for (let i = 0; i <= yTickCount; i += 1) {
      const t = i / yTickCount;
      const val = maxVal - t * valSpan;
      yTicks.push({
        y: padT + t * plotH,
        label: formatAxis(val),
      });
    }

    const xTickCount = w < 560 ? 4 : 6;
    const xTicks = [];
    for (let i = 0; i < xTickCount; i += 1) {
      const idx = Math.round(((i + 0.5) / xTickCount) * (valid.length - 1));
      xTicks.push({
        x: pts[idx].x,
        label: formatAxisTime(valid[idx].date, range),
      });
    }

    const volMaxH = plotH * 0.16;
    const barW = Math.max(2, Math.min(8, plotW / valid.length - 1.5));
    const volBars = pts
      .map((pt) => {
        const barH = Math.max(2, ((pt.p.volume || 0) / maxVol) * volMaxH);
        return `<rect x="${(pt.x - barW / 2).toFixed(1)}" y="${(padT + plotH - barH).toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="var(--ck-vol-bar)" />`;
      })
      .join("");

    const lastPt = pts[pts.length - 1];
    const pillY = Math.max(padT + 10, Math.min(padT + plotH - 10, lastPt.y));
    const pillLabel = formatAxis(lastVal);

    container.innerHTML = `
      <div class="ck-detail-chart-stage">
        <svg class="ck-detail-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Historical price chart">
          <defs>
            <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="${color}" stop-opacity="0.28" />
              <stop offset="100%" stop-color="${color}" stop-opacity="0.01" />
            </linearGradient>
          </defs>

          ${yTicks
            .map(
              (t) => `
            <line x1="${padL}" y1="${t.y.toFixed(1)}" x2="${padL + plotW}" y2="${t.y.toFixed(1)}" stroke="var(--ck-grid)" stroke-width="1" />
            ${Math.abs(t.y - pillY) >= 16 ? `<text x="${w - 6}" y="${(t.y + 4).toFixed(1)}" text-anchor="end" class="ck-axis-text">${esc(t.label)}</text>` : ""}
          `,
            )
            .join("")}

          ${volBars}
          <path d="${areaPath}" fill="url(#${gradId})" />
          <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />

          <line
            x1="${padL}"
            y1="${pts[0].y.toFixed(1)}"
            x2="${padL + plotW}"
            y2="${pts[0].y.toFixed(1)}"
            stroke="var(--ck-muted-line)"
            stroke-width="1"
            stroke-dasharray="4 4"
            opacity="0.55"
          />

          <g class="ck-current-pill">
            <rect x="${(padL + plotW + 4).toFixed(1)}" y="${(pillY - 11).toFixed(1)}" width="${(padR - 8).toFixed(1)}" height="22" rx="4" fill="${color}" />
            <text x="${(padL + plotW + 4 + (padR - 8) / 2).toFixed(1)}" y="${(pillY + 4).toFixed(1)}" text-anchor="middle" fill="#ffffff" font-size="11" font-weight="700" font-family="inherit">${esc(pillLabel)}</text>
          </g>

          <text x="${(padL + plotW - 10).toFixed(1)}" y="${(padT + plotH - 10).toFixed(1)}" text-anchor="end" class="ck-watermark">coinkiwi</text>

          ${xTicks
            .map(
              (t) =>
                `<text x="${t.x.toFixed(1)}" y="${h - 8}" text-anchor="middle" class="ck-axis-text">${esc(t.label)}</text>`,
            )
            .join("")}

          <g class="ck-crosshair" style="display:none">
            <line class="ck-cross-v" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="var(--ck-crosshair)" stroke-width="1" stroke-dasharray="3 3" />
            <line class="ck-cross-h" x1="${padL}" y1="0" x2="${padL + plotW}" y2="0" stroke="var(--ck-crosshair)" stroke-width="1" stroke-dasharray="3 3" />
            <circle class="ck-cross-dot" cx="0" cy="0" r="4.5" fill="${color}" stroke="var(--ck-surface)" stroke-width="2" />
          </g>

          <rect class="ck-chart-hit" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent" />
        </svg>
        <div class="ck-chart-tooltip ck-hidden"></div>
      </div>
    `;

    const stage = container.querySelector(".ck-detail-chart-stage");
    const svg = container.querySelector(".ck-detail-svg");
    const hit = container.querySelector(".ck-chart-hit");
    const crosshair = container.querySelector(".ck-crosshair");
    const crossV = container.querySelector(".ck-cross-v");
    const crossH = container.querySelector(".ck-cross-h");
    const crossDot = container.querySelector(".ck-cross-dot");
    const tooltip = container.querySelector(".ck-chart-tooltip");

    function showAtClientX(clientX) {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const relX = ((clientX - rect.left) / rect.width) * w;
      const clampedX = Math.max(padL, Math.min(padL + plotW, relX));
      const ratio = (clampedX - padL) / plotW;
      const idx = Math.max(0, Math.min(pts.length - 1, Math.round(ratio * (pts.length - 1))));
      const pt = pts[idx];

      crosshair.style.display = "block";
      crossV.setAttribute("x1", pt.x.toFixed(1));
      crossV.setAttribute("x2", pt.x.toFixed(1));
      crossH.setAttribute("y1", pt.y.toFixed(1));
      crossH.setAttribute("y2", pt.y.toFixed(1));
      crossDot.setAttribute("cx", pt.x.toFixed(1));
      crossDot.setAttribute("cy", pt.y.toFixed(1));

      const metricLabel = metric === "cap" ? "Market Cap" : "Price";
      const volLine =
        pt.p.volume > 0
          ? `<div class="ck-tt-row"><span>24h Vol</span><strong>${esc(formatCompact(pt.p.volume))}</strong></div>`
          : "";
      tooltip.innerHTML = `
        <div class="ck-tt-date">${esc(formatTooltipDate(pt.p.date))}</div>
        <div class="ck-tt-row"><span>${metricLabel}</span><strong>${esc(formatTooltipValue(pt.p[metric]))}</strong></div>
        ${volLine}
      `;
      tooltip.classList.remove("ck-hidden");

      const stageRect = stage.getBoundingClientRect();
      const pxX = (pt.x / w) * stageRect.width;
      const pxY = (pt.y / h) * stageRect.height;
      const placeLeft = pxX > stageRect.width * 0.62;
      tooltip.style.left = placeLeft
        ? `${Math.max(8, pxX - tooltip.offsetWidth - 14)}px`
        : `${Math.min(stageRect.width - tooltip.offsetWidth - 8, pxX + 14)}px`;
      tooltip.style.top = `${Math.max(8, Math.min(stageRect.height - tooltip.offsetHeight - 8, pxY - 24))}px`;
    }

    function hide() {
      crosshair.style.display = "none";
      tooltip.classList.add("ck-hidden");
    }

    hit.addEventListener("pointermove", (e) => showAtClientX(e.clientX));
    hit.addEventListener("pointerdown", (e) => showAtClientX(e.clientX));
    hit.addEventListener("pointerleave", hide);
  }

  draw();
  observeResize(container, draw);
}
