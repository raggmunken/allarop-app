/**
 * SVG-diagramgenerator för Allarop-guidar.
 *
 * Används av SSR-renderaren för att automatiskt visualisera numeriska tabeller
 * som finns i markdown-artiklarna. Ursprungstabellen behålls intakt för
 * tillgänglighet, SEO och användare som föredrar exakta siffror.
 */

const BRAND = {
  accent: "#0e7d63",
  ink: "#111110",
  bg: "#f4f3ef",
  inkSoft: "#76746c",
} as const;

const PALETTE = [
  BRAND.accent,
  "#14967a",
  "#1aaf8f",
  "#0d6b55",
  "#3d8b7a",
  "#6aa89b",
  "#9ec4bc",
];

interface ChartDatum {
  label: string;
  value: number;
  raw?: string;
}

interface ChartOptions {
  title?: string;
  unit?: string;
  width?: number;
  height?: number;
}

// --- HTML helpers ----------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function formatNumber(n: number): string {
  return n.toLocaleString("sv-SE", { maximumFractionDigits: 2 });
}

function rnd(n: number, digits = 2): number {
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

function parseNumericValue(text: string): number | null {
  const cleaned = text
    .replace(/\s/g, "")
    .replace(/\u00a0/g, "")
    .replace(/\./g, "") // tusentalsavgränsare
    .replace(/,/g, ".") // svensk decimal
    .replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  return n;
}

function isNumericCell(text: string): boolean {
  return parseNumericValue(text) !== null;
}

function unitFromText(text: string): string {
  if (/\%/.test(text)) return "%";
  if (/kr|SEK|:-/.test(text)) return "kr";
  return "";
}

// --- Table parsing ---------------------------------------------------------

interface ParsedTable {
  headers: string[];
  rows: ChartDatum[];
}

function parseTable(tableHtml: string): ParsedTable | null {
  const rowMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi);
  if (!rowMatches || rowMatches.length < 2) return null;

  const rows: string[][] = [];
  for (const row of rowMatches) {
    const cellMatches = row.match(/<t(?:h|d)[\s\S]*?<\/t(?:h|d)>/gi);
    if (!cellMatches) continue;
    rows.push(cellMatches.map(stripTags));
  }
  if (rows.length < 2) return null;

  // Anta att första raden är rubriker om den innehåller <th> eller ser ut som rubriker.
  const firstRowHasTh = /<th[\s>]/i.test(rowMatches[0]!);
  const headerOffset = firstRowHasTh ? 1 : 0;
  const headers = rows[0]!;
  const dataRows = rows.slice(headerOffset).filter((r) => r.length >= 2);
  if (dataRows.length < 2) return null;

  const parsed: ChartDatum[] = [];
  for (const cells of dataRows) {
    const label = cells[0]!.trim();
    const valueCell = cells[1]!.trim();
    const value = parseNumericValue(valueCell);
    if (label === "" || value === null) continue;
    parsed.push({ label, value, raw: valueCell });
  }
  if (parsed.length < 2) return null;

  return { headers, rows: parsed };
}

function looksLikeYears(labels: string[]): boolean {
  return labels.every((l) => /^\d{4}$/.test(l.trim()));
}

const MONTH_RE = /^(januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december|jan|feb|mar|apr|jun|jul|aug|sep|okt|nov|dec)\b|\d{4}-\d{2}/i;
function looksLikeMonths(labels: string[]): boolean {
  return labels.every((l) => MONTH_RE.test(l.trim()));
}

function detectChartType(table: ParsedTable): "bar" | "line" | "pie" | null {
  const labels = table.rows.map((r) => r.label);
  const values = table.rows.map((r) => r.value);

  // Hoppa över rena textjämförelser (t.ex. Ja/Nej, kategorinamn i värdekolumnen).
  const numericRatio = values.length / table.rows.length; // alltid 1 här, men behåll för tydlighet
  if (numericRatio < 1) return null;

  const sum = values.reduce((a, b) => a + b, 0);
  const allUnderHundred = values.every((v) => v <= 100 && v >= 0);
  if (allUnderHundred && sum >= 95 && sum <= 100.5) return "pie";

  if (looksLikeYears(labels) || looksLikeMonths(labels)) return "line";

  return "bar";
}

