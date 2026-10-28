/** Renderer adapter. IPC remains the authority; conversation lookup is an additional boundary. */
import { desktopAttachmentDeps } from './desktopAttachments.js';
import { parseTableAttachment, readAttachmentWindow } from './attachmentContent.js';

const checked = (result) => {
  if (result?.error) throw new Error(result.error);
  return result;
};

export function createLocalFolderRuntime(conversation, findAttachment, api = window.electronAPI) {
  function attachment(id, folder = false) {
    const found = findAttachment(id);
    if (!found || found.revoked || found.error) throw new Error(`No readable attachment ${id} in this conversation.`);
    if (folder && (!found.grantId || found.kind !== 'folder')) throw new Error('Use an authorized folder id, such as f1.');
    return found;
  }
  async function fileBytes(item, relative) {
    if (!item.grantId) return desktopAttachmentDeps.readBytes(item.path);
    return new Uint8Array(checked(await api.readAgentPathFile(conversation.id, item.grantId, relative || '')).data);
  }
  async function readAttachment(args) {
    const item = attachment(args.attachment_id);
    if (!item.grantId) return readAttachmentWindow(item, args, desktopAttachmentDeps);
    if (item.kind === 'folder' && !args.path) throw new Error('Specify the relative file path inside the folder.');
    const file = checked(await api.readAgentPathFile(conversation.id, item.grantId, args.path || ''));
    return { ...await readAttachmentWindow({ ...item, name: file.name, kind: file.kind }, args,
      { ...desktopAttachmentDeps, readBytes: async () => new Uint8Array(file.data) }), files_read: file.files_read, file_limit: file.file_limit };
  }
  return {
    readAttachment,
    readAttachmentTable: async (item, sheet) => {
      if (item.revoked) throw new Error('Local path access was removed.');
      return parseTableAttachment(item.name, await fileBytes(item), String(sheet || ''));
    },
    listFolder: async (args) => checked(await api.listAgentFolder(conversation.id, attachment(args.attachment_id, true).grantId, args)),
    searchFolder: async (args) => checked(await api.searchAgentFolder(conversation.id, attachment(args.attachment_id, true).grantId, args)),
    async readFolder(args) {
      const item = attachment(args.attachment_id, true);
      const batch = checked(await api.batchAgentFolder(conversation.id, item.grantId, args));
      const files = [];
      let position = Math.max(0, Number(args.cursor) || 0);
      let used = 0;
      let note;
      for (const descriptor of batch.files) {
        let window;
        try {
          window = await readAttachment({ attachment_id: item.id, path: descriptor.path,
            max_chars: Math.min(12000, Math.max(1, Number(args.max_chars_per_file) || 2000)), max_rows: 3, max_pages: 1 });
        } catch (error) { window = { error: error.message }; }
        if (window.error && /100-file/.test(window.error)) { note = window.error; break; }
        const output = { path: descriptor.path, ...window };
        let length = JSON.stringify(output).length;
        if (length > 18000) {
          files.push({ path: descriptor.path, kind: descriptor.kind, note: 'Preview is too large; use read_attachment with a smaller window.' });
          position += 1; used += 200; continue;
        }
        if (used + length > 18000) break;
        files.push(output); used += length; position += 1;
      }
      return { files, total_files: batch.total_files, file_limit: 100, scan_truncated: batch.scan_truncated,
        next_cursor: note ? null : position < (Number(args.cursor) || 0) + batch.files.length ? String(position) : batch.next_cursor,
        ...(note ? { note } : {}) };
    },
    async previewFolderAccess(request) {
      try {
        const result = checked(await api.checkAgentFolder(conversation.id, String(request.path || '')));
        return { ok: true, path: result.path, items: [{ kind: 'add', type: 'folder', title: `Read ${result.name}`,
          lines: [result.path, String(request.reason || ''), 'Read-only access for this conversation and its subfolders. File contents are sent to your configured model provider. At most 100 local files can be read.'], nodeIds: [] }] };
      } catch (error) { return { ok: false, error: error.message }; }
    },
    async resolveFolderImport(op, { token, store = false } = {}) {
      const folder = attachment(op.folder, true);
      if (op.attachments) throw new Error('Choose folder or attachments, not both.');
      const snapshot = token ? { token } : checked(await api.snapshotAgentImport(conversation.id, folder.grantId, { files: op.files, pattern: op.pattern }));
      const result = checked(await api.useAgentImportSnapshot(conversation.id, snapshot.token, { store }));
      const entry = { attachments: result.files, assets: result.assets, snapshotToken: snapshot.token };
      if (result.files[0]?.kind === 'table') {
        const file = checked(await api.useAgentImportSnapshot(conversation.id, snapshot.token, { relativePath: result.files[0].relativePath }));
        entry.table = parseTableAttachment(file.name, new Uint8Array(file.data), op.sheet);
      }
      return entry;
    },
    async resolvePathImports(op, { token, store = false } = {}) {
      const ids = (Array.isArray(op.attachments) ? op.attachments : [op.attachments]).filter(Boolean);
      const items = ids.map((id) => attachment(id));
      const kinds = new Set(items.map((item) => item.kind));
      if (kinds.size !== 1 || !['table', 'image', 'pdf'].includes(items[0]?.kind) || (kinds.has('table') && items.length !== 1)) {
        throw new Error('Import one table, a batch of images or a batch of PDFs, not a mix.');
      }
      const tokens = token || {};
      // Validate every source before copying any files; grant-based files use the same immutable
      // snapshots as folder imports and do not consume the project-reading budget.
      for (const item of items) {
        if (!item.grantId) continue;
        if (!tokens[item.id]) {
          if (store) throw new Error('A local file import needs a fresh preview.');
          tokens[item.id] = checked(await api.snapshotAgentImport(conversation.id, item.grantId, { files: [''] })).token;
        }
        checked(await api.useAgentImportSnapshot(conversation.id, tokens[item.id], {}));
      }
      const entry = { attachments: items, snapshotToken: tokens };
      if (kinds.has('table')) {
        const item = items[0];
        const bytes = item.grantId
          ? new Uint8Array(checked(await api.useAgentImportSnapshot(conversation.id, tokens[item.id], { relativePath: '' })).data)
          : await fileBytes(item);
        entry.table = parseTableAttachment(item.name, bytes, op.sheet);
      } else if (store) {
        entry.assets = [];
        for (const item of items) {
          if (item.grantId) entry.assets.push(...checked(await api.useAgentImportSnapshot(conversation.id, tokens[item.id], { store: true })).assets);
          else entry.assets.push(...await (item.kind === 'image' ? api.importImages([item.path]) : api.importPdfs([item.path])));
        }
      }
      return entry;
    },
    async validateAttachments(items) {
      for (const item of items) {
        if (item.revoked) throw new Error('Local path access was removed.');
        if (item.grantId) checked(await api.readAgentPathFile(conversation.id, item.grantId, ''));
      }
    },
  };
}
