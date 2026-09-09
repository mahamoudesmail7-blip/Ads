// AI Creative Factory — text/vision AI helper.
//
// Thin wrapper over the existing services/ai.js askClaude() (Anthropic, the
// key the rest of the app already uses). Adds: vision image blocks, strict
// JSON extraction, and a mock-safe contract — callAiJson() returns
// { ok:false, reason } instead of throwing when ANTHROPIC_API_KEY is missing
// or the call fails, so every caller can fall back to a deterministic result
// and the workflow keeps working with no AI configured.
import { askClaude } from '../ai.js';
import { textAiConfigured } from './config.js';
import { logger } from '../../logger.js';

/**
 * @param {object} p
 * @param {string} p.system
 * @param {string} p.user                     the text instruction
 * @param {Array<{buffer:Buffer,mime:string,label?:string}>} [p.images]
 * @param {number} [p.maxTokens]
 * @returns {Promise<{ok:true,data:any,raw:string}|{ok:false,reason:string}>}
 */
export async function callAiJson({ system, user, images = [], maxTokens = 1600 }) {
  if (!textAiConfigured()) return { ok: false, reason: 'AI النصي غير مُهيأ (ANTHROPIC_API_KEY).' };

  const content = [];
  for (const img of images.slice(0, 8)) {
    if (!img?.buffer?.length) continue;
    if (img.label) content.push({ type: 'text', text: img.label });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mime || 'image/png', data: Buffer.from(img.buffer).toString('base64') },
    });
  }
  content.push({ type: 'text', text: `${user}\n\nرد بـ JSON صالح فقط — بدون أي شرح خارج الـ JSON.` });

  let raw = '';
  try {
    raw = await askClaude({ system, messages: [{ role: 'user', content }], maxTokens });
  } catch (err) {
    logger.error('CF_TEXT_AI_FAILED', { message: err?.message?.slice(0, 200) });
    return { ok: false, reason: err?.message || 'فشل نداء AI.' };
  }

  const parsed = extractJson(raw);
  if (parsed === undefined) return { ok: false, reason: 'رد AI لم يحتوِ JSON صالح.' };
  return { ok: true, data: parsed, raw };
}

/** Pulls the first balanced JSON object/array out of a model reply (handles ```json fences + prose). */
export function extractJson(text) {
  if (!text) return undefined;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);
  for (const c of candidates) {
    const s = c.indexOf('{');
    const sa = c.indexOf('[');
    const start = s === -1 ? sa : sa === -1 ? s : Math.min(s, sa);
    if (start === -1) continue;
    const open = c[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(c.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return undefined;
}
