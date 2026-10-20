import {useEffect, useState} from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

// 系统「减少动态效果」开关：挂载时读一次，之后跟随系统变化。
// 只在挂载时读一次的话，用户中途在系统设置里切换开关（或 DevTools 模拟）后页面不会变，
// 必须刷新才生效——反过来（先开着、再关掉）动画也永远回不来。
export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(QUERY);
    if (!mq?.addEventListener) return;
    const onChange = e => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}
