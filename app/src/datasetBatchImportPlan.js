import { displayCell, isImageCell, isPdfCell } from './datasetContent.js';

const leafName = (value) => String(value ?? '').trim().split(/[\\/]/).pop() || '';
const normalized = (value) => String(value ?? '').trim().toLowerCase();
const stem = (value) => value.replace(/\.[^.]+$/, '');

function rowKeys(value) {
  const leaf = normalized(leafName(displayCell(value)));
  return leaf ? [leaf] : [];
}

function fileKeys(name) {
  const leaf = normalized(leafName(name));
  return leaf ? [...new Set([leaf, stem(leaf)])] : [];
}

function filenameMatches(rows, columnIndex, files) {
  const keyToRows = new Map();
  rows.forEach((row, rowIndex) => {
    rowKeys(row[columnIndex]).forEach((key) => {
      const matches = keyToRows.get(key) || new Set();
      matches.add(rowIndex);
      keyToRows.set(key, matches);
    });
  });
  return files.map((file) => {
    const [full, short] = fileKeys(file.name);
    // A full filename match wins over a stem match (e.g. photo.png over photo).
    const matches = keyToRows.get(full) || keyToRows.get(short) || new Set();
    if (matches.size === 1) return { rowIndex: [...matches][0], reason: '' };
    return { rowIndex: null, reason: matches.size > 1 ? 'Multiple rows match' : 'No matching row' };
  });
}

export function suggestBatchMatchColumn(rows, columnIndices, files) {
  let best = null;
  let bestCount = -1;
  for (const columnIndex of columnIndices) {
    const count = filenameMatches(rows, columnIndex, files).filter((match) => match.rowIndex !== null).length;
    if (count > bestCount) {
      best = columnIndex;
      bestCount = count;
    }
  }
  return { columnIndex: best, matchCount: Math.max(0, bestCount) };
}

export function buildBatchAssetPlan({ rows, files, targetColumn, sourceColumn, mode, startRow = 0, manualRows = new Map(), manualTargets = new Map(), existingMode = 'skip', kind }) {
  const cellTest = kind === 'pdf' ? isPdfCell : isImageCell;
  const automatic = mode === 'filename'
    ? filenameMatches(rows, sourceColumn, files)
    : mode === 'empty'
      ? (() => {
        const reservedRows = new Set([
          ...[...manualTargets.values()].filter((target) => target?.columnIndex === targetColumn).map((target) => target.rowIndex),
          ...manualRows.values(),
        ]);
        const emptyRows = rows.map((row, index) => ({ row, index }))
          .filter(({ row, index }) => index >= startRow && !reservedRows.has(index) && (!cellTest(row[targetColumn]) || !row[targetColumn].assetIds.length))
          .map(({ index }) => index);
        let nextEmpty = 0;
        let nextNewRow = rows.length;
        return files.map((_, index) => {
          if (manualTargets.has(index) || manualRows.has(index)) return { rowIndex: null, reason: '' };
          while (reservedRows.has(nextNewRow)) nextNewRow++;
          const rowIndex = nextEmpty < emptyRows.length ? emptyRows[nextEmpty++] : nextNewRow++;
          return { rowIndex, reason: '' };
        });
      })()
      : files.map((_, index) => {
        const rowIndex = startRow + index;
        return rowIndex < rows.length ? { rowIndex, reason: '' } : { rowIndex: null, reason: 'Past the last row' };
      });
  const assignments = files.map((file, index) => {
    const manualTarget = manualTargets.get(index);
    const selectedRow = manualTarget ? manualTarget.rowIndex : manualRows.has(index) ? manualRows.get(index) : automatic[index].rowIndex;
    const autoNewRow = mode === 'empty' && !manualTarget && !manualRows.has(index) && selectedRow >= rows.length;
    const manualNewRow = mode === 'empty' && manualTarget && selectedRow >= rows.length && selectedRow < rows.length + files.length;
    const rowIndex = Number.isInteger(selectedRow) && selectedRow >= 0 && (selectedRow < rows.length || autoNewRow || manualNewRow) ? selectedRow : null;
    const columnIndex = Number.isInteger(manualTarget?.columnIndex) ? manualTarget.columnIndex : targetColumn;
    const current = rowIndex === null ? null : rows[rowIndex]?.[columnIndex];
    const existingCount = cellTest(current) ? current.assetIds.length : 0;
    const placement = manualTarget?.placement || existingMode;
    const skipped = rowIndex !== null && existingCount > 0 && placement === 'skip';
    return {
      file,
      index,
      rowIndex,
      columnIndex,
      placement,
      newRow: rowIndex !== null && rowIndex >= rows.length,
      existingCount,
      skipped,
      reason: rowIndex === null ? (manualTarget || manualRows.has(index) ? 'No row selected' : automatic[index].reason) : '',
    };
  });
  const importable = assignments.filter((entry) => entry.rowIndex !== null && !entry.skipped);
  const assignedRows = new Set(assignments.filter((entry) => entry.rowIndex !== null).map((entry) => entry.rowIndex));
  const missingRowPreview = [];
  let missingRows = 0;
  if (mode === 'filename') {
    rows.forEach((row, rowIndex) => {
      if (!rowKeys(row[sourceColumn]).length || assignedRows.has(rowIndex)) return;
      missingRows++;
      if (missingRowPreview.length < 25) missingRowPreview.push({ rowIndex, value: displayCell(row[sourceColumn]) });
    });
  } else {
    missingRows = Math.max(0, rows.length - startRow - assignedRows.size);
  }
  return {
    assignments,
    importable,
    matchedRows: assignedRows.size,
    unmatchedFiles: assignments.filter((entry) => entry.rowIndex === null).length,
    skippedFiles: assignments.filter((entry) => entry.skipped).length,
    existingRows: new Set(assignments.filter((entry) => entry.existingCount > 0).map((entry) => entry.rowIndex)).size,
    newRows: new Set(assignments.filter((entry) => entry.newRow).map((entry) => entry.rowIndex)).size,
    missingRows,
    missingRowPreview,
  };
}
