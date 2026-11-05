// Smart Campaign — the product journey on top of a page project: product (Easy Orders) → research & audience → images → captions → videos → review → campaign.
// A journey IS a page project (same row, same assets) plus a `smart` section (research, publish / launch state). This file holds the parts that are new:
// the AI research (audience, pains, angles, cautions — from the REAL facts only) and the readiness checklist the review step shows.
// Nothing here writes to Meta or to the store.
import { generateText, TIERS, isAiConfigured } from '../../aiGateway/index.js';
import { MediaError } from './mediaJobs.js';
import { mutateProject, getProject, loadReference } from './pageProjects.js';

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const list = (v, n, max) => (Array.isArray(v) ? v : []).map((x) => str(typeof x === 'string' ? x : x?.name ?? x?.text ?? '', max)).filter(Boolean).slice(0, n);
const int = (v, lo, hi, dflt) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt; };

const RESEARCH_SYSTEM = 'أنت مشتري إعلانات خبير في السوق المصري (Meta Ads). حلّل المنتج من المعلومات الحقيقية المعطاة بس ومن صورته: ممنوع تخترع مواصفات أو أرقام أو ادعاءات طبية/علاجية/نتيجة مضمونة. اكتب بالعامية المصرية البسيطة. الاهتمامات (interests) لازم تكون أسماء اهتمامات حقيقية في Meta Ads (بالإنجليزي زي "Home appliance", "Beauty"). رجّع JSON فقط.';

/** Pure: whatever the model returned → the clean shape the UI and the campaign builder rely on (bounded, typed, never trusts the model's keys). */
export function sanitizeResearch(j) {
  const a = j?.audience || {};
  const gender = ['ALL', 'MALE', 'FEMALE'].includes(String(a.gender).toUpperCase()) ? String(a.gender).toUpperCase() : 'ALL';
  let ageMin = int(a.ageMin, 18, 65, 22), ageMax = int(a.ageMax, 18, 65, 55);
  if (ageMin > ageMax) [ageMin, ageMax] = [ageMax, ageMin];
  return {
    summary: str(j?.summary, 400),
    audience: { gender, ageMin, ageMax, interests: list(a.interests, 8, 60), description: str(a.description, 300) },
    benefits: list(j?.benefits, 8, 120),
    painPoints: list(j?.painPoints, 6, 120),
    objections: list(j?.objections, 4, 120),
    angles: (Array.isArray(j?.angles) ? j.angles : []).map((x) => ({ name: str(x?.name, 40), hook: str(x?.hook, 140) })).filter((x) => x.name && x.hook).slice(0, 4),
    policyCautions: list(j?.policyCautions, 6, 140),
    keywords: { videoSearch: list(j?.keywords?.videoSearch, 6, 60), tiktok: list(j?.keywords?.tiktok, 6, 60), instagramHashtags: list(j?.keywords?.instagramHashtags, 8, 40) },
  };
}

