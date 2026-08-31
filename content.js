(() => {
  'use strict';

  const SOURCE = 'JUNGOLHUB_CONTENT';
  const PENDING_KEY = 'jungolhubPendingSubmission';
  const PENDING_TTL = 5 * 60 * 1000;
  const ACCEPTED_RE = /(?:^|\b)(?:accepted|correct|ac)(?:\b|$)|맞았습니다(?:!|！)*|(?:^|\s)정답(?:입니다)?(?:!|！)*(?:\s|$)|통과(?:했습니다)?(?:!|！)*/i;
  const REJECTED_RE = /wrong answer|틀렸|오답|compile error|컴파일|runtime error|런타임|time limit|시간 초과|memory limit|메모리 초과|output limit|출력 초과/i;
  const SUBMIT_RE = /제출|채점|submit|judge|grade/i;

  let latestSubmission = null;
  let lastAcceptedAt = 0;
  let scanTimer = null;
  let uploadInFlight = false;

  const log = (...args) => console.debug('[JungolHub]', ...args);
  const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim();

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

    const candidates = [
      document.querySelector('main h1'),
      document.querySelector('h1'),
      document.querySelector('[class*="problem"] [class*="title"]'),
      document.querySelector('[class*="title"]')
    ];
    for (const el of candidates) {
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
    const time = timeMatch ? `${timeMatch[1]}${timeMatch[2] || ''}` : null;
    const memory = memoryMatch ? `${memoryMatch[1]}${memoryMatch[2].toUpperCase()}` : null;

    return {
      id,
      title: getProblemTitle() || `Problem ${id || ''}`,
      url: id ? `${location.origin}/problem/${id}` : location.origin + location.pathname,
      time,
      memory,
      problem: collectSection(['문제', 'problem']),
      input: collectSection(['입력', 'input']),
      output: collectSection(['출력', 'output'])
    };
  }

  function codeFromDom() {
    const direct = [
      ...document.querySelectorAll('textarea, input[type="hidden"][name*="code" i], input[type="hidden"][name*="source" i]')
    ]
      .map((el) => el.value || '')
      .filter((value) => value.trim().length > 3)
      .sort((a, b) => b.length - a.length);
    if (direct[0]) return direct[0];

    const cm = document.querySelector('.CodeMirror');
    try {
      const value = cm?.CodeMirror?.getValue?.();
      if (value?.trim()) return value;
    } catch {}

    const monaco = document.querySelector('.monaco-editor .view-lines');
    if (monaco?.innerText?.trim()) return monaco.innerText;

    const codeMirror = document.querySelector('.CodeMirror-code');
    if (codeMirror?.innerText?.trim()) return codeMirror.innerText;

    const ace = document.querySelector('.ace_editor .ace_text-layer');
    if (ace?.innerText?.trim()) return ace.innerText;

    const pre = [...document.querySelectorAll('pre, code')]
      .map((el) => el.innerText || el.textContent || '')
      .filter((text) => text.includes('\n') && text.trim().length > 20)
      .sort((a, b) => b.length - a.length);
    return pre[0] || '';
  }

  function languageFromDom() {
    const selected = [...document.querySelectorAll('select')]
      .map((select) => select.options?.[select.selectedIndex]?.text || select.value || '')
      .find((text) => /c\+\+|python|java|javascript|typescript|rust|go|kotlin|c#|swift|ruby|php|pascal|c\b/i.test(text));
    if (selected) return selected;

    const checked = [...document.querySelectorAll('input:checked')]
      .map((el) => `${el.value || ''} ${el.getAttribute('aria-label') || ''}`)
      .find((text) => /c\+\+|python|java|javascript|rust|go|kotlin|c#|c\b/i.test(text));
    return checked || null;
  }

  function hasAcceptedStatusInDom() {
    const selectors = [
      '[role="status"]', '[class*="status" i]', '[class*="result" i]', '[class*="judge" i]',
      'td', 'span', 'div', 'strong', 'b', 'p', 'button'
    ];
    const nodes = document.querySelectorAll(selectors.join(','));
    for (const el of nodes) {
      const text = normalize(el.textContent);
      if (!text || text.length > 80) continue;
      if (ACCEPTED_RE.test(text) && !REJECTED_RE.test(text)) return true;
    }
    return false;
  }

  async function digest(text) {
    const bytes = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function showToast(message, type = 'ok') {
    const old = document.getElementById('jungolhub-toast');
    if (old) old.remove();
    const toast = document.createElement('div');
    toast.id = 'jungolhub-toast';
    toast.textContent = message;
    Object.assign(toast.style, {
      position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483647',
      padding: '12px 16px', borderRadius: '10px', color: '#fff', fontSize: '14px',
      fontFamily: 'system-ui, sans-serif', boxShadow: '0 8px 24px rgba(0,0,0,.2)',
      background: type === 'error' ? '#b42318' : '#16794b'
    });
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  }

  async function persistPending(submission) {
    latestSubmission = { ...submission, capturedAt: Date.now() };
    await chrome.storage.local.set({ [PENDING_KEY]: latestSubmission });
    log('Pending submission saved', {
      problemId: latestSubmission.problemId,
      language: latestSubmission.language,
      codeLength: latestSubmission.code?.length || 0
    });
  }

  async function restorePending() {
    try {
      const stored = await chrome.storage.local.get({ [PENDING_KEY]: null });
      const pending = stored[PENDING_KEY];
      if (!pending?.capturedAt || Date.now() - pending.capturedAt > PENDING_TTL) {
        if (pending) await chrome.storage.local.remove(PENDING_KEY);
        return;
      }
      latestSubmission = pending;
      log('Pending submission restored', {
        problemId: pending.problemId,
        codeLength: pending.code?.length || 0
      });
      scheduleScan();
    } catch (error) {
      log('Failed to restore pending submission', error);
    }
  }

  async function captureFromDom(reason = 'dom-submit') {
    const currentProblemId = problemIdFromLocation();
    const code = codeFromDom();
    if (!code?.trim()) {
      log('Submit action detected but code was not found', reason);
      return false;
    }
    const problem = currentProblemId ? getProblemMeta(currentProblemId) : latestSubmission?.problem || null;
    await persistPending({
      code,
      language: languageFromDom() || latestSubmission?.language || null,
      problemId: currentProblemId || latestSubmission?.problemId || problem?.id || null,
      problem,
      reason
    });
    return true;
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
        time: null,
        memory: null,
        problem: '', input: '', output: ''
      };
    }
    return null;
  }

  async function tryUpload(reason) {
    if (uploadInFlight) return;
    const problem = effectiveProblem();
    if (!problem?.id) {
      log('Accepted detected, but problem id is missing.', reason);
      return;
    }

    const code = latestSubmission?.code || codeFromDom();
    const language = latestSubmission?.language || languageFromDom();
    if (!code?.trim()) {
      log('Accepted detected, but source code was not captured yet.', reason);
      return;
    }

    const key = `${problem.id}:${await digest(code)}`;
    uploadInFlight = true;
    try {
      const response = await chrome.runtime.sendMessage({
        source: SOURCE,
        type: 'UPLOAD_SOLUTION',
        payload: { problem, code, language, key, reason }
      });

      if (response?.ok) {
        await chrome.storage.local.remove(PENDING_KEY);
        latestSubmission = null;
        showToast(response.skipped ? 'JungolHub: 이미 업로드된 풀이입니다.' : 'JungolHub: GitHub 업로드 완료');
      } else {
        showToast(`JungolHub 업로드 실패: ${response?.error || '설정을 확인하세요.'}`, 'error');
      }
    } catch (error) {
      showToast(`JungolHub 오류: ${error?.message || String(error)}`, 'error');
    } finally {
      uploadInFlight = false;
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      const fresh = latestSubmission?.capturedAt && Date.now() - latestSubmission.capturedAt < PENDING_TTL;
      if (fresh && hasAcceptedStatusInDom() && Date.now() - lastAcceptedAt > 1200) {
        lastAcceptedAt = Date.now();
        tryUpload('dom-status');
      }
    }, 200);
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== 'JUNGOLHUB_PAGE') return;

    if (message.type === 'SUBMISSION_REQUEST') {
      const currentProblemId = problemIdFromLocation();
      const problemId = message.payload?.problemId || currentProblemId || latestSubmission?.problemId || null;
      const problem = currentProblemId ? getProblemMeta(currentProblemId) : latestSubmission?.problem || null;
      await persistPending({
        code: message.payload?.code || latestSubmission?.code || codeFromDom(),
        language: message.payload?.language || latestSubmission?.language || languageFromDom(),
        problemId,
        problem,
        reason: 'network-request'
      });
    }

    if (message.type === 'ACCEPTED_RESPONSE') {
      lastAcceptedAt = Date.now();
      tryUpload('network-response');
    }
  });

  document.addEventListener('submit', () => {
    captureFromDom('form-submit');
  }, true);

  document.addEventListener('click', (event) => {
    const target = event.target?.closest?.('button,input[type="submit"],a,[role="button"]');
    if (!target) return;
    const text = normalize(target.innerText || target.value || target.getAttribute('aria-label') || target.title);
    if (SUBMIT_RE.test(text)) captureFromDom('submit-click');
  }, true);

  const startObserver = () => {
    if (!document.documentElement) return setTimeout(startObserver, 50);
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true, subtree: true, characterData: true
    });
    restorePending().finally(scheduleScan);
  };

  startObserver();
})();
