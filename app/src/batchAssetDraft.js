import { imageCell, isImageCell, isPdfCell, pdfCell } from './datasetContent.js';

const cellKey = (row, column) => `${row}:${column}`;

/** Keep existing assets and pending files ordered without changing the dataset before Import. */
export class BatchAssetDraft {
  constructor(rows, columnTypes, kind) {
    this.rows = rows;
    this.columnTypes = columnTypes;
    this.kind = kind;
    this.cells = new Map();
    this.orders = new Map();
    rows.forEach((row, rowIndex) => columnTypes.forEach((type, columnIndex) => {
      if (type !== kind) return;
      const cell = row[columnIndex];
      const valid = kind === 'pdf' ? isPdfCell(cell) : isImageCell(cell);
      this.cells.set(cellKey(rowIndex, columnIndex), valid ? cell.assetIds.map((id, index) => ({
        key: `asset:${rowIndex}:${columnIndex}:${index}`, type: 'existing', id, name: cell.names?.[index] || '',
      })) : []);
    }));
  }

  planningRows() {
    const result = this.rows.map((row) => row.slice());
    this.cells.forEach((items, key) => {
      const [row, column] = key.split(':').map(Number);
      if (!items.length && row >= result.length) return;
      while (result.length <= row) result.push(this.columnTypes.map((type) => type === 'image' ? imageCell() : type === 'pdf' ? pdfCell() : ''));
      result[row][column] = this.makeCell(items);
    });
    return result;
  }

  makeCell(items) {
    return (this.kind === 'pdf' ? pdfCell : imageCell)(items.map((item) => item.id), items.map((item) => item.name));
  }

  items(plan, row, column) {
    const key = cellKey(row, column);
    const items = [...(this.cells.get(key) || []), ...plan.importable
      .filter((entry) => entry.rowIndex === row && entry.columnIndex === column)
      .map((entry) => ({ key: entry.file.key, type: 'file', file: entry.file }))];
    const order = new Map((this.orders.get(key) || []).map((item, index) => [item, index]));
    return items.sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity));
  }

  moveExisting(key, sourceRow, sourceColumn, targetRow, targetColumn) {
    if (this.columnTypes[targetColumn] !== this.kind || !Number.isInteger(targetRow) || targetRow < 0) return false;
    const source = this.cells.get(cellKey(sourceRow, sourceColumn));
    const index = source?.findIndex((item) => item.key === key) ?? -1;
    if (index < 0) return false;
    const [item] = source.splice(index, 1);
    const destinationKey = cellKey(targetRow, targetColumn);
    const destination = this.cells.get(destinationKey) || [];
    destination.push(item);
    this.cells.set(destinationKey, destination);
    return true;
  }

  placeInOrder(row, column, key, beforeKey, previousItems) {
    // A moved item has exactly one position, including when it crosses cells.
    this.orders.forEach((items, cell) => this.orders.set(cell, items.filter((item) => item !== key)));
    const order = previousItems.map((item) => item.key).filter((item) => item !== key);
    const before = beforeKey ? order.indexOf(beforeKey) : -1;
    order.splice(before < 0 ? order.length : before, 0, key);
    this.orders.set(cellKey(row, column), order);
  }

  hasExistingChanges(plan) {
    for (const key of this.cells.keys()) {
      const [row, column] = key.split(':').map(Number);
      const before = this.rows[row]?.[column];
      const valid = this.kind === 'pdf' ? isPdfCell(before) : isImageCell(before);
      const next = this.makeCell(this.items(plan, row, column).filter((item) => item.type === 'existing'));
      if (JSON.stringify(next.assetIds) !== JSON.stringify(valid ? before.assetIds : []) ||
          JSON.stringify(next.names) !== JSON.stringify(valid ? before.assetIds.map((_, index) => before.names?.[index] || '') : [])) return true;
    }
    return false;
  }

  resultCells(plan, imported) {
    if (imported.length !== plan.importable.length) throw new Error('Some files could not be imported. No dataset cells were changed.');
    const assetsByFile = new Map(plan.importable.map((entry, index) => [entry.file.key, imported[index]]));
    const keys = new Set([...this.cells.keys(), ...plan.importable.map((entry) => cellKey(entry.rowIndex, entry.columnIndex))]);
    return [...keys].map((key) => {
      const [rowIndex, columnIndex] = key.split(':').map(Number);
      const items = this.items(plan, rowIndex, columnIndex).map((item) => item.type === 'existing' ? item : assetsByFile.get(item.key));
      return { rowIndex, columnIndex, cell: this.makeCell(items) };
    });
  }
}