export async function runResearch(projectId, { deps = {} } = {}) {
  const p = await getProject(projectId);
  if (!p) throw new MediaError('المشروع مش موجود.', 'NOT_FOUND');
  if (!(deps.ai ?? isAiConfigured())) throw new MediaError('الذكاء الاصطناعي مش متصل (مفتاح OpenAI).', 'NOT_CONFIGURED');
  if (!p.facts?.length) throw new MediaError('اكتب معلومات ومميزات حقيقية عن المنتج الأول (القسم 1) — البحث بيعتمد عليها.', 'NO_FACTS');
  const ref = await (deps.loadReference || loadReference)(projectId);
  const user = `المنتج: ${p.name}\nالسعر: ${p.price ?? 'غير محدد'}${p.oldPrice ? ` (بدل ${p.oldPrice})` : ''}\nالتصنيف: ${(p.eo?.categories || []).join('، ') || 'غير محدد'}\n${p.supplierUrl ? `لينك المورد (مرجع): ${p.supplierUrl}\n` : ''}معلومات حقيقية عن المنتج:\n${p.facts.map((f) => `- ${f}`).join('\n')}\n\nرجّع JSON بالشكل: {"summary":"جملتين عن المنتج وليه الناس هتشتريه","audience":{"gender":"ALL|MALE|FEMALE","ageMin":18-65,"ageMax":18-65,"interests":["Meta interest names بالإنجليزي"],"description":"مين الجمهور وليه"},"benefits":["فايدة بالمصري من المعلومات بس"],"painPoints":["مشكلة بيحلها"],"objections":["اعتراض ممكن يمنع الشراء"],"angles":[{"name":"اسم الزاوية","hook":"هوك إعلاني قصير"}],"policyCautions":["ادعاءات ممنوعة في ميتا للمنتج ده"],"keywords":{"videoSearch":["كلمات بحث فيديو"],"tiktok":["..."],"instagramHashtags":["بدون #"]}}`;
  const content = [{ type: 'text', text: user }];
  if (ref) content.push({ type: 'image', source: { type: 'base64', media_type: ref.mime, data: ref.buffer.toString('base64') } });
  let j;
  try {
    const out = await (deps.generate || generateText)({ feature: 'amb_smart_research', tier: TIERS.BALANCED, system: RESEARCH_SYSTEM, messages: [{ role: 'user', content }], maxTokens: 1500, jsonMode: true });
    j = JSON.parse(out.text);
  } catch (e) { throw new MediaError(e.budgetBlocked ? e.message : 'تعذّر عمل البحث حاليًا — جرّب تاني.', 'RESEARCH_FAILED'); }
  const research = { ...sanitizeResearch(j), at: new Date().toISOString() };
  await mutateProject(projectId, (proj) => { proj.smart = { ...(proj.smart || {}), research }; });
  return research;
}

/** Pure: how a researched audience maps onto the campaign builder's targeting (Meta targeting is the owner's call — this is only the starting point). */
export function suggestTargeting(research) {
  const a = research?.audience;
  if (!a) return null;
  return { mode: 'CUSTOM', genders: a.gender || 'ALL', ageMin: a.ageMin ?? 18, ageMax: a.ageMax ?? 65, geoRegions: [], placementsMode: 'AUTOMATIC', interests: a.interests || [] };
}

/**
 * Pure: the review checklist. level: ok | warn | fail. A `fail` blocks the journey from being called ready; a `warn` is shown but allowed.
 * `step` = the journey step where the owner fixes it.
 */
