// Minimal FITS reader for TESS light-curve products (runtime-agnostic).
//
// Supports exactly what MAST TESS SAP/PDC light-curve files need: a primary HDU
// followed by a BINTABLE extension whose columns are fixed-length scalars
// (TFORM letters E/D/J/K/I/A/B). Everything is read through DataView, so the same
// class runs under Node and on Cloudflare Workers with zero dependencies.
//
// FITS convention: 2880-byte blocks; header cards are 80 ASCII chars; big-endian
// data in binary tables. Rows with NaN flux are kept raw -- filtering is the
// caller's job so quality-flag policy stays in one place (see toLightCurve).

export interface FitsColumn {
  name: string;
  form: string; // TFORM letter (first char)
  offset: number; // byte offset of the column inside a row
  size: number; // bytes per element
  count: number; // repeat count (elements per row; 1 for a scalar column)
  /** Parsed TDIM, e.g. '(14,14)' -> [14,14]; undefined for scalar/1-D columns. */
  dims?: number[];
}

export interface FitsTable {
  rows: number;
  columns: FitsColumn[];
  dataStart: number; // absolute byte offset of the first row
  rowWidth: number;
  header: Record<string, string | number>;
}

const BLOCK = 2880;

function cardValue(card: string): string | number {
  // VALUE = 'quoted' or numeric / logical, may carry a / comment tail.
  const eq = card.indexOf("=");
  if (eq < 0) return "";
  const rest = card.slice(eq + 1);
  const first = rest.search(/\S/);
  if (first >= 0 && rest[first] === "'") {
    const end = rest.indexOf("'", first + 1);
    return rest.slice(first + 1, end).trim();
  }
  let tail = rest;
  const slash = tail.indexOf("/");
  if (slash >= 0) tail = tail.slice(0, slash);
  tail = tail.trim();
  if (tail === "T") return 1;
  if (tail === "F") return 0;
  const n = Number(tail);
  return Number.isFinite(n) ? n : tail;
}

function readHeaderBlock(view: DataView, start: number): { cards: string[]; next: number } {
  const cards: string[] = [];
  let pos = start;
  for (;;) {
    let text = "";
    for (let i = 0; i < BLOCK; i += 80) {
      const card = ascii(view, pos + i, 80);
      cards.push(card);
      if (card.startsWith("END")) {
        return { cards, next: pos + BLOCK };
      }
    }
    pos += BLOCK;
    text = ""; // keep eslint quiet about text; headers are read card-by-card
  }
}

function ascii(view: DataView, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
  return s;
}

function colSize(form: string): number {
  const t = form[0].toUpperCase();
  if (t === "D" || t === "K") return 8;
  if (t === "E" || t === "J" || t === "A" || t === "I" || t === "B") return 4;
  throw new Error(`unsupported TFORM: ${form}`);
}

