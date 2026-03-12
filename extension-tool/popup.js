// Persist values across popup opens
const STORAGE_KEY_VERCEL = 'dbmerge_vercel_url';
const STORAGE_KEY_SOURCE  = 'dbmerge_source_url';
const STORAGE_KEY_TARGET  = 'dbmerge_target_url';
const STORAGE_KEY_TOKEN   = 'dbmerge_merge_token';

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('vercelUrl').value  = localStorage.getItem(STORAGE_KEY_VERCEL) || '';
  document.getElementById('sourceUrl').value  = localStorage.getItem(STORAGE_KEY_SOURCE) || '';
  document.getElementById('targetUrl').value  = localStorage.getItem(STORAGE_KEY_TARGET) || '';
  document.getElementById('mergeToken').value = localStorage.getItem(STORAGE_KEY_TOKEN)  || '';
});

function showToast(message, type) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast ' + (type === 'success' ? 'success' : 'error');
  setTimeout(() => { toast.className = 'toast hidden'; }, 3500);
}

function setLoading(isLoading) {
  const btn     = document.getElementById('saveBtn');
  const spinner = document.getElementById('spinner');
  const btnText = document.getElementById('btnText');
  btn.disabled        = isLoading;
  spinner.className   = 'spinner' + (isLoading ? '' : ' hidden');
  btnText.textContent = isLoading ? 'Đang lưu...' : 'Lưu cấu hình & Kích hoạt';
}

async function saveConfig() {
  const vercelUrl = document.getElementById('vercelUrl').value.trim().replace(/\/$/, '');
  const sourceUrl = document.getElementById('sourceUrl').value.trim();
  const targetUrl = document.getElementById('targetUrl').value.trim();

  if (!vercelUrl) {
    showToast('Vui lòng nhập Vercel API URL.', 'error');
    return;
  }
  if (!sourceUrl || !targetUrl) {
    showToast('Vui lòng điền đầy đủ cả hai Database URL.', 'error');
    return;
  }

  // Basic URL validation to prevent SSRF / open-redirect
  let parsedUrl;
  try {
    parsedUrl = new URL(vercelUrl);
  } catch {
    showToast('Vercel URL không hợp lệ.', 'error');
    return;
  }
  if (parsedUrl.protocol !== 'https:') {
    showToast('Vercel URL phải dùng HTTPS.', 'error');
    return;
  }

  // Persist values locally
  localStorage.setItem(STORAGE_KEY_VERCEL, vercelUrl);
  localStorage.setItem(STORAGE_KEY_SOURCE, sourceUrl);
  localStorage.setItem(STORAGE_KEY_TARGET, targetUrl);
  const token = document.getElementById('mergeToken').value.trim();
  if (token) localStorage.setItem(STORAGE_KEY_TOKEN, token);

  setLoading(true);
  try {
    const res = await fetch(`${vercelUrl}/api/save-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl, targetUrl })
    });

    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      showToast(data.message || 'Cấu hình đã được lưu thành công!', 'success');
    } else {
      showToast(data.error || `Lỗi ${res.status}: Không thể lưu cấu hình.`, 'error');
    }
  } catch {
    showToast('Không thể kết nối đến server. Kiểm tra lại URL.', 'error');
  } finally {
    setLoading(false);
  }
}

// ── Merge ngay ────────────────────────────────────────────────────────────────
function setMergeLoading(isLoading) {
  const btn     = document.getElementById('mergeBtn');
  const spinner = document.getElementById('mergeSpinner');
  const btnText = document.getElementById('mergeBtnText');
  btn.disabled        = isLoading;
  spinner.className   = 'spinner' + (isLoading ? '' : ' hidden');
  btnText.innerHTML   = isLoading ? 'Đang merge...' : '&#9889; Merge ngay';
}

async function mergeNow() {
  const vercelUrl = document.getElementById('vercelUrl').value.trim().replace(/\/$/, '');
  const sourceUrl = document.getElementById('sourceUrl').value.trim();
  const targetUrl = document.getElementById('targetUrl').value.trim();
  const token     = document.getElementById('mergeToken').value.trim();

  if (!vercelUrl) {
    showToast('Vui lòng nhập Vercel API URL.', 'error');
    return;
  }
  if (!sourceUrl || !targetUrl) {
    showToast('Vui lòng điền đầy đủ cả hai Database URL.', 'error');
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(vercelUrl);
  } catch {
    showToast('Vercel URL không hợp lệ.', 'error');
    return;
  }
  if (parsedUrl.protocol !== 'https:') {
    showToast('Vercel URL phải dùng HTTPS.', 'error');
    return;
  }

  // Persist current values before calling
  localStorage.setItem(STORAGE_KEY_VERCEL, vercelUrl);
  localStorage.setItem(STORAGE_KEY_SOURCE, sourceUrl);
  localStorage.setItem(STORAGE_KEY_TARGET, targetUrl);
  if (token) localStorage.setItem(STORAGE_KEY_TOKEN, token);

  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  setMergeLoading(true);
  try {
    const res  = await fetch(`${vercelUrl}/api/migrate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sourceUrl, targetUrl })
    });

    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      showToast(data.message || 'Merge hoàn tất!', 'success');
    } else {
      showToast(data.error || `Lỗi ${res.status}: Merge thất bại.`, 'error');
    }
  } catch {
    showToast('Không thể kết nối đến server. Kiểm tra lại URL.', 'error');
  } finally {
    setMergeLoading(false);
  }
}
