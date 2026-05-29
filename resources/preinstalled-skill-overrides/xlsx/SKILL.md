---
name: xlsx
description: 'Use when a spreadsheet file is the primary input or output: read, inspect, edit, clean, format, create, or convert .xlsx, .xlsm, .csv, or .tsv files. Trigger when the user names a spreadsheet file or asks for a spreadsheet deliverable. Do not trigger when the deliverable is a Word document, HTML report, standalone script, database pipeline, or Google Sheets API integration.'
license: Proprietary. LICENSE.txt has complete terms
---

# XLSX creation, editing, and analysis

Use this skill when the user needs a spreadsheet file read, modified, created, cleaned, formatted, converted, or verified.

## Choose the workflow

- Use pandas for data inspection, filtering, aggregation, cleanup, CSV/TSV conversion, and simple exports. Do not use pandas when workbook formulas, styles, charts, macros, pivots, or template layout must be preserved.
- Use openpyxl for cell-level workbook edits, formulas, styles, and basic formatting when unsupported Excel features do not need to be preserved.
- Use direct Office Open XML inspection or patching for complex workbooks when libraries may drop macros, charts, pivots, external links, controls, or unsupported workbook parts.

## Reading and analyzing data

```python
import pandas as pd

all_sheets = pd.read_excel('input.xlsx', sheet_name=None)
df = pd.read_excel('input.xlsx')
print(df.head())
print(df.info())
print(df.describe(include='all'))
```

For CSV/TSV files, detect delimiter and encoding before rewriting. Preserve user data exactly unless the user asked for cleanup. When exporting data that may be opened in Excel and includes untrusted text, guard against formula injection from values beginning with `=`, `+`, `-`, or `@`.

## Editing existing workbooks

1. Inspect workbook sheets, dimensions, formulas, styles, merged cells, tables, charts, and frozen panes before editing.
2. Preserve the existing template style and layout unless the user asks for a redesign.
3. Make the smallest edit that satisfies the request.
4. Save to a new output file unless the user explicitly asks to overwrite.
5. Reopen the output file and verify the changed cells, formulas, and sheet names.

For `.xlsm` files, preserve macros by loading with `keep_vba=True` and saving as `.xlsm`. If macro preservation cannot be verified, say so.

```python
from openpyxl import load_workbook

wb = load_workbook('input.xlsx')
ws = wb['Sheet1']
ws['B2'] = '=SUM(B3:B10)'
wb.save('output.xlsx')
```

```python
wb = load_workbook('input.xlsm', keep_vba=True)
wb.save('output.xlsm')
```

## Creating new spreadsheets

- Use clear sheet names, header rows, frozen panes, filters, and sensible column widths.
- Apply a consistent professional font.
- Format numbers by meaning: dates as dates, currency with units in headers, percentages as percentages, and IDs as text.
- Keep raw data, assumptions, and calculated outputs visually distinct when the workbook contains formulas.

## Formulas and recalculation

Prefer Excel formulas over hardcoded calculated values when the workbook should remain updateable.

```python
ws['B10'] = '=SUM(B2:B9)'
ws['C10'] = '=IFERROR(B10/C9,0)'
```

When formulas are added or changed, try to recalculate and verify values with `scripts/recalc.py` if LibreOffice is available and the script succeeds:

```bash
python scripts/recalc.py output.xlsx
```

Treat recalculation as verified only when the script returns `status: "success"` or `status: "errors_found"` with usable details. If recalculation fails or is unavailable, state that formula syntax was written but cached Excel values could not be refreshed locally. Never claim formula results or formula-error checks were verified unless they were actually recalculated or opened by a spreadsheet engine.

## Quality checks before delivery

- Do not overwrite the input file unless the user explicitly asked for that.
- Reopen the output with the library used to write it; if LibreOffice or Excel is available, also open or recalculate with it.
- Check that edited ranges contain the requested values or formulas.
- After recalculation, check for common formula errors: `#REF!`, `#DIV/0!`, `#VALUE!`, `#N/A`, `#NAME?`.
- Verify formatting did not unexpectedly disappear from existing templates.
- For CSV/TSV outputs, verify row counts, delimiter, encoding, header placement, and formula-injection handling when relevant.

## Financial models only

Use these rules only when the user is building or editing a financial model, valuation, budget, forecast, or scenario workbook.

- Blue text: hardcoded inputs and scenario assumptions.
- Black text: formulas and calculations.
- Green text: links to other worksheets in the same workbook.
- Red text: external links to other files.
- Yellow fill: key assumptions or cells requiring user attention.
- Use separate assumption cells and reference them in formulas.
- Format zeros as `-`, negatives with parentheses, percentages with one decimal, and multiples as `0.0x` unless the template uses a different convention.
- Add source notes for important hardcoded assumptions when the source is known.
