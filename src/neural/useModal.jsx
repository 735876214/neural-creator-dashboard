// 弹窗的可访问性收尾：Esc 关闭、Tab 不跑出弹窗、打开时把焦点给弹窗、关闭后还给原来的元素。
// 监听挂在 document 的捕获阶段：先于页面上的全局快捷键处理，Esc 不会同时触发星图收起。
import {useEffect, useRef} from 'react';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
].join(',');

export function useModal(onClose) {
  const panel = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  // 打开前的焦点必须在 React 把弹窗挂上去之前记下来：effect 里再取就已经是 autoFocus 的输入框了。
  const prev = useRef(typeof document === 'undefined' ? null : document.activeElement);

  useEffect(() => {
    const el = panel.current;
    const before = prev.current;
    // 可见的可交互元素：display:none 与 .visually-hidden（上传图片用的隐藏 file input）都不参与 Tab 循环，
    // 否则焦点会跑到一个看不见的输入框上。
    const items = () => Array.from(el?.querySelectorAll(FOCUSABLE) || []).filter(n => {
      if (n.closest('.visually-hidden')) return false;
      const r = n.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    });
    // 输入框上的 autoFocus 已经落位就别抢：只有焦点还在弹窗外面时才由这里代劳
    const inside = el && document.activeElement && el !== document.activeElement && el.contains(document.activeElement);
    if (!inside) {
      const first = items()[0];
      if (first) first.focus();
      else if (el) { el.tabIndex = -1; el.focus(); }
    }

    const key = e => {
      if (e.isComposing) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current?.(); return; }
      if (e.key !== 'Tab') return;
      const list = items();
      if (!list.length) { e.preventDefault(); el?.focus(); return; }
      const at = list.indexOf(document.activeElement);
      const next = e.shiftKey ? (at <= 0 ? list.length - 1 : at - 1) : (at === -1 || at === list.length - 1 ? 0 : at + 1);
      e.preventDefault();
      list[next].focus();
    };
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('keydown', key, true);
      // 关闭后把焦点还给打开它的按钮，键盘用户不会掉到页面顶部
      if (before && typeof before.focus === 'function' && document.contains(before)) before.focus();
    };
  }, []);

  return panel;
}

// 统一的弹窗外壳：点遮罩关闭、点内容不冒泡、焦点陷阱与 Esc 都走 useModal
export function Modal({onClose, label, className = '', children}) {
  const panel = useModal(onClose);
  return <div className="veil" onClick={onClose}>
    <section ref={panel} tabIndex={-1} className={`modal glass ${className}`.trim()}
      role="dialog" aria-modal="true" aria-label={label} onClick={e => e.stopPropagation()}>
      {children}
    </section>
  </div>;
}
