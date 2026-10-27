/**
 * The desktop app's side of chat attachments (docs/design/AGENT_ATTACHMENTS_PLAN.md): files come from
 * the main process, which reads only files the user attached (main.js's agent:* handlers).
 */

/** True where the chat takes attachments. */
export function attachmentsSupported() {
  return typeof window !== 'undefined' && typeof window.electronAPI?.pickAgentAttachments === 'function';
}

/** The `deps` attachmentContent.js's readAttachmentWindow reads with. */
export const desktopAttachmentDeps = {
  async readBytes(filePath) {
    const result = await window.electronAPI.readAgentAttachment(filePath);
    if (result?.error) throw new Error(result.error);
    return new Uint8Array(result.data);
  },
  async pdfText(bytes, options) {
    const { extractPdfText } = await import('../../pdfThumbnail.js');
    // pdf.js takes ownership of the buffer it is given.
    return extractPdfText(bytes.slice(), options);
  },
  async imageSize(bytes) {
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  },
};
