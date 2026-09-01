const DEFAULT_SETTINGS = {
  token: '',
  repository: '',
  rootFolder: 'JUNGOL',
  branch: ''
};

const API = 'https://api.github.com';

function sanitizePathPart(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'Untitled';
}

function languageExtension(language = '') {
  const value = String(language).toLowerCase();
  if (/c\+\+|cpp|gnu\+\+/.test(value)) return 'cpp';
  if (/c#|csharp/.test(value)) return 'cs';
  if (/python|pypy/.test(value)) return 'py';
  if (/java(?!script)/.test(value)) return 'java';
  if (/javascript|node/.test(value)) return 'js';
  if (/typescript/.test(value)) return 'ts';
  if (/kotlin/.test(value)) return 'kt';
  if (/rust/.test(value)) return 'rs';
  if (/golang|\bgo\b/.test(value)) return 'go';
  if (/swift/.test(value)) return 'swift';
  if (/ruby/.test(value)) return 'rb';
  if (/php/.test(value)) return 'php';
  if (/pascal/.test(value)) return 'pas';
  if (/(^|[^+])c([^+]|$)|gcc/.test(value)) return 'c';
  return 'txt';
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

function writeAccessError(repository, error) {
  const wrapped = new Error(
    `GitHub 토큰이 ${repository} 저장소에 쓸 수 없습니다. ` +
    `Fine-grained PAT의 Repository access에서 '${repository.split('/')[1]}' 저장소를 포함하고 ` +
    `Repository permissions > Contents를 Read and write로 설정하세요. (${error.message})`
  );
  wrapped.status = error.status;
  wrapped.path = error.path;
  wrapped.method = error.method;
  return wrapped;
}

async function githubRequest(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!response.ok) {
    const apiMessage = data?.message || `GitHub API ${response.status}`;
    const error = new Error(`${apiMessage} [${method} ${path}]`);
    error.status = response.status;
    error.data = data;
    error.path = path;
    error.method = method;
    throw error;
  }
  return data;
}

function buildReadme(problem, language) {
  const lines = [
    `# [JUNGOL ${problem.id}](${problem.url}) ${problem.title}`,
    '',
    `- 언어: ${language || 'Unknown'}`,
    problem.time ? `- 시간 제한: ${problem.time}` : null,
    problem.memory ? `- 메모리 제한: ${problem.memory}` : null,
    '',
    '## 문제', '', problem.problem || '문제 설명은 JUNGOL 원문을 참고하세요.', '',
    '## 입력', '', problem.input || 'JUNGOL 원문을 참고하세요.', '',
    '## 출력', '', problem.output || 'JUNGOL 원문을 참고하세요.', '',
    '> 자동 업로드: JungolHub'
  ];
  return lines.filter((line) => line !== null).join('\n');
}

function encodeRepoPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function putContentFile({ repository, token, branch, path, content, message }) {
  const encodedPath = encodeRepoPath(path);
  const query = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  let existingSha = null;

  try {
    const existing = await githubRequest(`/repos/${repository}/contents/${encodedPath}${query}`, { token });
    existingSha = existing?.sha || null;
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  const body = { message, content: toBase64(content) };
  if (branch) body.branch = branch;
  if (existingSha) body.sha = existingSha;

  return githubRequest(`/repos/${repository}/contents/${encodedPath}`, {
    method: 'PUT', token, body
  });
}

async function assertWriteAccess(repository, token) {
  try {
    // Creates an unreachable Git blob only; it does not change any branch or visible file.
    await githubRequest(`/repos/${repository}/git/blobs`, {
      method: 'POST', token,
      body: { content: 'JungolHub permission probe', encoding: 'utf-8' }
    });
  } catch (error) {
    if (error.status === 403 || error.status === 404) throw writeAccessError(repository, error);
    throw error;
  }
}

async function uploadSolution(payload) {
  const settings = await getSettings();
  if (!settings.token) throw new Error('GitHub 토큰이 설정되지 않았습니다.');
  if (!/^[^/\s]+\/[^/\s]+$/.test(settings.repository)) throw new Error('저장소를 owner/repo 형식으로 설정하세요.');

  const previous = await chrome.storage.local.get({ lastUploadKey: '' });
  if (previous.lastUploadKey === payload.key) return { ok: true, skipped: true };

  const repoInfo = await githubRequest(`/repos/${settings.repository}`, { token: settings.token });
  const branch = settings.branch || repoInfo.default_branch || 'main';
  const folder = [
    sanitizePathPart(settings.rootFolder || 'JUNGOL'),
    `${sanitizePathPart(payload.problem.id)}. ${sanitizePathPart(payload.problem.title)}`
  ].join('/');
  const ext = languageExtension(payload.language);
  const message = `[JUNGOL] ${payload.problem.id}. ${payload.problem.title}`;
  const files = [
    { path: `${folder}/README.md`, content: buildReadme(payload.problem, payload.language) },
    { path: `${folder}/${payload.problem.id}.${ext}`, content: payload.code }
  ];

  try {
    for (const file of files) {
      await putContentFile({
        repository: settings.repository,
        token: settings.token,
        branch,
        path: file.path,
        content: file.content,
        message
      });
    }
  } catch (error) {
    if (error.status === 403 || error.status === 404) throw writeAccessError(settings.repository, error);
    throw error;
  }

  await chrome.storage.local.set({
    lastUploadKey: payload.key,
    lastUpload: {
      problemId: payload.problem.id,
      title: payload.problem.title,
      repository: settings.repository,
      at: new Date().toISOString()
    }
  });
  return { ok: true, skipped: false };
}

async function testConnection(settings) {
  if (!settings.token) throw new Error('토큰을 입력하세요.');
  if (!/^[^/\s]+\/[^/\s]+$/.test(settings.repository)) throw new Error('저장소는 owner/repo 형식이어야 합니다.');

  const repo = await githubRequest(`/repos/${settings.repository}`, { token: settings.token });
  await assertWriteAccess(settings.repository, settings.token);
  return {
    ok: true,
    fullName: repo.full_name,
    defaultBranch: repo.default_branch,
    private: repo.private,
    writeVerified: true
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message?.type === 'SAVE_SETTINGS') {
        const settings = { ...DEFAULT_SETTINGS, ...(message.payload || {}) };
        await chrome.storage.local.set(settings);
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'GET_SETTINGS') {
        const settings = await getSettings();
        const { token, ...safe } = settings;
        sendResponse({ ok: true, settings: { ...safe, hasToken: Boolean(token) } });
        return;
      }
      if (message?.type === 'TEST_CONNECTION') {
        sendResponse(await testConnection(message.payload || {}));
        return;
      }
      if (message?.type === 'UPLOAD_SOLUTION') {
        sendResponse(await uploadSolution(message.payload || {}));
        return;
      }
      sendResponse({ ok: false, error: 'Unknown message' });
    } catch (error) {
      console.error('[JungolHub]', error);
      sendResponse({
        ok: false,
        error: error.message || String(error),
        status: error.status,
        path: error.path,
        method: error.method
      });
    }
  })();
  return true;
});
