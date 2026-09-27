/** [x0, y0, x1, y1], normalised to the square photo (0 to 1). */
export type Box = [number, number, number, number];

/** One photo cut into a 4×4 grid, like reCAPTCHA. */
export const GRID = 4;
export const CELLS = GRID * GRID;

// Squares that must be ticked, and squares where either answer is fine.
const REQUIRED_CELL_SHARE = 0.1; // the object fills at least 10 % of the square…
const REQUIRED_OBJECT_SHARE = 0.35; // …or at least 35 % of the object is in it
const OPTIONAL_CELL_SHARE = 0.01;

export const intersect = (a: Box, b: Box) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
export const boxArea = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);

/** Which squares (0-15, row by row) hold the object, given its boxes in the displayed crop. */
export function scoreCells(targets: Box[], fuzzy: Box[]) {
  const required: number[] = [];
  const optional: number[] = [];
  const cellArea = 1 / CELLS;
  for (let i = 0; i < CELLS; i++) {
    const c = i % GRID;
    const r = Math.floor(i / GRID);
    const cell: Box = [c / GRID, r / GRID, (c + 1) / GRID, (r + 1) / GRID];
    let isRequired = false;
    let isOptional = false;
    for (const b of targets) {
      const inter = intersect(b, cell);
      if (!inter) continue;
      if (inter / cellArea >= REQUIRED_CELL_SHARE || inter / boxArea(b) >= REQUIRED_OBJECT_SHARE) isRequired = true;
      else if (inter / cellArea >= OPTIONAL_CELL_SHARE) isOptional = true;
    }
    for (const b of fuzzy) if (intersect(b, cell) / cellArea >= OPTIONAL_CELL_SHARE * 2) isOptional = true;
    if (isRequired) required.push(i);
    else if (isOptional) optional.push(i);
  }
  return { required, optional };
}

/** Share of the square covered by at least one box (sampled on a 50×50 grid). */
export function coverage(boxes: Box[]) {
  let hit = 0;
  const N = 50;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = (i + 0.5) / N;
      const y = (j + 0.5) / N;
      if (boxes.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)) hit++;
    }
  }
  return hit / (N * N);
}
