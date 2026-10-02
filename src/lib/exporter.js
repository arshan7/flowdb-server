// Streams a query's rows to a download as CSV, JSON or XLSX without holding them all
// in memory: rows come through a cursor in batches (queryEngine.streamQuery) and each
// batch is written straight to the response. XLSX is a zip of XML files; the sheet is
// deflated as it's written (zlib) with a data descriptor per entry, so no size has to
// be known up front. No dependencies beyond Node.
import zlib from "node:zlib";
import { once } from "node:events";

export const EXPORT_FORMATS = ["csv", "json", "xlsx"];
export const EXPORT_ROW_CAP = 1_000_000;
const CONTENT_TYPE = {
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** A safe file name: letters, digits, spaces, dashes. */
export const fileNameOf = (name, format) =>
  `${String(name || "report").replace(/[^\w\- ]+/g, "").trim().slice(0, 80) || "report"}.${format}`;

async function write(out, chunk) {
  if (!out.write(chunk)) await once(out, "drain");
}

// --- CSV / JSON ------------------------------------------------------------------
const csvCell = (v) => {
  if (v == null) return "";
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// --- XLSX ------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf, crc = 0) {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip written front to back: entries stream in, the directory goes at the end. */
class ZipWriter {
  constructor(out) {
    this.out = out;
    this.offset = 0;
    this.entries = [];
  }
  async raw(buf) {
    this.offset += buf.length;
    await write(this.out, buf);
  }
  /** Opens an entry; returns { write(text), end() }. */
  async entry(name) {
    const nameBuf = Buffer.from(name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0808, 6); // sizes in a trailing descriptor; UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x21, 12); // 1980-01-01
    header.writeUInt16LE(nameBuf.length, 26);
    const start = this.offset;
    await this.raw(Buffer.concat([header, nameBuf]));
    const deflate = zlib.createDeflateRaw({ level: 6 });
    let crc = 0;
    let size = 0;
    let compressed = 0;
    const pumped = (async () => {
      for await (const chunk of deflate) {
        compressed += chunk.length;
        await this.raw(chunk);
      }
    })();
    const entry = {
      write: async (text) => {
        const buf = Buffer.from(text, "utf8");
        crc = crc32(buf, crc);
        size += buf.length;
        if (!deflate.write(buf)) await once(deflate, "drain");
      },
      end: async () => {
        deflate.end();
        await pumped;
        const desc = Buffer.alloc(16);
        desc.writeUInt32LE(0x08074b50, 0);
        desc.writeUInt32LE(crc, 4);
        desc.writeUInt32LE(compressed, 8);
        desc.writeUInt32LE(size, 12);
        await this.raw(desc);
        this.entries.push({ nameBuf, crc, compressed, size, start });
      },
    };
    return entry;
  }
  async file(name, text) {
    const e = await this.entry(name);
    await e.write(text);
    await e.end();
  }
  async finish() {
    const dirStart = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0808, 8);
      h.writeUInt16LE(8, 10);
      h.writeUInt16LE(0, 12);
      h.writeUInt16LE(0x21, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.compressed, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt32LE(e.start, 42);
      await this.raw(Buffer.concat([h, e.nameBuf]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - dirStart, 12);
    end.writeUInt32LE(dirStart, 16);
    await this.raw(end);
  }
}

const xmlEscape = (s) =>
  String(s)
    // Control characters aren't allowed in XML.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const colName = (i) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const NUMERIC = /^-?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/;
function xlsxCell(v, ref) {
  if (v == null || v === "") return "";
  if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
  if (typeof v === "boolean") return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  if (typeof v === "string" && v.length < 17 && NUMERIC.test(v)) return `<c r="${ref}"><v>${v}</v></c>`;
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(s.slice(0, 32767))}</t></is></c>`;
}
const XLSX_STATIC = {
  "[Content_Types].xml":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  "_rels/.rels":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  "xl/workbook.xml":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
};

/**
 * Stream rows to `res` as a download.
 * @param {import("express").Response} res
 * @param {{format: string, name: string, columns: {id: string, label: string}[],
 *   run: (onBatch: (rows: object[]) => Promise<void>) => Promise<void>}} p
 * @returns {Promise<number>} rows written
 */
export async function streamExport(res, { format, name, columns, run }) {
  res.setHeader("Content-Type", CONTENT_TYPE[format]);
  res.setHeader("Content-Disposition", `attachment; filename="${fileNameOf(name, format)}"`);
  res.setHeader("Cache-Control", "no-store");
  let count = 0;
  const ids = columns.map((c) => c.id);
  if (format === "csv") {
    // A byte-order mark so Excel reads UTF-8.
    await write(res, `\ufeff${columns.map((c) => csvCell(c.label)).join(",")}\r\n`);
    await run(async (rows) => {
      count += rows.length;
      await write(res, rows.map((r) => ids.map((id) => csvCell(r[id])).join(",")).join("\r\n") + (rows.length ? "\r\n" : ""));
    });
  } else if (format === "json") {
    await write(res, "[");
    await run(async (rows) => {
      const parts = rows.map((r) => JSON.stringify(Object.fromEntries(columns.map((c) => [c.label, r[c.id] ?? null]))));
      if (parts.length) await write(res, (count ? "," : "") + parts.join(","));
      count += rows.length;
    });
    await write(res, "]");
  } else {
    const zip = new ZipWriter(res);
    for (const [file, text] of Object.entries(XLSX_STATIC)) await zip.file(file, text);
    const sheet = await zip.entry("xl/worksheets/sheet1.xml");
    await sheet.write(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        `<row r="1">${columns.map((c, i) => xlsxCell(c.label, `${colName(i)}1`)).join("")}</row>`,
    );
    await run(async (rows) => {
      let xml = "";
      for (const r of rows) {
        const n = count + 2;
        xml += `<row r="${n}">${ids.map((id, i) => xlsxCell(r[id], `${colName(i)}${n}`)).join("")}</row>`;
        count++;
      }
      await sheet.write(xml);
    });
    await sheet.write("</sheetData></worksheet>");
    await sheet.end();
    await zip.finish();
  }
  res.end();
  return count;
}
