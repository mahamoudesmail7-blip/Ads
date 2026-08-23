// charts.js — tiny dependency-free SVG line chart for the Product Details
// page. No charting library: the machine this runs on has no package
// manager available, and the chart needed here (one line, daily orders
// over time) is simple enough not to need one.

/**
 * @param {HTMLElement} container
 * @param {{date:string, value:number|null}[]} points chronological, oldest first
 */
export function renderLineChart(container, points) {
  const W = 760;
  const H = 260;
  const padL = 40;
  const padR = 16;
  const padT = 16;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const values = points.map((p) => p.value).filter((v) => v !== null && v !== undefined);
  const maxV = values.length ? Math.max(...values) : 1;
  const yMax = Math.max(1, Math.ceil(maxV * 1.2));

  const xStep = points.length > 1 ? plotW / (points.length - 1) : 0;
  const xAt = (i) => padL + i * xStep;
  const yAt = (v) => padT + plotH - (v / yMax) * plotH;

  // Build path, breaking the line at gaps (No Data days).
  let pathD = '';
  let drawing = false;
  points.forEach((p, i) => {
    if (p.value === null || p.value === undefined) {
      drawing = false;
      return;
    }
    const cmd = drawing ? 'L' : 'M';
    pathD += `${cmd}${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)} `;
    drawing = true;
  });

  // Gridlines (4 horizontal bands).
  const gridLines = [];
  for (let g = 0; g <= 4; g++) {
    const v = (yMax / 4) * g;
    const y = yAt(v);
    gridLines.push(
      `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1" />` +
        `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--text-faint)">${Math.round(v)}</text>`
    );
  }

  // Sparse x-axis date labels (about 6 ticks).
  const tickEvery = Math.max(1, Math.ceil(points.length / 6));
  const xLabels = points
    .map((p, i) => {
      if (i % tickEvery !== 0 && i !== points.length - 1) return '';
      const short = p.date.slice(5); // MM-DD
      return `<text x="${xAt(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--text-faint)">${short}</text>`;
    })
    .join('');

  const dots = points
    .map((p, i) => {
      if (p.value === null || p.value === undefined) return '';
      return `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt(p.value).toFixed(1)}" r="3.2" fill="var(--accent)"><title>${p.date}: ${p.value} orders</title></circle>`;
    })
    .join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Daily orders chart">
      ${gridLines.join('')}
      <path d="${pathD.trim()}" fill="none" stroke="var(--accent)" stroke-width="2.2" />
      ${dots}
      ${xLabels}
    </svg>
  `;
}