// --- SVG primitives --------------------------------------------------------

function svgWrapper(
  width: number,
  height: number,
  title: string,
  ariaLabel: string,
  content: string
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeHtml(
    ariaLabel
  )}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="max-width:100%;height:auto;display:block;">
  <title>${escapeHtml(title)}</title>
  ${content}
</svg>`;
}

function chartFigure(title: string, chartSvg: string, caption: string): string {
  return `<figure class="chart-figure" style="margin:1.75rem 0;padding:1rem;background:${BRAND.bg};border-radius:12px;">
  ${chartSvg}
  <figcaption style="margin-top:0.75rem;text-align:center;color:${BRAND.inkSoft};font-size:0.875rem;">${escapeHtml(
    caption
  )}</figcaption>
</figure>`;
}

// --- Bar chart -------------------------------------------------------------

export function renderBarChart(
  data: ChartDatum[],
  options: ChartOptions = {}
): string {
  const width = options.width ?? 720;
  const height = options.height ?? 420;
  const margin = { top: options.title ? 64 : 40, right: 30, bottom: 80, left: 70 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const maxValue = Math.max(...data.map((d) => d.value));
  const niceMax = niceCeiling(maxValue);
  const barGap = 0.25;
  const barW = rnd(innerW / data.length * (1 - barGap));
  const barSpacing = rnd(innerW / data.length);

  let content = "";

  // Grid-linjer + Y-axel
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = rnd(margin.top + innerH - (i * innerH) / yTicks);
    const val = (i * niceMax) / yTicks;
    content += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#e5e4e0" stroke-width="1" />`;
    content += `<text x="${margin.left - 10}" y="${y + 4}" text-anchor="end" font-size="12" fill="${BRAND.inkSoft}">${escapeHtml(
      formatNumber(val) + (options.unit ?? "")
    )}</text>`;
  }

  // Stapel
  data.forEach((d, i) => {
    const h = rnd((d.value / niceMax) * innerH);
    const x = rnd(margin.left + i * barSpacing + (barGap * barSpacing) / 2);
    const y = rnd(margin.top + innerH - h);
    content += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${BRAND.accent}" rx="4" />`;
    content += `<text x="${x + barW / 2}" y="${y - 6}" text-anchor="middle" font-size="12" font-weight="600" fill="${BRAND.ink}">${escapeHtml(
      formatNumber(d.value) + (options.unit ?? "")
    )}</text>`;

    // X-etikett, rotera om lång
    const labelX = x + barW / 2;
    const labelY = margin.top + innerH + 20;
    const rotate = d.label.length > 10 ? `transform="rotate(35 ${labelX} ${labelY})"` : "";
    const anchor = d.label.length > 10 ? "start" : "middle";
    content += `<text x="${labelX}" y="${labelY}" ${rotate} text-anchor="${anchor}" font-size="12" fill="${BRAND.inkSoft}">${escapeHtml(
      d.label
    )}</text>`;
  });

  // X-axel
  content += `<line x1="${margin.left}" y1="${margin.top + innerH}" x2="${width - margin.right}" y2="${margin.top + innerH}" stroke="${BRAND.inkSoft}" stroke-width="1" />`;

  if (options.title) {
    content = `<text x="${width / 2}" y="28" text-anchor="middle" font-size="16" font-weight="700" fill="${BRAND.ink}">${escapeHtml(
      options.title
    )}</text>` + content;
  }

  const aria = `${options.title ?? "Stapeldiagram"}. ${data.length} kategorier. Högsta värde ${formatNumber(
    maxValue
  )}${options.unit ?? ""}.`;
  const svg = svgWrapper(width, height, options.title ?? "Stapeldiagram", aria, content);
  return chartFigure(
    options.title ?? "Stapeldiagram",
    svg,
    `${options.title ?? "Diagram"} över ${data.length} kategorier.`
  );
}

