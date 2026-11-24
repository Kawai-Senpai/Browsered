import { DESIGN_GEOMETRY, type GeometryOptions } from './design-geometry.js';

export interface DesignAuditOptions {
  geometry?: boolean | GeometryOptions;
  allowed_font_sizes?: number[];
  allowed_button_heights?: number[];
  max_sizes_per_role?: number;
}

// Runs against computed styles in Chromium. It does not edit the page or install dependencies.
export const DESIGN_AUDIT = String.raw`(options, requestedWidth) => {
  const doc = document.documentElement;
  const styleCache = new WeakMap();
  const styleOf = el => {
    if (!styleCache.has(el)) styleCache.set(el, getComputedStyle(el));
    return styleCache.get(el);
  };
  const locator = el => {
    const parts = [];
    for (let node = el; node; node = node.parentElement) {
      if (node.id) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      const siblings = node.parentElement?.children;
      const index = siblings ? Array.prototype.indexOf.call(siblings, node) + 1 : 0;
      parts.unshift(node.localName + (index ? ':nth-child(' + index + ')' : ''));
    }
    return parts.join(' > ');
  };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', {willReadFrequently:true});
  const colors = new Map();
  const rgba = color => {
    if (!colors.has(color)) {
      ctx.clearRect(0,0,1,1);
      ctx.fillStyle = color;
      ctx.fillRect(0,0,1,1);
      const [r,g,b,a] = ctx.getImageData(0,0,1,1).data;
      colors.set(color,[r/255,g/255,b/255,a/255]);
    }
    return colors.get(color);
  };
  const over = (a,b) => {
    const alpha = a[3] + b[3] * (1-a[3]);
    return [
      ...a.slice(0,3).map((channel,i) => alpha ? (channel*a[3]+b[i]*b[3]*(1-a[3]))/alpha : 0),
      alpha,
    ];
  };
  const luminance = ([r,g,b]) => [r,g,b].reduce((value,c,i)=>
    value + [0.2126,0.7152,0.0722][i] * (c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4),0);
  const simpleSurface = el => {
    let combined = [0,0,0,0];
    for (let node = el; node; node = node.parentElement) {
      const style = styleOf(node);
      if (+style.opacity !== 1 || style.mixBlendMode !== 'normal' || style.filter !== 'none' ||
          style.backgroundBlendMode !== 'normal' || style.backdropFilter !== 'none') return null;
      if (combined[3] < 1) {
        if (style.backgroundImage !== 'none' || style.backgroundClip === 'text') return null;
        combined = over(combined,rgba(style.backgroundColor));
      }
    }
    const scheme = styleOf(doc).colorScheme.split(' ');
    const dark = scheme.includes('dark') && (!scheme.includes('light') || matchMedia('(prefers-color-scheme: dark)').matches);
    if (combined[3] === 1) return combined;
    return dark ? null : over(combined, [1,1,1,1]);
  };
  const formats = new Map();
  const buttonGroups = new Map();
  const findings = {};
  const counts = {};
  const sample = (code,row) => {
    counts[code] = (counts[code] || 0) + 1;
    const rows = findings[code] ??= [];
    if (rows.length < 12) rows.push(row);
  };
  const visible = el => {
    const style = styleOf(el);
    return style.visibility === 'visible' && el.getClientRects().length &&
      (!el.checkVisibility || el.checkVisibility({ opacityProperty: true }));
  };
  const button = 'button,[role="button"],input[type="button"],input[type="submit"],input[type="reset"]';
  const otherControls = 'a[href],input,select,textarea,[role="link"]';
  const sizes = (key, size, selector) => {
    if (!formats.has(key)) formats.set(key,new Map());
    const family = formats.get(key);
    if (!family.has(size)) family.set(size,{px:size,count:0,selector});
    family.get(size).count++;
  };
  const matchSize = (allowed,size) => allowed.some(value => Math.abs(value-size) <= .5);
  const clippingAncestor = (start,rect,tolerance = 1) => {
    for (let parent = start; parent && parent !== doc; parent = parent.parentElement) {
      const {overflowX,overflowY} = styleOf(parent);
      if (!['hidden','clip'].includes(overflowX) && !['hidden','clip'].includes(overflowY)) continue;
      const box = parent.getBoundingClientRect();
      const left = box.left+parent.clientLeft, top = box.top+parent.clientTop;
      const clippedX = ['hidden','clip'].includes(overflowX) && (rect.left < left-tolerance || rect.right > left+parent.clientWidth+tolerance);
      const clippedY = ['hidden','clip'].includes(overflowY) && (rect.top < top-tolerance || rect.bottom > top+parent.clientHeight+tolerance);
      if (clippedX || clippedY) return parent;
    }
    return null;
  };
  const visuallyHidden = el => {
    for (let node = el; node && node !== doc; node = node.parentElement) {
      const style = styleOf(node);
      if ((style.position === 'absolute' || style.position === 'fixed') &&
          (style.clip !== 'auto' || style.clipPath !== 'none') &&
          node.offsetWidth <= 2 && node.offsetHeight <= 2) return true;
    }
    return false;
  };
  let contrastChecked = 0;
  let contrastUnknown = 0;
  let gradients = 0;
  const gradientSamples = [];
  for (const el of document.body?.querySelectorAll('*') || []) {
    if (el.closest('script,style,template,svg,[inert]') || !visible(el) || visuallyHidden(el)) continue;
    const style = styleOf(el);
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) continue;
    const disabled = el.closest(':disabled,[aria-disabled="true"]');
    const isButton = el.matches(button);
    const isControl = isButton || el.matches(otherControls);
    const control = el.closest(button);
    const textNodes = [...el.childNodes].filter(node => node.nodeType === 3 && node.textContent.trim());
    const label = textNodes.map(node => node.textContent).join(' ').trim()
      || (isButton && el.localName === 'input' ? el.value : '');
    // Icon buttons sometimes keep their accessible label far outside the painted box.
    const indentedLabel = control && Math.abs(parseFloat(style.textIndent)) > Math.max(100, rect.width) &&
      ['hidden','clip'].includes(style.overflowX);
    if (label && !disabled && !indentedLabel) {
      const size = Math.round(parseFloat(style.fontSize)*10)/10;
      const semanticRole = control ? 'button' :
        el.closest('h1,h2,h3,h4,h5,h6')?.localName ??
        (el.closest('code,kbd,samp,pre') ? 'code' : el.closest('sup,sub') ? 'annotation' :
        el.closest('nav') ? 'navigation' : el.closest('small,figcaption,caption') ? 'caption' : 'body');
      sizes(semanticRole,size,locator(el));
      if (options.allowed_font_sizes?.length && !matchSize(options.allowed_font_sizes,size)) {
        sample('off_scale_font_size',{selector:locator(el),role:semanticRole,font_size_px:size});
      }
      for (const node of textNodes) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const clip = clippingAncestor(el,range.getBoundingClientRect(),2);
        if (!clip || styleOf(clip).textOverflow === 'ellipsis' || parseInt(styleOf(clip).webkitLineClamp,10) > 0) continue;
        sample('clipped_text_content',{selector:locator(el),clipped_by:locator(clip),text:node.textContent.trim().slice(0,65)});
        break;
      }
      const background = simpleSurface(el);
      if (!background) contrastUnknown++;
      else {
        contrastChecked++;
        const foreground = rgba(style.webkitTextFillColor || style.color);
        const [light,dark] = [luminance(over(foreground,background)),luminance(background)].sort((a,b)=>b-a);
        const ratio = (light+.05)/(dark+.05);
        const min = size >= 24 || (size >= 18.6667 && Number(style.fontWeight) >= 700) ? 3 : 4.5;
        if (ratio < min) sample('low_text_contrast',{
          selector:locator(el),text:label.slice(0,65),ratio:Number(ratio.toFixed(3)),minimum:min,
          foreground:style.webkitTextFillColor || style.color,
          background:'rgb(' + background.slice(0,3).map(v=>Math.round(v*255)).join(', ') + ')',
        });
      }
    }
    if (isButton && !disabled) {
      const height = Math.round(rect.height*10)/10;
      const selector = locator(el);
      if (options.allowed_button_heights?.length && !matchSize(options.allowed_button_heights,height)) {
        sample('off_scale_button_height',{selector,height_px:height});
      }
      const group = el.parentElement;
      const key = (el.textContent || el.value || '').trim() ? 'labelled' : 'icon_only';
      if (!buttonGroups.has(group)) buttonGroups.set(group,new Map());
      const peers = buttonGroups.get(group);
      if (!peers.has(key)) peers.set(key,[]);
      peers.get(key).push({selector,height_px:height,top:rect.top,bottom:rect.bottom});
    }
    if (isControl && !disabled) {
      const ancestor = clippingAncestor(el.parentElement,rect);
      const clippedBy = ancestor ? locator(ancestor) : rect.left < -1 || rect.right > doc.clientWidth + 1 ? 'viewport' : '';
      if (clippedBy) sample('clipped_control',{selector:locator(el),clipped_by:clippedBy});
    }
    if (style.backgroundImage.includes('gradient(') && rect.width >= 100 && rect.height >= 48) {
      gradients++;
      if (gradientSamples.length < 6) gradientSamples.push(locator(el));
    }
  }
  const typography = Object.fromEntries([...formats].map(([role,values]) => [role,[...values.values()].sort((a,b)=>a.px-b.px)]));
  for (const [role,values] of Object.entries(typography)) {
    const limit = options.max_sizes_per_role ?? 3;
    if (values.length > limit) sample('fragmented_typography',{role,distinct_sizes:values.length,review_threshold:limit,sizes:values.slice(0,16)});
  }
  for (const groups of buttonGroups.values()) for (const peers of groups.values()) {
    const rows = [];
    for (const peer of peers) {
      const row = rows.find(([first])=>Math.min(peer.bottom,first.bottom)-Math.max(peer.top,first.top) > Math.min(peer.height_px,first.height_px)/2);
      if (row) row.push(peer);
      else rows.push([peer]);
    }
    for (const row of rows) {
      const heights = row.map(b=>b.height_px);
      if (row.length > 1 && Math.max(...heights)-Math.min(...heights) >= 4) {
        sample('inconsistent_button_heights',{buttons:row.slice(0,8).map(({selector,height_px})=>({selector,height_px}))});
      }
    }
  }
  if (gradients >= 6) sample('repeated_gradient_surfaces',{count:gradients,selectors:gradientSamples});
  const viewportMeta = document.querySelector('meta[name="viewport" i]');
  const layoutWidth = doc.clientWidth;
  if (requestedWidth <= 480 && layoutWidth > requestedWidth * 1.15) {
    sample(viewportMeta ? 'mobile_layout_wider_than_device' : 'missing_mobile_viewport',{
      requested_width:requestedWidth,layout_width:layoutWidth,
      visual_scale:visualViewport ? Number(visualViewport.scale.toFixed(3)) : null,
      viewport_meta:viewportMeta?.content ?? null,
    });
  }
  const groupsChecked = options.geometry ? (${DESIGN_GEOMETRY})(
    document.body, options.geometry === true ? {} : options.geometry, styleOf, visible, locator, sample,
  ) : undefined;
  return {
    counts, findings, typography,
    ...(groupsChecked === undefined ? {} : { geometry_groups_checked: groupsChecked }),
    coverage:{contrast_text_runs_checked:contrastChecked,contrast_background_unresolved:contrastUnknown},
  };
}`;
