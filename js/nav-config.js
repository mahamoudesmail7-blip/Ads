// nav-config.js — the ONE navigation map of the whole system, used by the app shell (app.html) and by every standalone page's sidebar.
// It groups the 23 old flat menu entries into 6 sections, nests the AI Media Buyer's own sections under it (so they are not a second menu any more),
// removes the duplicates / dead link (the old «مركز التوسّع» entry pointed at a page that does not exist — it is now a sub-section of AI Media Buyer),
// and lists the sub-sections that the shell shows as «feature slides».
import { NAV_ITEMS } from './ui-common.js';
import { lucide } from './launch-icons.js';

const item = (key) => NAV_ITEMS.find((i) => i.key === key);
const page = (key, over = {}) => { const b = item(key); return { key, label: b.label, href: b.href, icon: b.icon, badgeId: b.badgeId, ...over }; };
const ic = (name) => lucide(name, 18);

/** Sections of the AI Media Buyer (hash routes of ai-media-buyer.html). `short` is the label used in slides. */
export const AMB_SECTIONS = [
  { sub: 'home', label: 'الرئيسية', icon: 'target' },
  { sub: 'campaigns', label: 'أداء الإعلانات', icon: 'trending' },
  { sub: 'products', label: 'منتجات الإعلانات', icon: 'package' },
  { sub: 'plan', label: 'القرارات الذكية', icon: 'sparkles' },
  { sub: 'decisions', label: 'مركز القرار', icon: 'zap' },
  { sub: 'scale', label: 'مركز التوسّع', icon: 'rocket' },
  { sub: 'operator', label: 'AI Operator', icon: 'shield' },
  { sub: 'winners', label: 'الأبطال', icon: 'image' },
  { sub: 'medialib', label: 'مكتبة الكرياتيفات', icon: 'layers' },
  { sub: 'clone', label: 'استنساخ وجدولة', icon: 'copy' },
  { sub: 'launch', label: 'رفع الكامبين', icon: 'upload' },
  { sub: 'tasks', label: 'مهام الإعلانات', icon: 'clipboard' },
  { sub: 'history', label: 'التقارير', icon: 'fileText' },
  { sub: 'settings', label: 'إعدادات الإعلانات', icon: 'sliders' },
];

export const NAV_GROUPS = [
  { id: 'home', accent: '#6d8cff', label: 'الرئيسية', icon: ic('target'), items: [page('dashboard'), page('alerts'), page('tasks')] },
  { id: 'orders', accent: '#2ec4e6', label: 'الأوردرات والعملاء', icon: ic('cart'), items: [page('entry'), page('easyorders'), page('lostorders'), page('storeconnections'), page('customers')] },
  { id: 'catalog', accent: '#34d399', label: 'المنتجات والمخزون', icon: ic('package'), items: [page('products'), page('inventory'), page('compare'), page('ranking'), page('productresearch')] },
  {
    id: 'ads', accent: '#a78bfa', label: 'الإعلانات والذكاء الاصطناعي', icon: ic('megaphone'),
    items: [
      page('aimediabuyer', { children: AMB_SECTIONS.map((s) => ({ key: `amb:${s.sub}`, label: s.label, href: `ai-media-buyer.html#${s.sub}`, icon: ic(s.icon), sub: s.sub })) }),
      page('aiintel'),
      { key: 'pmc', label: 'مركز التسويق الذكي', href: 'product-marketing-center.html', icon: ic('sparkles') },
      page('creativefactory'),
    ],
  },
  { id: 'team', accent: '#fbbf24', label: 'الفريق والإدارة', icon: ic('users'), items: [page('work'), page('manager'), page('users')] },
  {
    id: 'system', accent: '#fb7fa8', label: 'النظام', icon: ic('sliders'),
    items: [page('settings'), page('backuprecovery'), { key: 'aiusage', label: 'استهلاك الذكاء الاصطناعي', href: 'ai-usage.html', icon: ic('zap') }, page('test')],
  },
];

/** Pages that are not a menu entry of their own but belong to one (so the shell highlights the right item). */
export const PAGE_ALIASES = {
  'product.html': 'products',
  'easyorders-catalog-sync.html': 'easyorders',
  'register.html': 'users',
};

// who may see what — the same rules the old sidebar applied (ui-common.js), plus the two pages that had no entry
export const ROLE_REQUIREMENT = {
  manager: ['ADMIN', 'MANAGER'], work: ['ADMIN', 'MANAGER'], settings: ['ADMIN'], aiintel: ['ADMIN', 'MANAGER'], aimediabuyer: ['ADMIN', 'MANAGER'],
  creativefactory: ['ADMIN', 'MANAGER'], productresearch: ['ADMIN', 'MANAGER'], customers: ['ADMIN', 'MANAGER'], backuprecovery: ['ADMIN'], storeconnections: ['ADMIN'],
  pmc: ['ADMIN', 'MANAGER'], aiusage: ['ADMIN'],
};
export const OWNER_ONLY = new Set(['users']);

export function canSee(entry, user) {
  if (!user) return true;
  if (OWNER_ONLY.has(entry.key)) return !!user.is_owner;
  const roles = ROLE_REQUIREMENT[entry.key];
  return !roles || roles.includes(user.role);
}

/** The groups with only what this user may see (empty groups dropped). */
export function visibleGroups(user) {
  return NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((i) => canSee(i, user)) }))
    .filter((g) => g.items.length > 0);
}

/** Finds the menu entry (and its group) for a page path like «products.html» + optional hash «#launch». */
export function locate(pathname, hash = '', groups = NAV_GROUPS) {
  const file = String(pathname || '').split('/').pop() || 'index.html';
  const aliased = PAGE_ALIASES[file];
  for (const g of groups) {
    for (const it of g.items) {
      if ((aliased && it.key === aliased) || it.href.split('#')[0] === file) {
        const sub = it.children ? it.children.find((c) => `#${c.sub}` === hash) || null : null;
        return { group: g, item: it, child: sub };
      }
    }
  }
  return null;
}
