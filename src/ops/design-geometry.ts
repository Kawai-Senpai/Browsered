export interface GeometryOptions {
  alignment_tolerance_px?: number;
  spacing_tolerance_px?: number;
  scope?: string;
  ignore?: string;
}

// The audit injects this function alongside its existing visibility and selector helpers.
export const DESIGN_GEOMETRY = String.raw`(root, options, styleOf, visible, locator, sample) => {
  const alignment = options.alignment_tolerance_px ?? 3;
  const spacing = options.spacing_tolerance_px ?? 4;
  const control = 'button,[role="button"],input:not([type="hidden"]),select,textarea,a[href]';
  const ignore = options.ignore ? ':is(' + options.ignore + ')' : null;
  const roots = options.scope ? [...root.querySelectorAll(options.scope)] : [root];
  const parents = new Set(roots.flatMap(el => [el, ...el.querySelectorAll('*')]));
  const withinIgnore = el => Boolean(ignore && el.closest(ignore));
  const round = value => Math.round(value * 10) / 10;
  const evidence = item => ({ selector: locator(item.el) });
  let groupsChecked = 0;

  for (const parent of parents) {
    if (parent.children.length < 2 || withinIgnore(parent)) continue;
    const style = styleOf(parent);
    const grid = style.display.endsWith('grid');
    if (!grid && !style.display.endsWith('flex')) continue;
    if (style.writingMode !== 'horizontal-tb') continue;
    const vertical = !grid && style.flexDirection.startsWith('column');
    const groups = new Map();
    for (const el of parent.children) {
      const childStyle = styleOf(el);
      if (!visible(el) || withinIgnore(el) || ['absolute','fixed','sticky'].includes(childStyle.position)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue;
      const role = el.getAttribute('role') || el.localName;
      const variant = el.matches(control) ? '' : [...el.classList].sort().join(' ');
      if (!variant && !el.matches(control) && !['article','li','section'].includes(role)) continue;
      const key = JSON.stringify([role, variant, childStyle.alignSelf, childStyle.justifySelf]);
      const items = groups.get(key) ?? [];
      items.push({
        el,
        start: vertical ? rect.top : rect.left,
        end: vertical ? rect.bottom : rect.right,
        cross: vertical ? rect.left : rect.top,
        crossEnd: vertical ? rect.right : rect.bottom,
      });
      groups.set(key,items);
    }
    for (const items of groups.values()) {
      if (items.length < 2) continue;
      const rows = [];
      for (const item of items) {
        const row = grid || style.flexWrap !== 'nowrap' ? rows.find(([first]) =>
          Math.min(item.crossEnd,first.crossEnd)-Math.max(item.cross,first.cross) >
            Math.min(item.crossEnd-item.cross,first.crossEnd-first.cross)/2) : rows[0];
        if (row) row.push(item);
        else rows.push([item]);
      }
      for (const row of rows) {
        if (row.length < 2) continue;
        groupsChecked++;
        row.sort((a,b)=>a.start-b.start);
        const alignSelf = styleOf(row[0].el).alignSelf;
        const mode = alignSelf === 'auto' ? style.alignItems : alignSelf;
        const coordinate = item => mode.includes('center') ? (item.cross + item.crossEnd)/2 :
          mode.endsWith('end') || (vertical && mode.endsWith('start') && style.direction === 'rtl') ? item.crossEnd : item.cross;
        const group = locator(parent);
        const axis = vertical ? 'x' : 'y';
        if (!mode.includes('baseline')) {
          const values = row.map(coordinate).sort((a,b)=>a-b);
          const expected = values[Math.floor(values.length/2)];
          const deviations = row.filter(item=>Math.abs(coordinate(item)-expected)>alignment);
          for (const item of deviations) {
            sample('misaligned_peers',{...evidence(item),group,axis,deviation_px:round(coordinate(item)-expected),
              expected_px:round(expected), tolerance_px:alignment, peers:row.slice(0,8).map(evidence)});
          }
        }
        // Heterogeneous or overlapping series have no reliable repeating gap.
        if (row.length < 4 || row.some((item,i)=>i && item.start < row[i-1].end-1)) continue;
        const gaps = row.slice(1).map((item,i)=>item.start-row[i].end);
        const expected = [...gaps].sort((a,b)=>a-b)[Math.floor(gaps.length/2)];
        if (gaps.filter(gap=>Math.abs(gap-expected)<=spacing).length <= gaps.length/2) continue;
        gaps.forEach((gap,i)=>{
          if (Math.abs(gap-expected)>spacing) sample('inconsistent_peer_spacing',{
            ...evidence(row[i+1]),previous:locator(row[i].el),group,axis:vertical?'y':'x',
            gap_px:round(gap),expected_px:round(expected),deviation_px:round(gap-expected),tolerance_px:spacing,
          });
        });
      }
    }
  }
  return groupsChecked;
}`;
