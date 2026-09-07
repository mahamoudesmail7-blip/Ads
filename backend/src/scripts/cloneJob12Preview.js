// READ-ONLY preview for Job 12's campaign (Ahmed Samy -> Hady,
// "Hair-Remover _ scale 4"). Uses analyzeClone() with the EXACT mapping the
// failed batch stored. Confirms the 3 previously-FAILED creatives now
// classify READY after the SHARE/object_story_id recovery fix.
// No writes. No clone. No resume.
import 'dotenv/config';
import { prisma } from '../prisma.js';
import { analyzeClone } from '../services/amb/cloneAnalysis.js';

const P = (s = '') => process.stdout.write(s + '\n');

const job = await prisma.ambCloneJob.findUnique({ where: { id: 12 }, include: { batch: true, objects: true } });
if (!job) { P('Job 12 not found'); process.exit(1); }
const idMap = (() => { try { return JSON.parse(job.batch.identity_map_json || '{}'); } catch { return {}; } })();
P('Job 12  batch ' + job.batch_id + '  status ' + job.status);
P('source ' + job.source_ad_account_id + ' -> dest ' + job.destination_ad_account_id);
P('campaign ' + job.source_campaign_id + '  destCampaign ' + job.destination_campaign_id + '  destAdSet(from objects) ' + (job.objects.find((o) => o.level === 'ADSET')?.destination_id || '-'));
P('identity_map: ' + JSON.stringify(idMap));
P('failed objects: ' + job.objects.filter((o) => o.status === 'FAILED').map((o) => o.level + ':' + o.source_id).join(', '));
P('');

const res = await analyzeClone({
  sourceAccountId: job.source_ad_account_id,
  destinationAccountIds: [job.destination_ad_account_id],
  campaignIds: [job.source_campaign_id],
  destinationPageId: job.destination_page_id || null,
  identityMap: { pages: idMap.pages || {}, instagram: idMap.instagram || {} },
  pixelMap: (() => { try { return JSON.parse(job.batch.pixel_map_json || '{}'); } catch { return {}; } })(),
  allowPageOnlyIg: idMap.allowPageOnlyIg !== false,
});

P('OVERALL: ' + JSON.stringify(res.overallCopySummary));
for (const c of res.campaigns) {
  P('\n==== ' + c.campaignName + ' [' + c.campaignId + '] ====');
  P('  objective=' + c.objective + '  copyStatus=' + c.copyStatus + '  canCopyCompletely=' + c.canCopyCompletely);
  P('  copySummary=' + JSON.stringify(c.copySummary));
  P('  identityRequired.pages=' + JSON.stringify(c.identityRequired.pages) + '  pixelRequired=' + JSON.stringify(c.pixelRequired));
  for (const ad of c.ads) {
    P('  - ' + ad.adName + ' [' + ad.adId + ']');
    P('      copyStatus=' + ad.copyStatus + '  assetAction=' + ad.assetAction + '  transferMode=' + ad.transferMode + '  readiness=' + ad.readiness);
    P('      format=' + ad.normalized?.format + '  hasOSS=' + ad.normalized?.hasObjectStorySpec + '  objectStoryId=' + (ad.normalized?.objectStoryId || '-'));
    P('      cta=' + (ad.normalized?.ctaType || '-') + '  url=' + (ad.normalized?.destinationUrl || '-'));
    P('      title=' + JSON.stringify(ad.normalized?.title || null));
    P('      body(first 120)=' + JSON.stringify((ad.normalized?.body || '').slice(0, 120)));
    P('      identity: page=' + (ad.identity?.destPageId || '-') + ' [' + ad.identity?.pageStatus + ']  ig=' + (ad.identity?.igStatus || '-'));
    P('      pixel: src=' + (ad.pixel?.sourcePixelId || '-') + ' dest=' + (ad.pixel?.destPixelId || '-') + ' [' + ad.pixel?.status + ']');
    P('      media.images=' + JSON.stringify(ad.media?.images) + '  media.videos=' + JSON.stringify(ad.media?.videos));
    for (const r of ad.copyReasons || []) P('      reason: ' + r);
  }
}

// verdict
const all = res.campaigns.flatMap((c) => c.ads);
const ready = all.filter((a) => a.copyStatus === 'READY').length;
P('\n================ VERDICT ================');
P('ads total: ' + all.length + '  READY: ' + ready + '  NEEDS_MAPPING: ' + all.filter((a) => a.copyStatus === 'NEEDS_MAPPING').length + '  CANNOT_COPY: ' + all.filter((a) => a.copyStatus === 'CANNOT_COPY').length);
P('all 3 previously-failed creatives READY: ' + (ready === all.length && all.length === 3 ? 'YES' : 'NO / partial'));
P('\nREAD ONLY — nothing written, no resume.');
process.exit(0);
