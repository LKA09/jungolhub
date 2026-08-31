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
  if (/ocaml/.test(value)) return 'ml';
  if (/haskell/.test(value)) return 'hs';
  if (/elixir/.test(value)) return 'ex';
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
    '## 문제',
    '',
    problem.problem || '문제 설명은 JUNGOL 원문을 참고하세요.',
    '',
    '## 입력',
    '',
    problem.input || 'JUNGOL 원문을 참고하세요.',
    '',
    '## 출력',
    '',
    problem.output || 'JUNGOL 원문을 참고하세요.',
    '',
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

  const body = {
    message,
    content: toBase64(content)
  };
  if (branch) body.branch = branch;
  if (existingSha) body.sha = existingSha;

  return githubRequest(`/repos/${repository}/contents/${encodedPath}`, {
    method: 'PUT',
    token,
    body
  });
}

async function uploadSolution(payload) {
  const settings = await getSettings();
  if (!settings.token) throw new Error('GitHub 토큰이 설정되지 않았습니다.');
  if (!/^[^/\s]+\/[^/\s]+$/.test(settings.repository)) {
    throw new Error('저장소를 owner/repo 형식으로 설정하세요.');
  }

  const previous = await chrome.storage.local.get({ lastUploadKey: '' });
  if (previous.lastUploadKey === payload.key) return { ok: true, skipped: true };

  const repoInfo = await githubRequest(`/repos/${settings.repository}`, { token: settings.token });
  if (repoInfo.permissions && repoInfo.permissions.push === false) {
    throw new Error('이 토큰은 대상 저장소에 쓰기(push) 권한이 없습니다.');
  }

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

  // Fine-grained PAT과 가장 호환성이 높은 repository contents API만 사용한다.
  // GitHub 문서 권고대로 파일 쓰기는 직렬로 실행한다.
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
  if (!/^[^/\s]+\/[^/\s]+$/.test(settings.repository)) {
    throw new Error('저장소는 owner/repo 형식이어야 합니다.');
  }

  const repo = await githubRequest(`/repos/${settings.repository}`, { token: settings.token });
  if (repo.permissions && repo.permissions.push === false) {
    throw new Error('저장소 읽기는 가능하지만 쓰기 권한이 없습니다.');
  }

  return {
    ok: true,
    fullName: repo.full_name,
    defaultBranch: repo.default_branch,
    private: repo.private,
    push: repo.permissions?.push !== false
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
        const result = await testConnection(message.payload || {});
        sendResponse(result);
        return;
      }

      if (message?.type === 'UPLOAD_SOLUTION') {
        const result = await uploadSolution(message.payload || {});
        sendResponse(result);
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
