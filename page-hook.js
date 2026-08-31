(() => {
  'use strict';

  if (window.__JUNGOLHUB_HOOKED__) return;
  window.__JUNGOLHUB_HOOKED__ = true;

  const REQUEST_HINT = /submit|submission|judge|solution|answer|code/i;
  const RESULT_HINT = /submit|submission|judge|result|status|record|solution/i;
  const ACCEPTED_TEXT = /(^|[^a-z])(accepted|correct|ac)([^a-z]|$)|정답|맞았습니다|통과/i;
  const WRONG_TEXT = /wrong answer|틀렸|오답|compile error|컴파일|runtime error|런타임|time limit|시간 초과|memory limit|메모리 초과/i;
  let lastSubmissionAt = 0;

  const post = (type, payload = {}) => {
    window.postMessage({ source: 'JUNGOLHUB_PAGE', type, payload }, '*');
  };

  const safeJson = (text) => {
    try { return JSON.parse(text); } catch { return null; }
  };

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

  const pickDeep = (root, keys, maxDepth = 5) => {
    const wanted = new Set(keys.map((key) => key.toLowerCase()));
    const seen = new WeakSet();
    let found;

    const walk = (node, depth) => {
      if (found !== undefined || depth > maxDepth || node == null) return;
      if (typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);

      for (const [key, value] of Object.entries(node)) {
        if (wanted.has(key.toLowerCase()) && typeof value !== 'object' && value != null) {
          found = String(value);
          return;
        }
      }
      for (const value of Object.values(node)) walk(value, depth + 1);
    };

    walk(root, 0);
    return found;
  };

  const extractSubmission = (body) => {
    const obj = normalizeObject(body);
    if (!obj) return null;

    const code = pickDeep(obj, ['code', 'source', 'sourceCode', 'source_code', 'answer', 'solution', 'content']);
    const language = pickDeep(obj, ['language', 'lang', 'languageId', 'language_id', 'compiler', 'compilerId']);
    const problemId = pickDeep(obj, ['problemId', 'problem_id', 'problem', 'pid', 'problemNo', 'problem_no']);

    if (!code || code.length < 2) return null;
    return { code, language, problemId };
  };

  const looksAccepted = (text) => {
    if (!text) return false;
    const compact = String(text).replace(/\s+/g, ' ').trim();
    return ACCEPTED_TEXT.test(compact) && !WRONG_TEXT.test(compact);
  };

  const inspectResult = (url, text) => {
    if (!RESULT_HINT.test(url || '') || !text) return;
    if (!lastSubmissionAt || Date.now() - lastSubmissionAt > 120000) return;
    const parsed = safeJson(text);
    const haystack = parsed ? JSON.stringify(parsed) : text;
    if (looksAccepted(haystack)) {
      post('ACCEPTED_RESPONSE', { url, response: haystack.slice(0, 12000) });
    }
  };

  const originalFetch = window.fetch;
  window.fetch = async function(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const method = (init?.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();

    try {
      if (method !== 'GET' && REQUEST_HINT.test(url)) {
        let body = init?.body;
        if (!body && typeof input !== 'string' && input instanceof Request) {
          try { body = await input.clone().text(); } catch {}
        }
        const submission = extractSubmission(body);
        if (submission) {
          lastSubmissionAt = Date.now();
          post('SUBMISSION_REQUEST', { url, method, ...submission });
        }
      }
    } catch (error) {
      post('DEBUG', { stage: 'fetch-request', message: String(error) });
    }

    const response = await originalFetch.apply(this, arguments);
    try {
      if (RESULT_HINT.test(url)) {
        const text = await response.clone().text();
        inspectResult(url, text);
      }
    } catch (error) {
      post('DEBUG', { stage: 'fetch-response', message: String(error) });
    }
    return response;
  };

  const OriginalXHR = window.XMLHttpRequest;
  const originalOpen = OriginalXHR.prototype.open;
  const originalSend = OriginalXHR.prototype.send;

  OriginalXHR.prototype.open = function(method, url) {
    this.__jungolhub = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
    return originalOpen.apply(this, arguments);
  };

  OriginalXHR.prototype.send = function(body) {
    try {
      const meta = this.__jungolhub || {};
      if (meta.method !== 'GET' && REQUEST_HINT.test(meta.url || '')) {
        const submission = extractSubmission(body);
        if (submission) {
          lastSubmissionAt = Date.now();
          post('SUBMISSION_REQUEST', { ...meta, ...submission });
        }
      }

      this.addEventListener('load', () => {
        try {
          if (!RESULT_HINT.test(meta.url || '')) return;
          const text = typeof this.responseText === 'string' ? this.responseText : '';
          inspectResult(meta.url, text);
        } catch {}
      });
    } catch (error) {
      post('DEBUG', { stage: 'xhr', message: String(error) });
    }
    return originalSend.apply(this, arguments);
  };

  post('HOOK_READY');
})();
