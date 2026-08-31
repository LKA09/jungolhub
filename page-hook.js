(() => {
  'use strict';
  if (window.__JUNGOLHUB_HOOKED__) return;
  window.__JUNGOLHUB_HOOKED__ = true;

  const REQUEST_HINT = /submit|submission|judge|solution|answer|code|grade|run|record/i;
  const ACCEPTED_TEXT = /(?:^|\b)(?:accepted|correct|ac)(?:\b|$)|맞았습니다(?:!|！)*|(?:^|\s)정답(?:입니다)?(?:!|！)*(?:\s|$)|통과(?:했습니다)?(?:!|！)*/i;
  const WRONG_TEXT = /wrong answer|틀렸|오답|compile error|컴파일|runtime error|런타임|time limit|시간 초과|memory limit|메모리 초과|output limit|출력 초과/i;
  let lastSubmissionAt = 0;

  const post = (type, payload = {}) => window.postMessage({ source: 'JUNGOLHUB_PAGE', type, payload }, '*');
  const safeJson = (text) => { try { return JSON.parse(text); } catch { return null; } };

  const normalizeObject = (value) => {
    if (value == null) return null;
    if (typeof value === 'string') {
      const parsed = safeJson(value);
      if (parsed) return parsed;
      try {
        const params = new URLSearchParams(value);
        if ([...params.keys()].length) return Object.fromEntries(params.entries());
      } catch {}
      return { raw: value };
    }
    if (value instanceof URLSearchParams) return Object.fromEntries(value.entries());
    if (value instanceof FormData) return Object.fromEntries(value.entries());
    if (typeof value === 'object') return value;
    return { raw: String(value) };
  };

  const pickDeep = (root, keys, maxDepth = 7) => {
    const wanted = new Set(keys.map((key) => key.toLowerCase()));
    const seen = new WeakSet();
    let found;
    const walk = (node, depth) => {
      if (found !== undefined || depth > maxDepth || node == null || typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);
      for (const [key, value] of Object.entries(node)) {
        if (wanted.has(key.toLowerCase()) && typeof value !== 'object' && value != null) { found = String(value); return; }
      }
      for (const value of Object.values(node)) walk(value, depth + 1);
    };
    walk(root, 0);
    return found;
  };

  const extractSubmission = (body) => {
    const obj = normalizeObject(body);
    if (!obj) return null;
    const code = pickDeep(obj, ['code','source','sourceCode','source_code','answer','solution','content','src','sourceText','source_text']);
    const language = pickDeep(obj, ['language','lang','languageId','language_id','compiler','compilerId','compiler_id']);
    const problemId = pickDeep(obj, ['problemId','problem_id','problem','pid','problemNo','problem_no','problemIdx','problem_idx','problemIdStr']);
    if (!code || code.length < 2) return null;
    return { code, language, problemId };
  };

  const signal = (url = location.href, method = 'POST', source = 'unknown') => {
    lastSubmissionAt = Date.now();
    post('SUBMISSION_SIGNAL', { url: String(url || ''), method, source });
  };

  const inspectResult = (url, text) => {
    if (!text || !lastSubmissionAt || Date.now() - lastSubmissionAt > 5 * 60 * 1000) return;
    const parsed = safeJson(text);
    const haystack = parsed ? JSON.stringify(parsed) : String(text);
    const compact = haystack.replace(/\s+/g, ' ').trim();
    if (ACCEPTED_TEXT.test(compact) && !WRONG_TEXT.test(compact)) {
      post('ACCEPTED_RESPONSE', { url, response: compact.slice(0, 12000) });
    }
  };

  document.addEventListener('submit', (event) => {
    try {
      signal(event.target?.action || location.href, (event.target?.method || 'POST').toUpperCase(), 'dom-form');
      const submission = extractSubmission(new FormData(event.target));
      if (submission) post('SUBMISSION_REQUEST', { url: event.target?.action || location.href, method: (event.target?.method || 'POST').toUpperCase(), ...submission });
    } catch (error) {
      post('DEBUG', { stage: 'form-submit', message: String(error) });
    }
  }, true);

  const originalSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function() {
    try {
      signal(this.action || location.href, (this.method || 'POST').toUpperCase(), 'form.submit');
      const submission = extractSubmission(new FormData(this));
      if (submission) post('SUBMISSION_REQUEST', { url: this.action || location.href, method: (this.method || 'POST').toUpperCase(), ...submission });
    } catch {}
    return originalSubmit.apply(this, arguments);
  };

  const originalRequestSubmit = HTMLFormElement.prototype.requestSubmit;
  if (originalRequestSubmit) {
    HTMLFormElement.prototype.requestSubmit = function() {
      try {
        signal(this.action || location.href, (this.method || 'POST').toUpperCase(), 'form.requestSubmit');
        const submission = extractSubmission(new FormData(this));
        if (submission) post('SUBMISSION_REQUEST', { url: this.action || location.href, method: (this.method || 'POST').toUpperCase(), ...submission });
      } catch {}
      return originalRequestSubmit.apply(this, arguments);
    };
  }

  const originalFetch = window.fetch;
  window.fetch = async function(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const method = (init?.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
    try {
      if (method !== 'GET') {
        let body = init?.body;
        if (!body && typeof input !== 'string' && input instanceof Request) {
          try { body = await input.clone().text(); } catch {}
        }
        const submission = extractSubmission(body);
        if (submission || REQUEST_HINT.test(url)) {
          signal(url, method, 'fetch');
          if (submission) post('SUBMISSION_REQUEST', { url, method, ...submission });
        }
      }
    } catch (error) {
      post('DEBUG', { stage: 'fetch-request', message: String(error), url });
    }

    const response = await originalFetch.apply(this, arguments);
    try {
      if (lastSubmissionAt && Date.now() - lastSubmissionAt < 5 * 60 * 1000) {
        const type = response.headers?.get?.('content-type') || '';
        if (/json|text|javascript|html/i.test(type) || !type) inspectResult(url, await response.clone().text());
      }
    } catch (error) {
      post('DEBUG', { stage: 'fetch-response', message: String(error), url });
    }
    return response;
  };

  const XHR = window.XMLHttpRequest;
  const originalOpen = XHR.prototype.open;
  const originalSend = XHR.prototype.send;
  XHR.prototype.open = function(method, url) {
    this.__jungolhub = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
    return originalOpen.apply(this, arguments);
  };
  XHR.prototype.send = function(body) {
    try {
      const meta = this.__jungolhub || {};
      if (meta.method !== 'GET') {
        const submission = extractSubmission(body);
        if (submission || REQUEST_HINT.test(meta.url || '')) {
          signal(meta.url, meta.method, 'xhr');
          if (submission) post('SUBMISSION_REQUEST', { ...meta, ...submission });
        }
      }
      this.addEventListener('load', () => {
        try {
          if (!lastSubmissionAt || Date.now() - lastSubmissionAt > 5 * 60 * 1000) return;
          inspectResult(meta.url, typeof this.responseText === 'string' ? this.responseText : '');
        } catch {}
      });
    } catch (error) {
      post('DEBUG', { stage: 'xhr', message: String(error) });
    }
    return originalSend.apply(this, arguments);
  };

  post('HOOK_READY');
})();
