/** Use the full cell height when another column makes a dataset row taller. */
export function fillDatasetTextCells(table, resetHeight = false) {
  const textareas = [...table.querySelectorAll('tbody .wd-cell-textarea')];
  if (resetHeight) textareas.forEach((textarea) => { textarea.style.height = textarea.style.minHeight; });
  const heights = textareas.map((textarea) => {
    const cell = textarea.closest('td');
    const style = getComputedStyle(cell);
    return Math.max(parseFloat(textarea.style.minHeight) || 28,
      cell.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0));
  });
  textareas.forEach((textarea, index) => { textarea.style.height = `${heights[index]}px`; });
}