/** Parse a TESS light-curve FITS file; returns the first BINTABLE extension. */
export function readFitsTable(bytes: Uint8Array): FitsTable {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(view, 0, 6) !== "SIMPLE") throw new Error("not a FITS file (missing SIMPLE)");

  let pos = 0;
  let table: FitsTable | null = null;
  // Walk HDUs until a BINTABLE is found.
  for (let guard = 0; guard < 8 && !table; guard++) {
    const { cards, next } = readHeaderBlock(view, pos);
    const header: Record<string, string | number> = {};
    for (const c of cards) {
      const key = c.slice(0, 8).trim();
      if (key) header[key] = cardValue(c);
    }
    const bitpix = Number(header.BITPIX ?? 8);
    const naxis = Number(header.NAXIS ?? 0);
    const naxis1 = Number(header.NAXIS1 ?? 0);
    const naxis2 = Number(header.NAXIS2 ?? 0);
    const pcount = Number(header.PCOUNT ?? 0);
    const gcount = Number(header.GCOUNT ?? 0);

    if (header.XTENSION === "BINTABLE" && naxis >= 2 && naxis2 > 0) {
      const fields = Number(header.TFIELDS ?? 0);
      const cols: FitsColumn[] = [];
      let offset = 0;
      for (let i = 1; i <= fields; i++) {
        const form = String(header[`TFORM${i}`] ?? "");
        const repeat = /^\d/.test(form) ? parseInt(form, 10) : 1;
        const letter = form.replace(/^\d+/, "")[0] ?? "E";
        const perElem = letter === "D" || letter === "K" ? 8 : letter === "A" || letter === "B" ? 1 : 4;
        const tdim = String(header[`TDIM${i}`] ?? "");
        const dims = tdim ? (tdim.match(/\d+/g) ?? []).map(Number) : undefined;
        cols.push({ name: String(header[`TTYPE${i}`] ?? `COL${i}`).trim(), form: letter, offset, size: perElem, count: repeat, dims });
        offset += perElem * repeat;
      }
      table = { rows: naxis2, columns: cols, dataStart: next, rowWidth: naxis1, header };
      break;
    }

    // skip this HDU's data area, honoring 2880 padding
    if (naxis > 0 && naxis1 > 0) {
      const perRow = bitpix === 64 ? 8 : bitpix === 32 ? 4 : bitpix === 16 ? 2 : 1;
      const dataSize = naxis1 * perRow * Math.max(1, naxis2) + pcount * Math.max(1, gcount);
      pos = next + Math.ceil(dataSize / BLOCK) * BLOCK;
    } else {
      pos = next;
    }
  }
  if (!table) throw new Error("no BINTABLE extension found");
  return table;
}

/** Read one numeric column as Float64Array (NaN preserved for masked points). */
export function readColumn(table: FitsTable, bytes: Uint8Array, name: string): Float64Array {
  const col = table.columns.find((c) => c.name === name);
  if (!col) throw new Error(`column not found: ${name}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float64Array(table.rows);
  const letter = col.form[0].toUpperCase();
  for (let r = 0; r < table.rows; r++) {
    const at = table.dataStart + r * table.rowWidth + col.offset;
    if (letter === "D") out[r] = view.getFloat64(at);
    else if (letter === "E") out[r] = view.getFloat32(at);
    else if (letter === "J" || letter === "I") out[r] = view.getInt32(at);
    else if (letter === "K") out[r] = view.getFloat64(at); // int64: safe under 2^53
    else out[r] = Number.NaN;
  }
  return out;
}

/**
 * Read a fixed-length ARRAY column (e.g. a target-pixel FLUX with TFORM '196E'
 * and TDIM '(14,14)') as a flat Float64Array of shape rows x count, stored in
 * FITS column-major order within each row (so for a row of `count` elements the
 * first TDIM axis varies fastest). Scalar columns (count 1) work too. Returns
 * the flattened values plus the row element count and parsed dims so the caller
 * can index (row, axis0, axis1, ...). Big-endian, DataView, zero-dependency.
 */
export function readArrayColumn(table: FitsTable, bytes: Uint8Array, name: string): { values: Float64Array; count: number; dims?: number[] } {
  const col = table.columns.find((c) => c.name === name);
  if (!col) throw new Error(`column not found: ${name}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.max(1, col.count);
  const out = new Float64Array(table.rows * count);
  const letter = col.form[0].toUpperCase();
  for (let r = 0; r < table.rows; r++) {
    const rowBase = table.dataStart + r * table.rowWidth + col.offset;
    for (let e = 0; e < count; e++) {
      const at = rowBase + e * col.size;
      let v: number;
      if (letter === "D") v = view.getFloat64(at);
      else if (letter === "E") v = view.getFloat32(at);
      else if (letter === "J" || letter === "I") v = view.getInt32(at);
      else if (letter === "K") v = view.getFloat64(at);
      else v = Number.NaN;
      out[r * count + e] = v;
    }
  }
  return { values: out, count, dims: col.dims };
}