// --- Line chart ------------------------------------------------------------

export function renderLineChart(
  data: ChartDatum[],
  options: ChartOptions = {}
): string {
  const width = options.width ?? 720;
  const height = options.height ?? 420;
  const margin = { top: options.title ? 64 : 40, right: 40, bottom: 60, left: 70 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const maxValue = Math.max(...data.map((d) => d.value));
  const niceMax = niceCeiling(maxValue);
  const minValue = Math.min(0, ...data.map((d) => d.value));

  const xFor = (i: number) => rnd(margin.left + (i / (data.length - 1)) * innerW);
  const yFor = (v: number) =>
    rnd(margin.top + innerH - ((v - minValue) / (niceMax - minValue)) * innerH);

  let content = "";

  // Grid + Y-axel
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = minValue + (i * (niceMax - minValue)) / yTicks;
    const y = rnd(yFor(val));
    content += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#e5e4e0" stroke-width="1" />`;
    content += `<text x="${margin.left - 10}" y="${y + 4}" text-anchor="end" font-size="12" fill="${BRAND.inkSoft}">${escapeHtml(
      formatNumber(val) + (options.unit ?? "")
    )}</text>`;
  }

  // Area under line
  const areaPoints = data
    .map((d, i) => `${xFor(i)},${yFor(d.value)}`)
    .join(" ");
  content += `<polygon points="${margin.left},${margin.top + innerH} ${areaPoints} ${xFor(
    data.length - 1
  )},${margin.top + innerH}" fill="${BRAND.accent}" opacity="0.12" />`;

  // Line
  const linePath = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${xFor(i)} ${yFor(d.value)}`)
    .join(" ");
  content += `<path d="${linePath}" fill="none" stroke="${BRAND.accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />`;

  // Points + labels
  data.forEach((d, i) => {
    const x = xFor(i);
    const y = yFor(d.value);
    content += `<circle cx="${x}" cy="${y}" r="5" fill="${BRAND.accent}" stroke="#fff" stroke-width="2" />`;
    content += `<text x="${x}" y="${y - 12}" text-anchor="middle" font-size="12" font-weight="600" fill="${BRAND.ink}">${escapeHtml(
      formatNumber(d.value) + (options.unit ?? "")
    )}</text>`;
    // X-etikett
    content += `<text x="${x}" y="${margin.top + innerH + 22}" text-anchor="middle" font-size="12" fill="${BRAND.inkSoft}">${escapeHtml(
      d.label
    )}</text>`;
  });

  // Axes
  content += `<line x1="${margin.left}" y1="${margin.top + innerH}" x2="${width - margin.right}" y2="${margin.top + innerH}" stroke="${BRAND.inkSoft}" stroke-width="1" />`;
  content += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + innerH}" stroke="${BRAND.inkSoft}" stroke-width="1" />`;

  if (options.title) {
    content = `<text x="${width / 2}" y="28" text-anchor="middle" font-size="16" font-weight="700" fill="${BRAND.ink}">${escapeHtml(
      options.title
    )}</text>` + content;
  }

  const aria = `${options.title ?? "Linjediagram"}. ${data.length} datapunkter. Trender från ${
    data[0]!.label
  } till ${data[data.length - 1]!.label}.`;
  const svg = svgWrapper(width, height, options.title ?? "Linjediagram", aria, content);
  return chartFigure(
    options.title ?? "Linjediagram",
    svg,
    `${options.title ?? "Diagram"} som visar utveckling över ${data.length} perioder.`
  );
}

// --- Pie / donut chart -----------------------------------------------------

