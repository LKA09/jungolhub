(() => {
  'use strict';

  const PENDING_KEY = 'jungolhubPendingSubmission';
  const DEBUG_KEY = 'jungolhubDebugLogs';
  const PENDING_TTL = 5 * 60 * 1000;
  const ACCEPTED_RE = /(?:^|\b)(?:accepted|correct|ac)(?:\b|$)|맞았습니다(?:!|！)*|(?:^|\s)정답(?:입니다)?(?:!|！)*(?:\s|$)|통과(?:했습니다)?(?:!|！)*/i;
  const REJECTED_RE = /wrong answer|틀렸|오답|compile error|컴파일|runtime error|런타임|time limit|시간 초과|memory limit|메모리 초과|output limit|출력 초과/i;
  const SUBMIT_RE = /제출|채점|submit|judge|grade|run/i;

  let latestSubmission = null;
  let scanTimer = null;
  let uploadInFlight = false;
  let lastAcceptedAt = 0;
  let lastDraftCode = '';

  const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim();

  async function debug(stage, data = {}) {
    const entry = { at: new Date().toISOString(), stage, url: location.href, data };
    console.info('[JungolHub]', stage, data);
    try {
      const stored = await chrome.storage.local.get({ [DEBUG_KEY]: [] });
      const logs = [...stored[DEBUG_KEY], entry].slice(-80);
      await chrome.storage.local.set({ [DEBUG_KEY]: logs });
    } catch {}
  }

  function problemIdFromLocation() {
    return location.pathname.match(/\/problem\/(\d+)/)?.[1] || null;
  }

  function sanitizeTitle(title) {
    return normalize(title)
      .replace(/\s*-\s*JUNGOL\s*$/i, '')
      .replace(/^#?\d+\s*[:.\-]?\s*/, '')
      .trim();
  }

  function getProblemTitle() {
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
    if (ogTitle) return sanitizeTitle(ogTitle);
    for (const el of [document.querySelector('main h1'), document.querySelector('h1'), document.querySelector('[class*="title" i]')]) {
      const text = sanitizeTitle(el?.textContent);
      if (text && !/^문제$/i.test(text)) return text;
    }
    return sanitizeTitle(document.title) || `Problem ${problemIdFromLocation() || ''}`;
  }

  function headingText(el) {
    return normalize(el?.textContent).toLowerCase().replace(/[:：]$/, '');
  }

  function collectSection(names) {
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,strong')];
    const heading = headings.find((el) => names.some((name) => headingText(el) === name.toLowerCase()));
    if (!heading) return '';
    const chunks = [];
    let node = heading.nextElementSibling;
    while (node && !/^H[1-5]$/.test(node.tagName)) {
      const text = normalize(node.innerText || node.textContent);
      if (text) chunks.push(text);
      node = node.nextElementSibling;
    }
    return chunks.join('\n\n').trim();
  }

  function getProblemMeta(forcedId = null) {
    const id = forcedId || problemIdFromLocation();
    const bodyText = normalize(document.body?.innerText);
    const timeMatch = bodyText.match(/(?:시간\s*제한|time\s*limit|시간|time)\s*[:：]?\s*([0-9.]+)\s*(ms|s|sec|초)/i);
    const memoryMatch = bodyText.match(/(?:메모리\s*제한|memory\s*limit|메모리|memory)\s*[:：]?\s*([0-9.]+)\s*(kb|mb|gb)/i);
    return {
      id,
      title: getProblemTitle() || `Problem ${id || ''}`,
      url: id ? `${location.origin}/problem/${id}` : location.origin + location.pathname,
      time: timeMatch ? `${timeMatch[1]}${timeMatch[2] || ''}` : null,
      memory: memoryMatch ? `${memoryMatch[1]}${memoryMatch[2].toUpperCase()}` : null,
      problem: collectSection(['문제', 'problem']),
      input: collectSection(['입력', 'input']),
      output: collectSection(['출력', 'output'])
    };
  }

  function codeFromDom() {
    const values = [...document.querySelectorAll('textarea,input[type="hidden"][name*="code" i],input[type="hidden"][name*="source" i],input[type="hidden"][name*="answer" i]')]
      .map((el) => el.value || '')
      .filter((value) => value.trim().length > 3)
      .sort((a, b) => b.length - a.length);
    if (values[0]) return values[0];

    try {
      const cm = document.querySelector('.CodeMirror');
      const value = cm?.CodeMirror?.getValue?.();
      if (value?.trim()) return value;
    } catch {}

    for (const selector of ['.monaco-editor .view-lines', '.CodeMirror-code', '.ace_editor .ace_text-layer']) {
      const el = document.querySelector(selector);
      if (el?.innerText?.trim()) return el.innerText;
    }
    return '';
  }

  function languageFromDom() {
    const selected = [...document.querySelectorAll('select')]
      .map((select) => select.options?.[select.selectedIndex]?.text || select.value || '')
      .find((text) => /c\+\+|python|java|javascript|typescript|rust|go|kotlin|c#|swift|ruby|php|pascal|c\b/i.test(text));
    if (selected) return selected;
    const controls = [...document.querySelectorAll('input:checked,[role="combobox"],button')]
      .map((el) => `${el.value || ''} ${el.innerText || ''} ${el.getAttribute('aria-label') || ''}`)
      .find((text) => /c\+\+|python|java|javascript|rust|go|kotlin|c#|c\b/i.test(text));
    return controls || null;
  }

  function hasAcceptedStatusInDom() {
    const nodes = document.querySelectorAll('[role="status"],[class*="status" i],[class*="result" i],[class*="judge" i],td,span,div,strong,b,p,button');
    for (const el of nodes) {
      const text = normalize(el.textContent);
      if (!text || text.length > 100) continue;
      if (ACCEPTED_RE.test(text) && !REJECTED_RE.test(text)) return text;
    }
    return '';
  }

  async function digest(text) {
    const bytes = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function showToast(message, type = 'ok') {
    document.getElementById('jungolhub-toast')?.remove();
    const toast = document.createElement('div');
    toast.id = 'jungolhub-toast';
    toast.textContent = message;
    Object.assign(toast.style, {
      position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483647', padding: '12px 16px',
      borderRadius: '10px', color: '#fff', fontSize: '14px', fontFamily: 'system-ui,sans-serif',
      boxShadow: '0 8px 24px rgba(0,0,0,.2)', background: type === 'error' ? '#b42318' : '#16794b'
    });
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), 6000);
  }

  async function savePending(patch, stage) {
    const now = Date.now();
    latestSubmission = { ...(latestSubmission || {}), ...patch };
    if (!latestSubmission.draftAt) latestSubmission.draftAt = now;
    await chrome.storage.local.set({ [PENDING_KEY]: latestSubmission });
    await debug(stage, {
      problemId: latestSubmission.problemId,
      language: latestSubmission.language,
      codeLength: latestSubmission.code?.length || 0,
      submittedAt: latestSubmission.submittedAt || null
    });
  }

  async function captureDraft(stage = 'draft-captured', markSubmitted = false) {
    const code = codeFromDom();
    const id = problemIdFromLocation();
    if (!code?.trim()) {
      await debug(`${stage}:no-code`, { problemId: id });
      return false;
    }
    const problem = id ? getProblemMeta(id) : latestSubmission?.problem || null;
    const patch = {
      code,
      language: languageFromDom() || latestSubmission?.language || null,
      problemId: id || latestSubmission?.problemId || problem?.id || null,
      problem,
      draftAt: Date.now()
    };
    if (markSubmitted) patch.submittedAt = Date.now();
    lastDraftCode = code;
    await savePending(patch, stage);
    return true;
  }

  async function markSubmitted(stage) {
    const captured = await captureDraft(stage, true);
    if (!captured && latestSubmission?.code) {
      await savePending({ submittedAt: Date.now() }, `${stage}:using-stored-draft`);
    }
    scheduleScan();
  }

  async function restorePending() {
    const stored = await chrome.storage.local.get({ [PENDING_KEY]: null });
    const pending = stored[PENDING_KEY];
    const ageFromSubmit = pending?.submittedAt ? Date.now() - pending.submittedAt : Infinity;
    const ageFromDraft = pending?.draftAt ? Date.now() - pending.draftAt : Infinity;
    if (Math.min(ageFromSubmit, ageFromDraft) > PENDING_TTL) {
      if (pending) await chrome.storage.local.remove(PENDING_KEY);
      await debug('pending-expired');
      return;
    }
    if (pending) {
      latestSubmission = pending;
      lastDraftCode = pending.code || '';
      await debug('pending-restored', { problemId: pending.problemId, codeLength: pending.code?.length || 0, submittedAt: pending.submittedAt || null });
    }
  }

  function effectiveProblem() {
    const currentId = problemIdFromLocation();
    if (currentId) return getProblemMeta(currentId);
    if (latestSubmission?.problem?.id) return latestSubmission.problem;
    if (latestSubmission?.problemId) {
      return { id: String(latestSubmission.problemId), title: `Problem ${latestSubmission.problemId}`, url: `${location.origin}/problem/${latestSubmission.problemId}`, time: null, memory: null, problem: '', input: '', output: '' };
    }
    return null;
  }

  async function tryUpload(reason) {
    if (uploadInFlight) return;
    const problem = effectiveProblem();
    const code = latestSubmission?.code || codeFromDom();
    const language = latestSubmission?.language || languageFromDom();
    if (!problem?.id || !code?.trim()) {
      await debug('upload-blocked', { reason, problemId: problem?.id || null, codeLength: code?.length || 0 });
      return;
    }

    uploadInFlight = true;
    await debug('upload-start', { reason, problemId: problem.id, language, codeLength: code.length });
    try {
      const key = `${problem.id}:${await digest(code)}`;
      const response = await chrome.runtime.sendMessage({ type: 'UPLOAD_SOLUTION', payload: { problem, code, language, key, reason } });
      await debug('upload-response', response || { noResponse: true });
      if (response?.ok) {
        await chrome.storage.local.remove(PENDING_KEY);
        latestSubmission = null;
        showToast(response.skipped ? 'JungolHub: 이미 업로드된 풀이입니다.' : 'JungolHub: GitHub 업로드 완료');
      } else {
        showToast(`JungolHub 업로드 실패: ${response?.error || '설정을 확인하세요.'}`, 'error');
      }
    } catch (error) {
      await debug('upload-exception', { message: error?.message || String(error) });
      showToast(`JungolHub 오류: ${error?.message || String(error)}`, 'error');
    } finally {
      uploadInFlight = false;
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(async () => {
      const submittedAt = latestSubmission?.submittedAt || 0;
      if (!submittedAt || Date.now() - submittedAt > PENDING_TTL) return;
      const acceptedText = hasAcceptedStatusInDom();
      if (acceptedText && Date.now() - lastAcceptedAt > 1200) {
        lastAcceptedAt = Date.now();
        await debug('accepted-dom', { text: acceptedText });
        tryUpload('dom-status');
      }
    }, 150);
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== 'JUNGOLHUB_PAGE') return;

    if (message.type === 'HOOK_READY') {
      await debug('hook-ready');
      return;
    }
    if (message.type === 'DEBUG') {
      await debug(`page-hook:${message.payload?.stage || 'debug'}`, message.payload || {});
      return;
    }
    if (message.type === 'SUBMISSION_SIGNAL') {
      await debug('network-submit-signal', { url: message.payload?.url, method: message.payload?.method });
      await markSubmitted('network-submit-signal');
      return;
    }
    if (message.type === 'SUBMISSION_REQUEST') {
      const id = message.payload?.problemId || problemIdFromLocation() || latestSubmission?.problemId || null;
      const code = message.payload?.code || codeFromDom() || latestSubmission?.code || '';
      await savePending({
        code,
        language: message.payload?.language || languageFromDom() || latestSubmission?.language || null,
        problemId: id,
        problem: id ? getProblemMeta(id) : latestSubmission?.problem || null,
        draftAt: Date.now(),
        submittedAt: Date.now()
      }, 'network-submission-captured');
      scheduleScan();
      return;
    }
    if (message.type === 'ACCEPTED_RESPONSE') {
      await debug('accepted-network', { url: message.payload?.url });
      lastAcceptedAt = Date.now();
      tryUpload('network-response');
    }
  });

  document.addEventListener('submit', () => markSubmitted('form-submit'), true);
  document.addEventListener('pointerdown', (event) => {
    const target = event.target?.closest?.('button,input[type="submit"],a,[role="button"]');
    if (!target) return;
    const text = normalize(target.innerText || target.value || target.getAttribute('aria-label') || target.title);
    if (SUBMIT_RE.test(text)) markSubmitted('submit-pointerdown');
  }, true);
  document.addEventListener('click', (event) => {
    const target = event.target?.closest?.('button,input[type="submit"],a,[role="button"]');
    if (!target) return;
    const text = normalize(target.innerText || target.value || target.getAttribute('aria-label') || target.title);
    if (SUBMIT_RE.test(text)) markSubmitted('submit-click');
  }, true);

  window.addEventListener('beforeunload', () => {
    if (codeFromDom()?.trim()) captureDraft('beforeunload-draft', false);
  });

  const startObserver = async () => {
    if (!document.documentElement) return setTimeout(startObserver, 50);
    new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    await restorePending();
    await debug('content-ready', { problemId: problemIdFromLocation() });
    scheduleScan();

    setInterval(() => {
      const id = problemIdFromLocation();
      if (!id) return;
      const code = codeFromDom();
      if (code?.trim() && code !== lastDraftCode) captureDraft('draft-autosave', false);
    }, 1200);
  };

  startObserver();
})();
