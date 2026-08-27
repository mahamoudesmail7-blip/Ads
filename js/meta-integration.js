// meta-integration.js — the "🔗 حساب Meta Ads" card on ai-intelligence.html.
// A real OAuth "Connect" flow (Facebook Login for Business) against
// backend/src/routes/meta.js — never a fetch for the connect step itself
// (a real browser navigation is required so the user actually lands on
// facebook.com and logs in there, not here). Everything after connection
// (status, ad accounts, sync) talks to real endpoints that hit the real
// Meta Graph API server-side; nothing here is simulated.
import * as UI from './ui-common.js';
import { api } from './api-client.js';

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ar-EG');
}

async function loadStatus() {
  const status = await api.get('/api/meta/status');
  const disconnectedView = document.getElementById('metaDisconnectedView');
  const connectedView = document.getElementById('metaConnectedView');

  if (!status.connected) {
    disconnectedView.style.display = 'block';
    connectedView.style.display = 'none';
    return;
  }

  disconnectedView.style.display = 'none';
  connectedView.style.display = 'block';
  document.getElementById('metaUserName').textContent = status.metaUserName || '—';
  document.getElementById('metaAdAccountName').textContent = status.selectedAdAccount
    ? `${status.selectedAdAccount.name} (${status.selectedAdAccount.id})`
    : 'مفيش Ad Account مختار';
  document.getElementById('metaTokenExpiry').textContent = fmtDate(status.tokenExpiresAt);
  document.getElementById('metaLastSync').textContent = status.lastSyncedAt ? fmtDate(status.lastSyncedAt) : 'لسه ماحصلتش';
}

function handleRedirectParams() {
  const params = new URLSearchParams(location.search);
  const meta = params.get('meta');
  if (!meta) return;
  if (meta === 'connected') {
    UI.toast('✅ اتربط حساب Meta Ads بنجاح — اختار Ad Account دلوقتي');
    openAdAccountPicker();
  } else if (meta === 'error') {
    UI.toast(`⚠️ فشل ربط Meta Ads: ${params.get('reason') || 'حاول تاني'}`, 'error');
  }
  params.delete('meta');
  params.delete('reason');
  const clean = params.toString();
  history.replaceState({}, '', location.pathname + (clean ? `?${clean}` : ''));
}

async function openAdAccountPicker() {
  const overlay = document.getElementById('metaAdAccountOverlay');
  const list = document.getElementById('metaAdAccountList');
  list.innerHTML = 'جارِ التحميل…';
  overlay.style.display = 'flex';

  try {
    const { adAccounts } = await api.get('/api/meta/ad-accounts');
    if (adAccounts.length === 0) {
      list.innerHTML = '<div class="empty-state">مفيش Ad Accounts متاحة على الحساب ده.</div>';
      return;
    }
    list.innerHTML = adAccounts
      .map(
        (a) => `
        <div class="action-card" style="cursor:pointer;" data-account-id="${a.id}" data-account-name="${UI.escapeHtml(a.name)}" data-business-id="${a.businessId || ''}" data-business-name="${UI.escapeHtml(a.businessName || '')}">
          <div class="action-card-title">${UI.escapeHtml(a.name)}</div>
          <div class="action-card-metrics">
            <span class="mono">${a.id}</span>
            ${a.currency ? `<span>${UI.escapeHtml(a.currency)}</span>` : ''}
            ${a.businessName ? `<span>🏢 ${UI.escapeHtml(a.businessName)}</span>` : '<span class="faint">حساب شخصي</span>'}
          </div>
        </div>`
      )
      .join('');
    list.querySelectorAll('[data-account-id]').forEach((card) => {
      card.onclick = async () => {
        try {
          await api.post('/api/meta/select-ad-account', {
            adAccountId: card.dataset.accountId,
            adAccountName: card.dataset.accountName,
            businessId: card.dataset.businessId || null,
            businessName: card.dataset.businessName || null,
          });
          UI.toast('✅ اتحدد الـ Ad Account');
          overlay.style.display = 'none';
          await loadStatus();
        } catch (err) {
          UI.toast(err.message, 'error');
        }
      };
    });
  } catch (err) {
    list.innerHTML = `<div class="empty-state">⚠️ ${UI.escapeHtml(err.message)}</div>`;
  }
}

async function init() {
  handleRedirectParams();
  await loadStatus();

  document.getElementById('btnMetaConnect').onclick = () => {
    location.href = '/api/meta/connect';
  };
  document.getElementById('btnMetaPickAccount').onclick = openAdAccountPicker;
  document.getElementById('btnMetaAccountCancel').onclick = () => (document.getElementById('metaAdAccountOverlay').style.display = 'none');
  document.getElementById('metaAdAccountOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'metaAdAccountOverlay') document.getElementById('metaAdAccountOverlay').style.display = 'none';
  });

  document.getElementById('btnMetaSync').onclick = async () => {
    const btn = document.getElementById('btnMetaSync');
    const statusEl = document.getElementById('metaSyncStatus');
    btn.disabled = true;
    statusEl.style.display = 'block';
    statusEl.textContent = 'بتتم المزامنة مع Meta...';
    try {
      const result = await api.post('/api/meta/sync', {});
      statusEl.textContent = `✅ اتزامن ${result.rowsSynced} صف (${result.dateFrom} → ${result.dateTo})`;
      UI.toast('✅ اتزامنت بيانات Meta Ads');
      await loadStatus();
      location.reload(); // simplest correct way to make the AI dashboard reflect freshly-synced data
    } catch (err) {
      statusEl.textContent = `⚠️ ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  };

  document.getElementById('btnMetaDisconnect').onclick = async () => {
    const ok = await UI.confirmModal({
      title: 'قطع الاتصال بـ Meta Ads',
      message: 'هيتوقف سحب البيانات التلقائي. البيانات اللي اتزامنت قبل كده مش هتتحذف. متابعة؟',
      confirmLabel: 'قطع الاتصال',
      danger: true,
    });
    if (!ok) return;
    await api.post('/api/meta/disconnect', {});
    UI.toast('تم قطع الاتصال');
    await loadStatus();
  };
}

init();
