import { useEffect, useRef } from 'react';

/** Small themed yes/no popup on the same blurred <dialog> as the rules. */
export function ConfirmDialog({ open, title, children, confirmLabel, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="modal modal--small"
      aria-labelledby="confirm-title"
      onClose={onCancel}
      onClick={(e) => e.target === ref.current && onCancel()}
    >
      <div className="panel confirm">
        <h2 id="confirm-title" className="heading">{title}</h2>
        <div className="confirm__body">{children}</div>
        <div className="confirm__actions">
          <button className="btn btn--light" onClick={onCancel} autoFocus>Stay</button>
          <button className="btn btn--primary" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </dialog>
  );
}
