const $ = (id) => document.getElementById(id);
const DEBUG_KEY = 'jungolhubDebugLogs';

let savedSettings = {
  repository: '',
  rootFolder: 'JUNGOL',
  branch: '',
  hasToken: false
};
let currentFolderPath = '';
let repositories = [];

function status(text, error = false) {
  const el = $('status');
  el.textContent = text || '';
  el.style.color = error ? '#d1242f' : '#1a7f37';
}

function setConnectionBadge(text, state = 'muted') {
  const badge = $('connectionBadge');
  badge.textContent = text;
  badge.className = `badge ${state === 'ok' ? '' : state}`.trim();
}

async function getToken() {
  const typed = $('token').value.trim();
  if (typed) return typed;
  const stored = await chrome.storage.local.get({ token: '' });
  return stored.token || '';
}

async function renderLogs() {
  const stored = await chrome.storage.local.get({ [DEBUG_KEY]: [] });
  const logs = stored[DEBUG_KEY] || [];
  if (!logs.length) {
    $('debugLogs').textContent = '로그 없음';
    return;
  }
  $('debugLogs').textContent = logs.slice(-30).map((entry) => {
    const t = entry.at ? new Date(entry.at).toLocaleTimeString() : '';
    const data = entry.data && Object.keys(entry.data).length ? ` ${JSON.stringify(entry.data)}` : '';
    return `[${t}] ${entry.stage}${data}`;
  }).join('\n');
  $('debugLogs').scrollTop = $('debugLogs').scrollHeight;
}

function renderDestination() {
  const repository = $('repository').value;
  const branch = $('branch').value || '기본 브랜치';
  const folder = $('rootFolder').value.trim();
  $('destination').textContent = repository
    ? `${repository} · ${branch} · /${folder ? `${folder}/` : ''}<문제번호. 문제명>/`
    : '저장 위치를 선택하세요.';
}

function populateRepositories(items, selected = '') {
  repositories = items || [];
  const select = $('repository');
  select.replaceChildren(new Option('저장소 선택', ''));

  for (const repo of repositories) {
    const label = `${repo.fullName}${repo.private ? ' 🔒' : ''}${repo.archived ? ' (archived)' : ''}`;
    select.add(new Option(label, repo.fullName));
  }

  if (selected && !repositories.some((repo) => repo.fullName === selected)) {
    select.add(new Option(`${selected} (저장된 값)`, selected));
  }

  select.value = selected || '';
  renderDestination();
}

function populateBranches(branches, selected, defaultBranch) {
  const select = $('branch');
  select.replaceChildren();

  const available = [...new Set(branches || [])];
  if (defaultBranch && !available.includes(defaultBranch)) available.unshift(defaultBranch);
  if (selected && !available.includes(selected)) available.unshift(selected);

  if (!available.length) {
    select.add(new Option('기본 브랜치', ''));
    select.value = '';
    return;
  }

  for (const branch of available) {
    const suffix = branch === defaultBranch ? ' (기본)' : '';
    select.add(new Option(`${branch}${suffix}`, branch));
  }
  select.value = selected && available.includes(selected) ? selected : (defaultBranch || available[0]);
}

function renderBreadcrumbs(path) {
  const container = $('breadcrumbs');
  container.replaceChildren();

  const root = document.createElement('span');
  root.className = 'crumb';
  root.textContent = 'ROOT';
  root.dataset.path = '';
  container.append(root);

  let built = '';
  for (const part of path.split('/').filter(Boolean)) {
    container.append(document.createTextNode(' / '));
    built = built ? `${built}/${part}` : part;
    const crumb = document.createElement('span');
    crumb.className = 'crumb';
    crumb.textContent = part;
    crumb.dataset.path = built;
    container.append(crumb);
  }

  container.querySelectorAll('.crumb').forEach((crumb) => {
    crumb.addEventListener('click', () => browseFolder(crumb.dataset.path || ''));
  });
}

