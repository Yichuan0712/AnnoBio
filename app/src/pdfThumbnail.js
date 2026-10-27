import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';

GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;

// Vite includes these resources in both web and Electron builds, without a CDN.
const resourceUrls = {
  cMapUrl: (filename) => new URL(`../node_modules/pdfjs-dist/cmaps/${filename}`, import.meta.url).href,
  standardFontDataUrl: (filename) => new URL(`../node_modules/pdfjs-dist/standard_fonts/${filename}`, import.meta.url).href,
  wasmUrl: (filename) => new URL(`../node_modules/pdfjs-dist/wasm/${filename}`, import.meta.url).href,
};

class LocalPdfDataFactory {
  async fetch({ kind, filename }) {
    const response = await fetch(resourceUrls[kind](filename));
    if (!response.ok) throw new Error('Could not load PDF preview resources.');
    return new Uint8Array(await response.arrayBuffer());
  }
}

/**
 * The text of pages `firstPage` .. `firstPage + maxPages - 1` (1-based), for the Agent's view of an
 * attached PDF. Stops early once `maxChars` characters are collected.
 * @returns {Promise<{pageCount: number, pages: {page: number, text: string}[]}>}
 */
export async function extractPdfText(data, { firstPage = 1, maxPages = 3, maxChars = Infinity } = {}) {
  const task = getDocument({ data, BinaryDataFactory: LocalPdfDataFactory, useWorkerFetch: false });
  task.onPassword = () => { task.destroy().catch(() => {}); };
  try {
    const pdf = await task.promise;
    const pages = [];
    let chars = 0;
    const last = Math.min(pdf.numPages, firstPage + maxPages - 1);
    for (let number = Math.max(1, firstPage); number <= last && chars < maxChars; number += 1) {
      const content = await (await pdf.getPage(number)).getTextContent();
      const text = content.items.map((item) => `${item.str || ''}${item.hasEOL ? '\n' : ''}`).join('').replace(/[ \t]+\n/g, '\n').trim();
      pages.push({ page: number, text });
      chars += text.length;
    }
    return { pageCount: pdf.numPages, pages };
  } finally {
    await task.destroy();
  }
}

/** Render only the first page; the caller owns the returned object URL. */
export async function createPdfThumbnail(file, signal) {
  signal.throwIfAborted();
  const data = await file.arrayBuffer();
  signal.throwIfAborted();
  const task = getDocument({ data, BinaryDataFactory: LocalPdfDataFactory, useWorkerFetch: false });
  const cancel = () => { task.destroy().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  // Thumbnail generation must never open a password prompt.
  task.onPassword = cancel;
  let canvas;
  try {
    const pdf = await task.promise;
    signal.throwIfAborted();
    const page = await pdf.getPage(1);
    const size = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 360 / Math.max(size.width, size.height) });
    canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    signal.throwIfAborted();
    if (!blob) throw new Error('Could not render the PDF preview.');
    return URL.createObjectURL(blob);
  } finally {
    signal.removeEventListener('abort', cancel);
    await task.destroy();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
