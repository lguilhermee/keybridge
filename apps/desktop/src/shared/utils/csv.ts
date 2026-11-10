/** Builds a CSV document: RFC-4180 quoting, `\r\n` rows, UTF-8 BOM for Excel. */
export function toCsv(header: Array<string | number>, rows: Array<Array<string | number | null | undefined>>): string {
  const escape = (value: string | number | null | undefined) => {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [header, ...rows].map((row) => row.map(escape).join(","));
  return `﻿${lines.join("\r\n")}`;

}

/** Triggers a browser download of `content` as `filename`. */
export function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