function renderFolders(path, folders) {
  currentFolderPath = path || '';
  $('currentFolder').textContent = currentFolderPath ? `/${currentFolderPath}` : '/';
  $('folderUp').disabled = !currentFolderPath;
  renderBreadcrumbs(currentFolderPath);

  const list = $('folderList');
  list.replaceChildren();

  if (!folders?.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '이 위치에는 하위 폴더가 없습니다.';
    list.append(empty);
    return;
  }

  for (const folder of folders) {
    const button = document.createElement('button');
    button.className = 'folder-item';
    button.type = 'button';

    const icon = document.createElement('span');
    icon.className = 'folder-icon';
    icon.textContent = '📁';

    const name = document.createElement('span');
    name.textContent = folder.name;

    button.append(icon, name);
    button.addEventListener('click', () => browseFolder(folder.path));
    list.append(button);
  }
}

async function browseFolder(path = '') {
  const token = await getToken();
  const repository = $('repository').value;
  if (!token || !repository) return;

  const response = await chrome.runtime.sendMessage({
    type: 'LIST_FOLDERS',
    payload: {
      token,
      repository,
      branch: $('branch').value,
      path
    }
  });

  if (!response?.ok) {
    status(response?.error || '폴더를 불러오지 못했습니다.', true);
    if (path) {
      currentFolderPath = '';
      renderFolders('', []);
    }
    return;
  }

  renderFolders(response.path || '', response.folders || []);
  status('');
}

async function configureRepository(repository, useSavedLocation = false) {
  if (!repository) {
    populateBranches([], '', '');
    renderFolders('', []);
    renderDestination();
    return;
  }

  const token = await getToken();
  if (!token) {
    status('먼저 GitHub에 연결하세요.', true);
    return;
  }

  status(`${repository} 확인 중...`);

  const verify = await chrome.runtime.sendMessage({
    type: 'VERIFY_REPOSITORY',
    payload: { token, repository }
  });

  if (verify?.ok) {
    setConnectionBadge('쓰기 가능', 'ok');
  } else {
    setConnectionBadge('쓰기 권한 없음', 'error');
    status(verify?.error || '이 저장소에 쓸 수 없습니다.', true);
  }

  const branchResponse = await chrome.runtime.sendMessage({
    type: 'LIST_BRANCHES',
    payload: { token, repository }
  });

  if (!branchResponse?.ok) {
    status(branchResponse?.error || '브랜치를 불러오지 못했습니다.', true);
    return;
  }

  const sameAsSaved = repository === savedSettings.repository;
  const preferredBranch = useSavedLocation && sameAsSaved
    ? savedSettings.branch
    : branchResponse.defaultBranch;

  populateBranches(
    branchResponse.branches,
    preferredBranch,
    branchResponse.defaultBranch
  );

  let desiredPath = '';
  if (useSavedLocation && sameAsSaved) {
    desiredPath = savedSettings.rootFolder || '';
    $('rootFolder').value = savedSettings.rootFolder ?? '';
  } else {
    $('rootFolder').value = '';
  }

  await browseFolder(desiredPath);
  if (desiredPath && currentFolderPath !== desiredPath) {
    await browseFolder('');
  }

  renderDestination();
  if (verify?.ok) status(`쓰기 가능: ${repository}`);
}

async function loadRepositories({ preserveSelection = true } = {}) {
  const token = await getToken();
  if (!token) {
    status('GitHub Fine-grained PAT를 입력하세요.', true);
    setConnectionBadge('연결 안 됨', 'muted');
    return;
  }

  status('GitHub에서 저장소 불러오는 중...');
  const response = await chrome.runtime.sendMessage({
    type: 'LIST_REPOSITORIES',
    payload: { token }
  });

  if (!response?.ok) {
    status(response?.error || '저장소를 불러오지 못했습니다.', true);
    setConnectionBadge('연결 실패', 'error');
    return;
  }

  if ($('token').value.trim()) {
    await chrome.storage.local.set({ token: $('token').value.trim() });
    $('token').value = '';
    $('token').placeholder = 'GitHub 연결됨 — 토큰 변경 시 새 토큰 입력';
  }

  setConnectionBadge('GitHub 연결됨', 'ok');

  const existingSelection = preserveSelection
    ? ($('repository').value || savedSettings.repository)
    : '';

  populateRepositories(response.repositories, existingSelection);
  status(`${response.repositories.length}개 저장소를 불러왔습니다.`);

  if (existingSelection) {
    await configureRepository(existingSelection, existingSelection === savedSettings.repository);
  }
}

