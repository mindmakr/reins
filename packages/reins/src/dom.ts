// The DOM and CSS inspector behind `reins.dom()` and `reins_dom`. The core loads this file on the first call.
import { isSensitive, REDACTED } from './redact.js';
import type { DomNode, DomOptions } from './types.js';

const STYLE_KEYS = 'display,position,flexDirection,justifyContent,alignItems,gap,overflowX,overflowY,direction,color,backgroundColor,fontSize,fontWeight,opacity,visibility,zIndex'.split(',');

const R = (n: any) => Math.round(n || 0);

export function inspect(g: any, o: DomOptions = {}): DomNode | null {
  const d = g.document,
    findPanel = (id: string) => d.querySelector?.(`[data-reins="${id.replace(/["\\]/g, '\\$&')}"]`),
    boxOf = (r: any) => ({ x: R(r.left), y: R(r.top), width: R(r.width), height: R(r.height) });
  let root = d && (o.panel ? findPanel(o.panel) : o.selector ? d : d.body);
  if (root && o.selector) root = root.querySelector?.(o.selector);
  if (!root) return null;
  let count = 0;
  const walk = (el: any, depth: number): DomNode => {
    count++;
    const r = el.getBoundingClientRect?.() || {},
      cs = g.getComputedStyle?.(el) || {},
      styles: Record<string, string> = {},
      issues: DomNode['issues'] = [],
      clip = (v: any) => /^hidden|clip$/.test(v),
      attr = (k: string) => el.getAttribute?.(k) || undefined,
      cls = el.className?.trim?.(),
      children: DomNode[] = [];
    let raw = '';
    for (const n of el.childNodes || []) if (n.nodeType == 3) raw += n.textContent;
    raw = raw.trim().slice(0, 80);
    for (const k of STYLE_KEYS) if (cs[k]) styles[k] = '' + cs[k];
    if (el.scrollWidth > el.clientWidth + 1 && (clip(cs.overflowX) || cs.textOverflow == 'ellipsis')) issues.push('horizontal-clip');
    if (el.scrollHeight > el.clientHeight + 1 && clip(cs.overflowY)) issues.push('vertical-clip');
    if ((!r.width || !r.height) && !/^(none|contents)$/.test(cs.display)) issues.push('zero-size');
    if (depth < (o.depth ?? 3)) for (const ch of el.children || []) if (count < (o.maxNodes ?? 40)) children.push(walk(ch, depth + 1));
    return {
      tag: (el.tagName || 'div').toLowerCase(),
      id: el.id || undefined,
      classes: cls ? cls.split(/\s+/) : undefined,
      panel: attr('data-reins'),
      role: attr('role'),
      text: raw ? (isSensitive([el.id, attr('name'), attr('type')].join(' ')) ? REDACTED : raw) : undefined,
      box: boxOf(r),
      styles,
      issues,
      children,
    };
  };
  return walk(root, 0);
}
