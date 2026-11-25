// Formatting/number helpers the local tools need (subset of node/src/base.ts,
// copied so the MCP server package stays self-contained).
const usdFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const usdCentsFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
const intFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const usd = (value: number): string => usdFormat.format(value);
export const usdCents = (value: number): string => usdCentsFormat.format(value);
export const int = (value: number): string => intFormat.format(value);
export const jsRound = Math.round;
export const toFixed = (value: number, digits: number): string => value.toFixed(digits);

/** Left-aligns columns with two spaces between them (rows may differ in length). */
export function alignRows(rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) return [];
  const columns = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return rows.map((row) =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd(),
  );
}
