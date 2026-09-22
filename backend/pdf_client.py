"""
Parses a PDF into the three pieces AnnoBio's "Import from PDF" dataset feature turns into
columns: full text, embedded images, and any tables (rendered as markdown). Text-layer only —
scanned/image-only PDFs yield empty text and no tables rather than erroring (no OCR yet).
"""
import io

import pymupdf as fitz  # `import fitz` still works but is the deprecated spelling
import pdfplumber

# Academic PDFs embed plenty of images that aren't figures — journal logos, section-heading
# icons, single-color spacer/rule images, tiny bullet glyphs. Anything smaller than this in
# either dimension gets dropped rather than cluttering the Image N columns with noise.
MIN_IMAGE_DIMENSION_PX = 64


def _rows_to_markdown(rows: "list[list[str | None]]") -> str:
    """Render a pdfplumber-style table (list of row lists) as a GitHub-flavored markdown table."""
    if not rows:
        return ""
    cleaned = [
        [("" if cell is None else str(cell)).replace("\n", " ").replace("|", "\\|").strip() for cell in row]
        for row in rows
    ]
    width = max(len(row) for row in cleaned)
    cleaned = [row + [""] * (width - len(row)) for row in cleaned]
    header, *body = cleaned
    lines = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join(["---"] * width) + " |",
    ]
    lines.extend("| " + " | ".join(row) + " |" for row in body)
    return "\n".join(lines)


def parse_pdf(data: bytes) -> dict:
    """
    Returns {"text": str, "images": [{"bytes": bytes, "ext": str}], "tables": [str]}.
    Images are the PDF's own embedded raster images (not full-page renders), deduped by xref
    within the document and filtered to at least MIN_IMAGE_DIMENSION_PX in both dimensions (drops
    logos/icons/spacer images); tables are detected per page and each rendered independently as
    markdown, in page order.
    """
    text_parts: list[str] = []
    images: list[dict] = []
    seen_xrefs: set[int] = set()

    with fitz.open(stream=data, filetype="pdf") as doc:
        for page in doc:
            text_parts.append(page.get_text())
            for img in page.get_images(full=True):
                xref = img[0]
                if xref in seen_xrefs:
                    continue
                seen_xrefs.add(xref)
                try:
                    extracted = doc.extract_image(xref)
                except Exception:
                    continue
                if extracted.get("width", 0) < MIN_IMAGE_DIMENSION_PX or extracted.get("height", 0) < MIN_IMAGE_DIMENSION_PX:
                    continue
                img_bytes = extracted.get("image")
                if img_bytes:
                    images.append({"bytes": img_bytes, "ext": extracted.get("ext") or "png"})

    tables: list[str] = []
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for page in pdf.pages:
                for table in page.extract_tables():
                    md = _rows_to_markdown(table)
                    if md:
                        tables.append(md)
    except Exception:
        pass  # a page pdfplumber can't parse shouldn't fail the whole import — text/images still stand

    return {
        "text": "\n\n".join(part for part in text_parts if part).strip(),
        "images": images,
        "tables": tables,
    }