export function readiness(p) {
  const items = [];
  const add = (key, level, label, detail, step) => items.push({ key, level, label, detail, step });
  const imgs = (p.images || []).filter((i) => i.status === 'READY').length;
  const caps = p.copy?.captions || [];
  const capIssues = (p.copy?.claimIssues || []).filter((i) => /^caption\d+$/.test(i.field));
  const vids = (p.videos || []).filter((v) => v.kind === 'AI' || v.kind === 'FILE').length;
  const linkVids = (p.videos || []).filter((v) => v.kind !== 'AI' && v.kind !== 'FILE').length;

  if (p.eo) add('product', 'ok', 'المنتج مربوط بإيزي أوردر', p.eo.name, 1); else add('product', 'warn', 'المنتج مش مربوط بإيزي أوردر', 'هتحتاج تحط لينك الصفحة بإيدك وتختار المنتج وقت الكامبين.', 1);
  if (p.eo?.trackStock && (p.eo.quantity ?? 1) <= 0) add('stock', 'fail', 'المخزون خلص', 'مينفعش تعلن على منتج مخزونه صفر.', 1); else add('stock', 'ok', 'المخزون', p.eo?.trackStock ? `متاح ${p.eo.quantity}` : 'مش متتبّع', 1);
  if ((p.facts || []).length >= 3) add('facts', 'ok', 'معلومات المنتج', `${p.facts.length} معلومة`, 1); else add('facts', 'warn', 'معلومات المنتج قليلة', 'الـ AI مش هيكتب غير اللي هنا — حط 3 معلومات على الأقل.', 1);
  if (!p.reference) add('reference', 'fail', 'مفيش صورة للمنتج', 'كل الصور والفيديوهات بتبدأ من صورة المنتج.', 1);
  if (p.smart?.research) add('research', 'ok', 'البحث والجمهور', `${p.smart.research.audience?.interests?.length || 0} اهتمام · ${p.smart.research.angles?.length || 0} زاوية`, 2); else add('research', 'warn', 'لسه ما اتعملش بحث', 'الجمهور والزوايا بتساعد في الاستهداف والكابشن.', 2);
  if (imgs >= 3) add('images', 'ok', 'صور الصفحة', `${imgs} صورة جاهزة`, 3); else if (imgs > 0) add('images', 'warn', 'صور الصفحة قليلة', `${imgs} صورة — الأحسن 3 على الأقل.`, 3); else add('images', 'fail', 'مفيش صور جاهزة', 'ولّد صور الصفحة الأول.', 3);
  if (!caps.length) add('captions', 'fail', 'مفيش كابشنات', 'اكتب المحتوى بالـ AI عشان تطلع كابشنات الإعلان.', 4);
  else if (capIssues.length) add('captions', 'warn', 'كابشنات فيها ادعاءات محتاجة مراجعة', capIssues.map((i) => `${i.field}: ${i.reason}`).join(' · '), 4);
  else add('captions', 'ok', 'الكابشنات', `${caps.length} كابشن`, 4);
  if (vids > 0) add('videos', 'ok', 'الفيديوهات', `${vids} فيديو جاهز للرفع${linkVids ? ` (+${linkVids} لينك محتاج استيراد)` : ''}`, 5);
  else add('videos', 'warn', 'مفيش فيديو جاهز للرفع', linkVids ? 'اللينكات محتاجة استيراد قبل الرفع.' : 'ممكن تشغّل بالصور بس، بس الفيديو غالبًا أحسن.', 5);
  const fails = items.filter((i) => i.level === 'fail');
  return { items, ready: fails.length === 0, blockers: fails.map((i) => i.label), warnings: items.filter((i) => i.level === 'warn').length };
}

/** The step bar: one state per journey step, from the same facts. */
export function stepStates(p) {
  const r = readiness(p);
  const imgsReady = (p.images || []).filter((i) => i.status === 'READY').length;
  const imgsTotal = (p.images || []).length;
  const caps = (p.copy?.captions || []).length;
  const vids = (p.videos || []).length;
  const onStore = !!p.eo; // a product that already lives on the store has its page there: «صفحتك جاهزة»
  const st = (done, fail) => (done ? 'done' : fail ? 'fail' : 'todo');
  const published = !!p.smart?.publish?.at;
  return [
    { key: 'info', n: 1, label: 'المعلومات', state: r.items.find((i) => i.key === 'stock')?.level === 'fail' ? 'fail' : st(!!p.eo || ((p.facts || []).length > 0 && !!p.reference)) },
    { key: 'research', n: 2, label: 'البحث', state: st(!!p.smart?.research) },
    { key: 'images', n: 3, label: 'صور الصفحة', sub: imgsTotal ? `${imgsReady}/${imgsTotal}` : '', state: imgsReady >= 3 && imgsReady === imgsTotal ? 'done' : imgsReady > 0 ? 'warn' : 'todo' },
    { key: 'page', n: 4, label: 'صفحة المنتج', sub: onStore && !p.copy ? 'صفحتك جاهزة' : '', state: p.copy ? 'done' : onStore ? 'store' : 'todo' },
    { key: 'publish', n: 5, label: 'النشر على المتجر', sub: onStore && !published ? 'صفحتك جاهزة' : '', state: published ? 'done' : onStore ? 'store' : 'todo' },
    { key: 'captions', n: 6, label: 'الكابشن', sub: caps ? `${caps} كابشن` : '', state: st(caps > 0) },
    { key: 'videos', n: 7, label: 'الفيديوهات', sub: vids ? `${vids} فيديو` : '', state: st(vids > 0) },
    { key: 'campaign', n: 8, label: 'الكامبين', state: p.smart?.launch?.status === 'COMPLETE' ? 'done' : p.smart?.launch?.jobId ? 'warn' : 'todo' },
  ];
}
