const $ = (id) => document.getElementById(id);
const fields = ['repository', 'rootFolder', 'branch'];
const DEBUG_KEY = 'jungolhubDebugLogs';

function status(text, error = false) {
  const el = $('status');
  el.textContent = text;
  el.style.color = error ? '#d1242f' : '#1a7f37';
}

async function renderLogs() {
  const stored = await chrome.storage.local.get({ [DEBUG_KEY]: [] });
  const logs = stored[DEBUG_KEY] || [];
  if (!logs.length) {
    $('debugLogs').textContent = '로그 없음';
    return;
  }
  $('debugLogs').textContent = logs.slice(-25).map((entry) => {
    const t = entry.at ? new Date(entry.at).toLocaleTimeString() : '';
    const data = entry.data && Object.keys(entry.data).length ? ` ${JSON.stringify(entry.data)}` : '';
    return `[${t}] ${entry.stage}${data}`;
  }).join('\n');
  $('debugLogs').scrollTop = $('debugLogs').scrollHeight;
}

async function load() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  if (response?.ok) {
    for (const field of fields) $(field).value = response.settings?.[field] || '';
    if (response.settings?.hasToken) $('token').placeholder = '저장된 토큰 있음 — 변경 시 새 토큰 입력';
  }
  await renderLogs();
}

async function currentSettings(includeStoredToken = true) {
  const token = $('token').value.trim();
  const existing = await chrome.storage.local.get({ token: '' });
  return {
    token: token || (includeStoredToken ? existing.token : ''),
    repository: $('repository').value.trim(),
    rootFolder: $('rootFolder').value.trim() || 'JUNGOL',
    branch: $('branch').value.trim()
  };
}

$('save').addEventListener('click', async () => {
  status('저장 중...');
  const payload = await currentSettings(true);
  const response = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload });
  status(response?.ok ? '저장 완료' : response?.error || '저장 실패', !response?.ok);
  $('token').value = '';
});

$('test').addEventListener('click', async () => {
  status('GitHub 연결 확인 중...');
  const payload = await currentSettings(true);
  const response = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', payload });
  if (response?.ok) status(`연결 성공: ${response.fullName} (${response.defaultBranch})`);
  else status(response?.error || '연결 실패', true);
});

$('refreshLogs').addEventListener('click', renderLogs);
$('clearLogs').addEventListener('click', async () => {
  await chrome.storage.local.set({ [DEBUG_KEY]: [] });
  await renderLogs();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[DEBUG_KEY]) renderLogs();
});

load();