async function currentSettings() {
  return {
    token: await getToken(),
    repository: $('repository').value,
    rootFolder: $('rootFolder').value.trim(),
    branch: $('branch').value
  };
}

async function load() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  if (response?.ok) {
    savedSettings = { ...savedSettings, ...(response.settings || {}) };
    $('rootFolder').value = savedSettings.rootFolder ?? 'JUNGOL';

    if (savedSettings.hasToken) {
      $('token').placeholder = 'GitHub 연결됨 — 토큰 변경 시 새 토큰 입력';
      setConnectionBadge('GitHub 연결됨', 'ok');
      await loadRepositories({ preserveSelection: true });
    }
  }

  renderDestination();
  await renderLogs();
}

$('connect').addEventListener('click', () => loadRepositories({ preserveSelection: true }));

$('disconnect').addEventListener('click', async () => {
  await chrome.storage.local.remove('token');
  $('token').value = '';
  $('token').placeholder = 'github_pat_...';
  populateRepositories([], '');
  populateBranches([], '', '');
  renderFolders('', []);
  setConnectionBadge('연결 안 됨', 'muted');
  status('GitHub 연결을 해제했습니다.');
});

$('refreshRepos').addEventListener('click', () => loadRepositories({ preserveSelection: true }));

$('repository').addEventListener('change', async () => {
  currentFolderPath = '';
  await configureRepository($('repository').value, false);
});

$('branch').addEventListener('change', async () => {
  $('rootFolder').value = '';
  currentFolderPath = '';
  await browseFolder('');
  renderDestination();
});

$('folderUp').addEventListener('click', () => {
  const parent = currentFolderPath.split('/').filter(Boolean).slice(0, -1).join('/');
  browseFolder(parent);
});

$('useCurrentFolder').addEventListener('click', () => {
  $('rootFolder').value = currentFolderPath;
  renderDestination();
  status(currentFolderPath ? `저장 폴더: /${currentFolderPath}` : '저장소 루트를 사용합니다.');
});

$('rootFolder').addEventListener('input', renderDestination);

$('save').addEventListener('click', async () => {
  const payload = await currentSettings();
  if (!payload.repository) {
    status('저장소를 먼저 선택하세요.', true);
    return;
  }

  status('쓰기 권한 확인 중...');
  const test = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', payload });
  if (!test?.ok) {
    status(test?.error || 'GitHub 쓰기 권한 확인 실패', true);
    setConnectionBadge('쓰기 권한 없음', 'error');
    return;
  }

  const response = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', payload });
  if (!response?.ok) {
    status(response?.error || '저장 실패', true);
    return;
  }

  savedSettings = {
    ...savedSettings,
    repository: payload.repository,
    rootFolder: payload.rootFolder,
    branch: payload.branch,
    hasToken: true
  };
  $('token').value = '';
  $('token').placeholder = 'GitHub 연결됨 — 토큰 변경 시 새 토큰 입력';
  setConnectionBadge('저장 위치 설정됨', 'ok');
  status('완료. 앞으로 정답은 이 위치에 자동 저장됩니다.');
  renderDestination();
});

$('test').addEventListener('click', async () => {
  const payload = await currentSettings();
  status('실제 GitHub 쓰기 권한 확인 중...');
  const response = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', payload });
  if (response?.ok) {
    setConnectionBadge('쓰기 가능', 'ok');
    status(`쓰기 가능: ${response.fullName} (${response.defaultBranch})`);
  } else {
    setConnectionBadge('쓰기 권한 없음', 'error');
    status(response?.error || '연결 실패', true);
  }
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
