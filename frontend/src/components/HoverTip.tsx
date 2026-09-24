import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';

export interface HoverTipHandle {
  show: (text: string, rect: DOMRect) => void;
  hide: () => void;
}

/**
 * One lightweight tooltip shared by a whole grid (instead of a Tooltip component per cell).
 * Cells carry their text in `data-tip`; `useHoverTip` wires up the delegated handlers.
 */
export const HoverTip = forwardRef<HoverTipHandle>(function HoverTip(_, ref) {
  const [state, setState] = useState<{ text: string; x: number; y: number } | null>(null);
  useImperativeHandle(ref, () => ({
    show: (text, rect) =>
      setState((s) =>
        s && s.text === text ? s : { text, x: rect.left + rect.width / 2, y: rect.top },
      ),
    hide: () => setState((s) => (s ? null : s)),
  }));
  if (!state) return null;
  return (
    <div className="ag-tip" style={{ left: state.x, top: state.y }} role="tooltip">
      {state.text}
    </div>
  );
});

export function useHoverTip() {
  const ref = useRef<HoverTipHandle>(null);
  const onMouseOver = useCallback((e: React.MouseEvent) => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-tip]');
    if (el?.dataset.tip) ref.current?.show(el.dataset.tip, el.getBoundingClientRect());
    else ref.current?.hide();
  }, []);
  const hide = useCallback(() => ref.current?.hide(), []);
  return { ref, onMouseOver, onMouseLeave: hide, hide };
}