export function renderPieChart(
  data: ChartDatum[],
  options: Pick<ChartOptions, "title" | "width" | "height"> = {}
): string {
  const width = options.width ?? 500;
  const height = options.height ?? 400;
  const radius = Math.min(width, height) / 2 - 40;
  const cx = width / 2 - 80;
  const cy = height / 2;
  const innerRadius = radius * 0.45;

  const total = data.reduce((a, b) => a + b.value, 0);
  let startAngle = -Math.PI / 2;

  let content = "";
  const legendItems: { label: string; value: number; color: string; pct: number }[] = [];

  data.forEach((d, i) => {
    const sliceAngle = (d.value / total) * 2 * Math.PI;
    const endAngle = startAngle + sliceAngle;
    const color = PALETTE[i % PALETTE.length]!;

    // Donut segment
    const largeArc = sliceAngle > Math.PI ? 1 : 0;
    const x1 = rnd(cx + radius * Math.cos(startAngle));
    const y1 = rnd(cy + radius * Math.sin(startAngle));
    const x2 = rnd(cx + radius * Math.cos(endAngle));
    const y2 = rnd(cy + radius * Math.sin(endAngle));

    const ix1 = rnd(cx + innerRadius * Math.cos(startAngle));
    const iy1 = rnd(cy + innerRadius * Math.sin(startAngle));
    const ix2 = rnd(cx + innerRadius * Math.cos(endAngle));
    const iy2 = rnd(cy + innerRadius * Math.sin(endAngle));

    const dPath = [
      `M ${x1} ${y1}`,
      `A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${ix2} ${iy2}`,
      `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix1} ${iy1}`,
      "Z",
    ].join(" ");

    content += `<path d="${dPath}" fill="${color}" stroke="#fff" stroke-width="2" />`;

    const pct = (d.value / total) * 100;
    legendItems.push({ label: d.label, value: d.value, color, pct });

    startAngle = endAngle;
  });

  // Mitten-text med total
  content += `<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="14" font-weight="700" fill="${BRAND.ink}">${escapeHtml(
    formatNumber(total)
  )}</text>`;
  content += `<text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="11" fill="${BRAND.inkSoft}">totalt</text>`;

  // Legend
  const legendX = width - 150;
  let legendY = cy - (legendItems.length * 22) / 2;
  legendItems.forEach((item) => {
    content += `<rect x="${legendX}" y="${legendY}" width="12" height="12" fill="${item.color}" rx="2" />`;
    content += `<text x="${legendX + 20}" y="${legendY + 10}" font-size="12" fill="${BRAND.ink}">${escapeHtml(
      `${item.label} (${formatNumber(item.pct)}%)`
    )}</text>`;
    legendY += 22;
  });

  if (options.title) {
    content = `<text x="${width / 2}" y="28" text-anchor="middle" font-size="16" font-weight="700" fill="${BRAND.ink}">${escapeHtml(
      options.title
    )}</text>` + content;
  }

  const aria = `${options.title ?? "Cirkeldiagram"}. Fördelning över ${data.length} kategorier.`;
  const svg = svgWrapper(width, height, options.title ?? "Cirkeldiagram", aria, content);
  return chartFigure(
    options.title ?? "Cirkeldiagram",
    svg,
    `${options.title ?? "Diagram"} som visar fördelning i procent.`
  );
}

function niceCeiling(max: number): number {
  if (max <= 0) return 1;
  const pow10 = Math.pow(10, Math.floor(Math.log10(max)));
  const n = max / pow10;
  let nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * pow10;
}

// --- HTML table → chart injection ------------------------------------------

export function renderChartsInHtml(html: string): string {
  return html.replace(/<table[\s\S]*?<\/table>/gi, (tableHtml) => {
    const table = parseTable(tableHtml);
    if (!table) return tableHtml;

    const chartType = detectChartType(table);
    if (!chartType) return tableHtml;

    const title = table.headers[1]
      ? `${stripTags(table.headers[1]!)} – ${stripTags(table.headers[0]!) ?? ""}`.replace(/–\s*$/, "").trim()
      : "Diagram över tabell";
    const unit = unitFromText(table.rows.map((r) => r.raw ?? "").join(" "));

    let chart = "";
    if (chartType === "bar") {
      chart = renderBarChart(table.rows, { title, unit });
    } else if (chartType === "line") {
      chart = renderLineChart(table.rows, { title, unit });
    } else if (chartType === "pie") {
      chart = renderPieChart(table.rows, { title });
    }

    return chart ? `${chart}\n${tableHtml}` : tableHtml;
  });
}
