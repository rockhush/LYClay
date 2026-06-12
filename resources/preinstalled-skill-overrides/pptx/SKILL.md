---
name: pptx
description: 'Use when a PowerPoint file is the primary input or output: read, inspect, edit, create, combine, split, convert, or visually verify .pptx presentations. Trigger when the user names a .pptx file or asks for a deck/slides/presentation deliverable. Do not trigger for general discussion of presentations when no PowerPoint file is opened, created, or modified.'
license: Proprietary. LICENSE.txt has complete terms
---

# PPTX creation, editing, and analysis

Use this skill when the task needs a `.pptx` file read, modified, created, converted, or visually checked.

## Choose the workflow

| Task | Workflow |
|------|----------|
| Read or summarize slide content | Use `python -m markitdown input.pptx` when available. |
| Inspect visual layout | Use `python scripts/thumbnail.py input.pptx` for a quick grid, or convert slides to images for detailed QA. |
| Edit an existing deck or template | Read [editing.md](editing.md), then unpack, modify, clean, pack, and validate. |
| Create a new deck from scratch | Read [pptxgenjs.md](pptxgenjs.md) and use PptxGenJS when available. |
| Complex preservation-sensitive edits | Prefer direct Office Open XML inspection/patching to avoid dropping unsupported PowerPoint parts. |

## Safety and preservation

- Do not overwrite the input presentation unless the user explicitly asks for that.
- For template edits, preserve the original theme, masters, layouts, notes, comments, media, and relationships unless the user asks to remove them.
- Complete structural changes before editing slide content: add/delete/reorder slides first, then update text and visuals.
- Do not manually copy slide XML files. Use `scripts/add_slide.py` or preserve all required relationships, content types, notes, and layout references yourself.
- Always pack with validation when editing an unpacked deck:

```bash
python scripts/office/pack.py unpacked/ output.pptx --original input.pptx
```

## Reading content

```bash
python -m markitdown input.pptx
python scripts/thumbnail.py input.pptx
python scripts/office/unpack.py input.pptx unpacked/
```

If `markitdown` is unavailable, inspect unpacked slide XML or use another available text extraction path. Do not install dependencies globally without user approval.

## Editing an existing presentation

1. Inspect the deck with text extraction and thumbnails.
2. Identify the slide layouts, placeholders, speaker notes, charts, media, and relationships that must be preserved.
3. Unpack the deck.
4. Apply structural changes.
5. Update slide XML and related assets.
6. Run `scripts/clean.py` only after slide deletion or relationship cleanup is needed.
7. Pack with validation and save as a new `.pptx`.
8. Verify the affected slides.

## Creating a new presentation

Use the user's requested style first. If no style is specified, create a polished but appropriate deck:

- Pick a content-informed color palette instead of default generic blue.
- Use a consistent visual motif across slides.
- Vary layouts across title, section, content, data, and conclusion slides.
- Use visual elements when useful, but do not force decorative graphics into simple, academic, or template-constrained decks.
- Keep margins, alignment, contrast, and font sizes consistent.

When using PptxGenJS:

- Use a fresh `pptxgen()` instance per deck.
- Use hex colors without `#`.
- Do not encode opacity in 8-character color strings; use opacity/transparency options.
- Do not use unicode bullets; use proper bullet options.
- Do not reuse option objects across calls because PptxGenJS mutates some objects.

## QA level by task

Match QA effort to the scope of the change.

### Read-only or extraction tasks

- Confirm extracted text includes the expected slide range and order.
- State any limitations if speaker notes, comments, images, charts, or embedded objects were not inspected.

### Small edits

- Reopen or re-extract the output.
- Verify changed slides and nearby affected slides.
- Check for leftover placeholders, missing content, and obvious layout breakage.

### New decks, template-based decks, or large edits

1. Convert slides to images if LibreOffice and Poppler are available:

```bash
python scripts/office/soffice.py --headless --convert-to pdf output.pptx
pdftoppm -jpeg -r 150 output.pdf slide
```

2. Inspect rendered slides for overlap, clipped text, low contrast, inconsistent alignment, leftover placeholders, and broken media.
3. Fix issues and re-check affected slides.

If `pdftoppm` is unavailable, use `thumbnail.py` or another available renderer for limited visual QA and clearly state the limitation.

## Placeholder checks

Use any available text search method to catch placeholders such as `xxxx`, `lorem`, `ipsum`, or template instructions. On Windows PowerShell, prefer `Select-String`; in POSIX shells, `grep` is fine.

## Dependencies

Do not default to global installs. First check whether tools are already available in the environment. If a dependency is missing, either use an available fallback or ask before installing.

Common optional tools:

- `markitdown[pptx]` for text extraction.
- Pillow for thumbnail grids.
- PptxGenJS for creating decks from scratch.
- LibreOffice via `scripts/office/soffice.py` for rendering or conversion.
- Poppler `pdftoppm` for PDF-to-image conversion.
