/** Close a canvas menu and its temporary visuals together, on selection or dismissal. */
export function attachContextMenuDismissal(menu, { onClose, ownerDocument = menu.ownerDocument } = {}) {
  let closed = false;
  const onOutside = (event) => { if (!menu.contains(event.target)) close(); };
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    menu.remove();
    ownerDocument.removeEventListener('pointerdown', onOutside, true);
    ownerDocument.removeEventListener('contextmenu', onOutside, true);
    ownerDocument.removeEventListener('keydown', onKey, true);
    ownerDocument.removeEventListener('workflow:viewport-changed', close);
    onClose?.();
  };
  // Register on pointerdown: the pointerup that opened the menu cannot dismiss it.
  ownerDocument.addEventListener('pointerdown', onOutside, true);
  ownerDocument.addEventListener('contextmenu', onOutside, true);
  ownerDocument.addEventListener('keydown', onKey, true);
  ownerDocument.addEventListener('workflow:viewport-changed', close);
  return close;
}
