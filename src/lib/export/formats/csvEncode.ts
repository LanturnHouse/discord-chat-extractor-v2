/** CSV serialisation (RFC 4180) with spreadsheet formula neutralising. Kept apart from csv.ts, which exports only its format. */

const CSV_ROW_END = '\r\n';

/**
 * Formula injection: Excel, LibreOffice and Google Sheets evaluate a cell that starts with = + - @ (and with a tab
 * or carriage return, which some versions skip before looking at the first character). A single quote in front makes
 * every one of them show the cell as text, the quote itself being the (visible) price of that.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function neutraliseFormula(cell: string): string {
  return FORMULA_TRIGGER.test(cell) ? `'${cell}` : cell;
}

/** What an id column may hold to be written as text: a plain run of digits (snowflakes have 17-20, so 32 is generous). */
const ID_DIGITS = /^\d{1,32}$/;

/**
 * A Discord id as a cell a spreadsheet keeps as TEXT: `="123456789012345678"`.
 *
 * A bare 18-digit number is read by Excel as a number (shown as 1.23457E+17), and only its first 15 digits survive a save, so
 * the ids can no longer be matched with Discord or with the JSON / XLSX export. A formula that returns a string literal is
 * the one spelling that Excel, LibreOffice and Google Sheets all keep as text. It cannot be abused: the cell is built only
 * from a run of digits (anything else is neutralised like every other cell), so there is nothing to inject.
 */
export function idTextCell(id: string): string | null {
  return ID_DIGITS.test(id) ? `="${id}"` : null;
}

/** A field containing a quote, comma or line break is quoted and its quotes are doubled. */
export function csvField(cell: string, asId = false): string {
  const safe = (asId ? idTextCell(cell) : null) ?? neutraliseFormula(cell);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * One record including its CRLF terminator. `idCells[i]` marks cell `i` as a Discord id, which is written as text
 * (`idTextCell`) when it is a run of digits.
 */
export function csvRow(cells: readonly string[], idCells?: readonly boolean[]): string {
  let row = '';
  for (let i = 0; i < cells.length; i += 1) {
    const field = csvField(cells[i], idCells?.[i] === true);
    row += i === 0 ? field : `,${field}`;
  }
  return row + CSV_ROW_END;
}
