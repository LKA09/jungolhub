(() => {
  'use strict';

  if (window.__JUNGOLHUB_CONTENT__) return;
  window.__JUNGOLHUB_CONTENT__ = true;

  const PENDING_KEY = 'jungolhubPendingSubmission';
  const DEBUG_KEY = 'jungolhubDebugLogs';
  const PENDING_TTL = 5 * 60 * 1000;
  const SUBMIT_RE = /제출|채점|submit|judge|grade/i;
  const ACCEPTED_EXACT_RE = /^(?:accepted|correct|ac|정답|맞았습니다(?:!|！)*|통과(?:했습니다)?(?:!|！)*)$/i;

  let latestSubmission = null;
  let scanTimer = null;
  let uploadInFlight = false;
  let lastDraftCode = '';
  let attemptedSubmissionAt = 0;

  const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim();

  async function debug(stage, data = {}) {
    const entry = { at: new Date().toISOString(), stage, url: location.href, data };
    console.info('[JungolHub]', stage, data);
    try {
      const stored = await chrome.storage.local.get({ [DEBUG_KEY]: [] });
      const logs = [...(stored[DEBUG_KEY] || []), entry].slice(-100);
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
    for (const el of [
      document.querySelector('main h1'),
      document.querySelector('h1'),
      document.querySelector('[class*="problem" i] [class*="title" i]')
    ]) {
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
    const values = [...document.querySelectorAll('textarea,input[type="hidden"][name*="code" i],input[type="hidden"][name*="source" i]')]
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

  function canonicalLanguage(value) {
    const text = normalize(value);
    if (!text) return null;
    if (/c\+\+|cpp|gnu\+\+/i.test(text)) return 'C++';
    if (/python|pypy/i.test(text)) return 'Python';
    if (/java(?!script)/i.test(text)) return 'JAVA';
    if (/javascript|node\.?(?:js)?/i.test(text)) return 'JavaScript';
    if (/typescript/i.test(text)) return 'TypeScript';
    if (/kotlin/i.test(text)) return 'Kotlin';
    if (/rust/i.test(text)) return 'Rust';
    if (/c#|csharp/i.test(text)) return 'C#';
    if (/swift/i.test(text)) return 'Swift';
    if (/ruby/i.test(text)) return 'Ruby';
    if (/php/i.test(text)) return 'PHP';
    if (/pascal/i.test(text)) return 'Pascal';
    if (/^(?:gnu\s*)?c(?:\s*\d+(?:\.\d+)*)?$/i.test(text)) return 'C';
    if (/^(?:go|golang)(?:\s*\d+(?:\.\d+)*)?$/i.test(text)) return 'Go';
    return null;
  }

  function languageFromDom() {
    for (const select of document.querySelectorAll('select')) {
      const value = select.options?.[select.selectedIndex]?.text || select.value || '';
      const language = canonicalLanguage(value);
      if (language) return language;
    }
    for (const el of document.querySelectorAll('[role="combobox"],input:checked')) {
      const value = `${el.value || ''} ${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`;
      const language = canonicalLanguage(value);
      if (language) return language;
    }
    return null;
  }

  function acceptedStatusFromDom() {
    const nodes = document.querySelectorAll('[role="status"],[class*="status" i],[class*="result" i],[class*="judge" i],td,span,strong,b');
    for (const el of nodes) {
      const text = normalize(el.textContent);
      if (text && text.length <= 40 && ACCEPTED_EXACT_RE.test(text)) return text;
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
    setTimeout(() => toast.remove(), 7000);
  }

  async function savePending(patch, stage, priority = 1) {
    const previous = latestSubmission || {};
    const next = { ...previous, ...patch };

    if (patch.code) {
      const previousPriority = previous.codePriority || 0;
      if (priority < previousPriority && previous.code) next.code = previous.code;
      else next.codePriority = priority;
    }

    if (patch.language) {
      const previousPriority = previous.languagePriority || 0;
      if (priority < previousPriority && previous.language) next.language = previous.language;
      else next.languagePriority = priority;
    }

    latestSubmission = next;
    await chrome.storage.local.set({ [PENDING_KEY]: latestSubmission });
    await debug(stage, {
      problemId: latestSubmission.problemId,
      language: latestSubmission.language,
      codeLength: latestSubmission.code?.length || 0,
      codePriority: latestSubmission.codePriority || 0,
      submittedAt: latestSubmission.submittedAt || null
    });
  }

  async function captureDraft(stage = 'draft-captured', markSubmitted = false) {
    const code = codeFromDom();
    const id = problemIdFromLocation();
    const patch = {
      problemId: id || latestSubmission?.problemId || null,
      problem: id ? getProblemMeta(id) : latestSubmission?.problem || null,
      draftAt: Date.now()
    };
    if (code?.trim()) {
      patch.code = code;
      patch.language = languageFromDom() || null;
      lastDraftCode = code;
    }
    if (markSubmitted) patch.submittedAt = Date.now();
    await savePending(patch, stage, 1);
    return Boolean(code?.trim() || latestSubmission?.code);
  }

  async function markSubmitted(stage) {
    attemptedSubmissionAt = 0;
    await captureDraft(stage, true);
    scheduleScan();
  }

  async function restorePending() {
    const stored = await chrome.storage.local.get({ [PENDING_KEY]: null });
    const pending = stored[PENDING_KEY];
    const latestAt = Math.max(pending?.submittedAt || 0, pending?.draftAt || 0);
    if (!pending || !latestAt || Date.now() - latestAt > PENDING_TTL) {
      if (pending) await chrome.storage.local.remove(PENDING_KEY);
      return;
    }
    latestSubmission = pending;
    lastDraftCode = pending.code || '';
    await debug('pending-restored', {
      problemId: pending.problemId,
      language: pending.language,
      codeLength: pending.code?.length || 0,
      codePriority: pending.codePriority || 0,
      submittedAt: pending.submittedAt || null
    });
  }

  function effectiveProblem() {
    const currentId = problemIdFromLocation();
    if (currentId) return getProblemMeta(currentId);
    if (latestSubmission?.problem?.id) return latestSubmission.problem;
    if (latestSubmission?.problemId) {
      return {
        id: String(latestSubmission.problemId),
        title: `Problem ${latestSubmission.problemId}`,
        url: `${location.origin}/problem/${latestSubmission.problemId}`,
        time: null, memory: null, problem: '', input: '', output: ''
      };
    }
    return null;
  }

  async function tryUpload(reason) {
    if (uploadInFlight) return;
    const submittedAt = latestSubmission?.submittedAt || 0;
    if (!submittedAt) return;
    if (attemptedSubmissionAt === submittedAt) {
      await debug('upload-suppressed-duplicate', { reason, submittedAt });
      return;
    }

    const problem = effectiveProblem();
    const code = latestSubmission?.code || codeFromDom();
    const language = latestSubmission?.language || languageFromDom();
    if (!problem?.id || !code?.trim()) {
      await debug('upload-blocked', { reason, problemId: problem?.id || null, codeLength: code?.length || 0 });
      return;
    }

    attemptedSubmissionAt = submittedAt;
    uploadInFlight = true;
    await debug('upload-start', { reason, problemId: problem.id, language, codeLength: code.length, submittedAt });
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
      const acceptedText = acceptedStatusFromDom();
      if (acceptedText) {
        await debug('accepted-dom', { text: acceptedText });
        tryUpload('dom-status');
      }
    }, 180);
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
      const networkLanguage = canonicalLanguage(message.payload?.language) || message.payload?.language || null;
      attemptedSubmissionAt = 0;
      await savePending({
        code: message.payload?.code || latestSubmission?.code || '',
        language: networkLanguage || latestSubmission?.language || null,
        problemId: id,
        problem: id ? getProblemMeta(id) : latestSubmission?.problem || null,
        draftAt: Date.now(),
        submittedAt: Date.now()
      }, 'network-submission-captured', 3);
      scheduleScan();
      return;
    }
    if (message.type === 'ACCEPTED_RESPONSE') {
      await debug('accepted-network', { url: message.payload?.url });
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

  const start = async () => {
    if (!document.documentElement) return setTimeout(start, 50);
    new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    await restorePending();
    await debug('content-ready', { problemId: problemIdFromLocation() });
    scheduleScan();

    setInterval(() => {
      const id = problemIdFromLocation();
      if (!id) return;
      const code = codeFromDom();
      if (!code?.trim() || code === lastDraftCode) return;
      if ((latestSubmission?.codePriority || 0) >= 3 && latestSubmission?.submittedAt) return;
      captureDraft('draft-autosave', false);
    }, 1200);
  };

  start();
})();
