const DEBUG_KEY = 'jungolhubDebugLogs';
const SCRIPT_IDS = ['jungolhub-main-hook', 'jungolhub-isolated'];
const MATCHES = ['https://jungol.co.kr/*', 'https://*.jungol.co.kr/*'];

async function debug(stage, data = {}) {
  const entry = { at: new Date().toISOString(), stage, url: 'service-worker', data };
  console.info('[JungolHub]', stage, data);
  try {
    const stored = await chrome.storage.local.get({ [DEBUG_KEY]: [] });
    const logs = [...(stored[DEBUG_KEY] || []), entry].slice(-100);
    await chrome.storage.local.set({ [DEBUG_KEY]: logs });
  } catch (error) {
    console.warn('[JungolHub] debug storage failed', error);
  }
}

async function registerScripts() {
  try {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: SCRIPT_IDS });
    } catch {}

    await chrome.scripting.registerContentScripts([
      {
        id: 'jungolhub-main-hook',
        matches: MATCHES,
        js: ['page-hook.js'],
        runAt: 'document_start',
        world: 'MAIN',
        persistAcrossSessions: true
      },
      {
        id: 'jungolhub-isolated',
        matches: MATCHES,
        js: ['probe.js', 'content.js'],
        runAt: 'document_start',
        world: 'ISOLATED',
        persistAcrossSessions: true
      }
    ]);

    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS });
    await debug('registered-content-scripts', {
      count: registered.length,
      ids: registered.map((item) => item.id),
      matches: MATCHES
    });
  } catch (error) {
    await debug('register-content-scripts-failed', {
      message: error?.message || String(error)
    });
  }
}

let registration = Promise.resolve();
function queueRegistration() {
  registration = registration.then(registerScripts, registerScripts);
  return registration;
}

await debug('service-worker-ready', { version: chrome.runtime.getManifest().version });
queueRegistration();
chrome.runtime.onInstalled.addListener(() => queueRegistration());
chrome.runtime.onStartup.addListener(() => queueRegistration());
