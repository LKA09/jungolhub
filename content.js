(() => {
  'use strict';

  const ACCEPTED_EXACT = new Set(['accepted', 'correct', 'ac', '정답', '맞았습니다', '통과']);
  const SOURCE = 'JUNGOLHUB_CONTENT';

  let latestSubmission = null;
  let lastAcceptedAt = 0;
  let scanTimer = null;
  let uploadInFlight = false;

  const log = (...args) => console.debug('[JungolHub]', ...args);

  function normalize(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function problemIdFromLocation() {
    return location.pathname.match(/\/problem\/(\d+)/)?.[1] || null;
  }

  function sanitizeTitle(title) {
    return normalize(title)
      .replace(/\s*-\s*JUNGOL\s*$/i, '')
      .replace(/^#?\d+\s*/, '')
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
    return normalize(el?.textContent).toLowerCase();
  }

  function collectSection(names) {
    const headings = [...document.querySelectorAll('h1,h2,h3,h4')];
    const heading = headings.find((el) => names.some((name) => headingText(el) === name.toLowerCase()));
    if (!heading) return '';

    const chunks = [];
    let node = heading.nextElementSibling;
    while (node && !/^H[1-4]$/.test(node.tagName)) {
      const text = normalize(node.innerText || node.textContent);
      if (text) chunks.push(text);
      node = node.nextElementSibling;
    }
    return chunks.join('\n\n').trim();
  }

  function getProblemMeta() {
    const bodyText = normalize(document.body?.innerText);
    const time = bodyText.match(/(?:시간|time)\s*[: ]?\s*([0-9.]+)\s*(ms|s|sec|초)/i)?.[1] || null;
    const memoryMatch = bodyText.match(/(?:메모리|memory)\s*[: ]?\s*([0-9.]+)\s*(kb|mb|gb)/i);
    const memory = memoryMatch ? `${memoryMatch[1]}${memoryMatch[2].toUpperCase()}` : null;

    return {
      id: problemIdFromLocation(),
      title: getProblemTitle(),
      url: location.origin + location.pathname,
      time,
      memory,
      problem: collectSection(['문제', 'problem']),
      input: collectSection(['입력', 'input']),
      output: collectSection(['출력', 'output'])
    };
  }

  function codeFromDom() {
    const textareaValues = [...document.querySelectorAll('textarea')]
      .map((el) => el.value || '')
      .filter((value) => value.trim().length > 3)
      .sort((a, b) => b.length - a.length);
    if (textareaValues[0]) return textareaValues[0];

    const monaco = document.querySelector('.monaco-editor .view-lines');
    if (monaco?.innerText?.trim()) return monaco.innerText;

    const codeMirror = document.querySelector('.CodeMirror-code');
    if (codeMirror?.innerText?.trim()) return codeMirror.innerText;

    return '';
  }

  function languageFromDom() {
    const selected = [...document.querySelectorAll('select')]
      .map((select) => select.options?.[select.selectedIndex]?.text || select.value || '')
      .find((text) => /c\+\+|python|java|javascript|typescript|rust|go|kotlin|c#|swift|ruby|php|c\b/i.test(text));
    return selected || null;
  }

  function hasAcceptedStatusInDom() {
    const nodes = document.querySelectorAll('span,td,button,[role="status"],[class*="status"],[class*="result"]');
    for (const el of nodes) {
      const text = normalize(el.textContent).toLowerCase();
      if (text.length <= 20 && ACCEPTED_EXACT.has(text)) return true;
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
    setTimeout(() => toast.remove(), 4500);
  }

  async function tryUpload(reason) {
    if (uploadInFlight) return;
    const problem = getProblemMeta();
    if (!problem.id) return;

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
        showToast(response.skipped ? 'JungolHub: 이미 업로드된 풀이입니다.' : 'JungolHub: GitHub 업로드 완료');
      } else {
        showToast(`JungolHub 업로드 실패: ${response?.error || '설정을 확인하세요.'}`, 'error');
      }
    } catch (error) {
      showToast(`JungolHub 오류: ${String(error)}`, 'error');
    } finally {
      uploadInFlight = false;
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      const hasFreshSubmission = latestSubmission?.capturedAt && Date.now() - latestSubmission.capturedAt < 120000;
      if (hasFreshSubmission && hasAcceptedStatusInDom() && Date.now() - lastAcceptedAt > 1500) {
        lastAcceptedAt = Date.now();
        tryUpload('dom-status');
      }
    }, 250);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== 'JUNGOLHUB_PAGE') return;

    if (message.type === 'SUBMISSION_REQUEST') {
      latestSubmission = {
        code: message.payload?.code || latestSubmission?.code,
        language: message.payload?.language || latestSubmission?.language,
        problemId: message.payload?.problemId || problemIdFromLocation(),
        capturedAt: Date.now()
      };
      log('Submission captured', { language: latestSubmission.language, problemId: latestSubmission.problemId });
    }

    if (message.type === 'ACCEPTED_RESPONSE') {
      lastAcceptedAt = Date.now();
      tryUpload('network-response');
    }
  });

  const startObserver = () => {
    if (!document.documentElement) return setTimeout(startObserver, 50);
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true, subtree: true, characterData: true
    });
    scheduleScan();
  };

  startObserver();
})();
