import {
    CHAT_METADATA_KEY,
    DEFAULT_SUMMARY_PROMPT,
    chatGuardsEqual,
    chooseChatDate,
    countConversationLayers,
    formatAlias,
    formatDisplayAlias,
    getChatContentGuard,
    getChatUserName,
    getEmbeddedRecord,
    getFingerprint,
    getAutoRetryAfterCount,
    getScopeKey,
    isRecordStale,
    matchesAllFragments,
    mergeSearchResults,
    mergeStoredRecords,
    normalizeSettings,
    normalizeApiBaseUrl,
    normalizeFileName,
    prepareStoredRecord,
    serializeRecentMessages,
    shouldAutoSummarize,
    simpleHash,
} from './core.js';
import { KEYLESS_SECRET_ID, setMaxConcurrentRequests, summarizeWithChunking } from './ai.js';
import { IndexedRecordStore } from './storage.js';

const MODULE_NAME = 'chatFileAssistant';
const EXTENSION_FOLDER = 'third-party/SillyTavern-Chat-File-Assistant';
const metadataCache = new Map();
const metadataByScope = new Map();
const activeJobs = new Map();
const activeControllers = new Map();
const userNameJobs = new Set();
const userNameQueue = [];
const embeddedChecked = new Set();
const autoSummaryTimers = new Map();
let settings;
let context;
let recordStore;
let observer;
let fetchInstalled = false;
let initialized = false;
let batchController = null;
let batchRunning = false;
let observedContainer = null;
let apiDraftId = null;
let userNameQueueRunning = false;
const eventBindings = [];
let previousFetch = null;
let installedFetch = null;
let installedFetchState = null;
let embeddedObserver = null;
let storageTaskController = null;
let storageTaskPromise = null;
let backgroundReadController = new AbortController();
let userNamePumpPromise = null;
let dataEpoch = 0;
let dataResetting = false;
let lifecycleEpoch = 0;
let activationController = null;

const strings = {
    en: {
        toolbar: 'Chat File AI', generateMissing: 'Fill missing / refresh stale', cancel: 'Cancel', idle: 'Ready',
        stale: 'Summary out of date', generate: 'Generate summary', refresh: 'Refresh summary',
        edit: 'Edit display alias', clear: 'Clear display alias', editSummary: 'Edit summary', clearSummary: 'Clear AI summary',
        summaryTitle: 'Edit summary', summaryHelp: 'This edits the displayed summary only. It does not change the chat messages.',
        original: 'Original file', generating: 'Generating…', failed: 'Generation failed', empty: 'This chat is empty.',
        aliasTitle: 'Display alias', aliasHelp: 'This only changes the plugin display alias. The real chat filename is not modified.',
        clearConfirm: 'Clear this account\'s local IndexedDB summaries, suggestions, and aliases? Embedded copies in chat files will remain, and chat-file synchronization will be turned off.',
        clearEmbeddedConfirm: 'Remove embedded plugin data from the currently open chat? This saves that chat.',
        cleaned: 'Local IndexedDB data cleared. Embedded chat-file copies were not changed.', progress: (a, b) => `${a} / ${b}`,
        batchDone: 'Batch processing finished.', batchCancelled: 'Batch processing cancelled.',
        abortAll: 'Stop all summary requests', abortedAll: 'All active and queued summary requests were cancelled.',
        presetName: 'Preset name', presetNameRequired: 'Enter a preset name.', invalidUrl: 'Enter a valid HTTP(S) API base URL.',
        modelRequired: 'Enter a model name.', keySaved: 'Key saved; leave blank to keep it.', keyOptional: 'Optional for keyless/local APIs.',
        presetSaved: 'API preset saved.', presetDeleted: 'API preset deleted.', deletePreset: 'Delete this API preset?',
        noPreset: 'Create and save an API preset first.', modelsLoaded: n => `${n} models loaded.`, modelsFailed: 'Could not fetch models.',
        storageError: 'Could not open the local IndexedDB cache.', writeFailed: 'Could not write plugin data to the chat file.',
        generationChanged: 'The chat changed while the summary was being generated. Please retry.',
        historicalWriteUnsafe: 'SillyTavern 1.18 cannot safely update metadata in a closed historical chat without risking concurrent message loss. Open that chat before writing or clearing embedded data.',
        noActiveScope: 'Select a character or group before running this storage task.',
        noActiveChat: 'Open a chat before writing or clearing embedded data.', noStoredRecord: 'The current chat has no local summary or alias to embed.',
        storageDone: 'Storage task finished.', storageCancelled: 'Storage task cancelled.', storageSkip: 'Skipped a chat that changed while it was being processed.',
    },
    zh: {
        toolbar: '聊天文件 AI', generateMissing: '补全缺失 / 更新过期', cancel: '取消', idle: '就绪',
        stale: '总结已过期', generate: '生成总结', refresh: '刷新总结',
        edit: '编辑显示别名', clear: '清除显示别名', editSummary: '编辑总结', clearSummary: '清除 AI 总结',
        summaryTitle: '编辑总结', summaryHelp: '这里只修改插件显示的总结，不会修改聊天消息。',
        original: '原始文件', generating: '正在生成…', failed: '生成失败', empty: '该聊天没有可总结的消息。',
        aliasTitle: '显示别名', aliasHelp: '这里只修改插件显示的别名，不会修改真实聊天文件名。',
        clearConfirm: '清除当前账户保存在本机 IndexedDB 的全部总结、建议标题和显示别名？聊天文件中的内嵌副本会保留，同时将关闭聊天文件同步。',
        clearEmbeddedConfirm: '清除当前已打开聊天文件中的插件数据？此操作会保存该聊天。',
        cleaned: '本地 IndexedDB 数据已清除；聊天文件中的内嵌副本未改动。', progress: (a, b) => `${a} / ${b}`,
        batchDone: '批量处理完成。', batchCancelled: '已取消批量处理。',
        abortAll: '中断所有请求', abortedAll: '已取消全部正在运行和排队的总结请求。',
        presetName: '方案名称', presetNameRequired: '请输入方案名称。', invalidUrl: '请输入有效的 HTTP(S) API 基础地址。',
        modelRequired: '请输入模型名称。', keySaved: '密钥已保存；留空将保持不变。', keyOptional: '无密钥或本地 API 可留空。',
        presetSaved: 'API 方案已保存。', presetDeleted: 'API 方案已删除。', deletePreset: '删除当前 API 方案？',
        noPreset: '请先新建并保存一个 API 方案。', modelsLoaded: n => `已载入 ${n} 个模型。`, modelsFailed: '无法获取模型列表。',
        storageError: '无法打开本地 IndexedDB 缓存。', writeFailed: '无法将插件数据写入聊天文件。',
        generationChanged: '生成总结期间聊天内容发生了变化，请重试。',
        historicalWriteUnsafe: 'SillyTavern 1.18 无法在不冒并发消息丢失风险的情况下安全修改未打开历史聊天的元数据。请先打开该聊天，再写入或清除内嵌数据。',
        noActiveScope: '请先选择一个角色或群聊，再运行存储任务。',
        noActiveChat: '请先打开一个聊天，再写入或清除内嵌数据。', noStoredRecord: '当前聊天没有可内嵌的本地总结或别名。',
        storageDone: '存储任务已完成。', storageCancelled: '存储任务已取消。', storageSkip: '聊天在处理期间发生变化，已跳过。',
    },
};

function s() {
    const locale = context?.getCurrentLocale?.() ?? document.documentElement.lang ?? 'en';
    return String(locale).toLowerCase().startsWith('zh') ? strings.zh : strings.en;
}

function currentScope() {
    const ctx = SillyTavern.getContext();
    const avatar = ctx.characterId !== undefined ? ctx.characters?.[ctx.characterId]?.avatar : null;
    return {
        key: getScopeKey({ groupId: ctx.groupId, avatar }),
        groupId: ctx.groupId,
        avatar,
    };
}

function ensureScopeRecords(scopeKey) {
    return recordStore.scope(scopeKey, true);
}

function recordFor(scopeKey, fileName, create = false) {
    return recordStore.record(scopeKey, fileName, create);
}

async function reconcileScopeRecords(scopeKey, nativeResults, expectedEpoch = dataEpoch) {
    if (expectedEpoch !== dataEpoch) return;
    await recordStore.loadScope(scopeKey);
    if (expectedEpoch !== dataEpoch) return;
    const liveFiles = new Set(nativeResults.map(item => normalizeFileName(item.file_name ?? item.file_id)));
    const staleFiles = Object.keys(recordStore.scope(scopeKey) ?? {}).filter(fileName => !liveFiles.has(fileName));
    await Promise.all(staleFiles.map(fileName => recordStore.delete(scopeKey, fileName)));
}

function configHash(config = settings.config) {
    const customPreset = config.customPreset
        ?? settings.apiPresets.find(preset => preset.id === config.customPresetId);
    return simpleHash(JSON.stringify({
        summaryPrompt: config.summaryPrompt,
        maxOutputTokens: config.providerMode === 'custom' ? config.maxOutputTokens : null,
        contextMode: config.contextMode,
        recentMessageCount: config.contextMode === 'recent' ? config.recentMessageCount : null,
        providerMode: config.providerMode,
        customPreset: customPreset ? { id: customPreset.id, url: customPreset.url, model: customPreset.model } : null,
    }));
}

function generationConfig() {
    const config = structuredClone(settings.config);
    config.customPreset = settings.apiPresets.find(preset => preset.id === config.customPresetId) ?? null;
    return config;
}

function abortAllSummaryRequests() {
    batchController?.abort();
    for (const controller of activeControllers.values()) controller.abort();
    globalThis.toastr?.info(s().abortedAll);
}

function save() {
    context.saveSettingsDebounced();
}

function isCurrentChatTarget(scopeKey, fileName, liveContext = SillyTavern.getContext()) {
    return currentScope().key === scopeKey && normalizeFileName(liveContext.chatId) === normalizeFileName(fileName);
}

async function saveRecord(scopeKey, fileName, record, { embed = settings.config.writeToChatFiles, messages = null } = {}) {
    if (dataResetting) throw new DOMException('The local index is being reset.', 'AbortError');
    const stored = prepareStoredRecord(record, { recordId: record?.recordId || newId() });
    Object.assign(record, stored);
    await recordStore.put(scopeKey, fileName, record);
    if (embed && isCurrentChatTarget(scopeKey, fileName)) {
        try { await writeEmbeddedRecord(scopeKey, fileName, record, messages); }
        catch (error) {
            console.error('[Chat File AI] Embedded chat-file write failed; the IndexedDB copy is intact:', error);
            globalThis.toastr?.warning(error.message || s().writeFailed);
        }
    }
    return record;
}

export async function getUserHandle({ fetchFn = globalThis.fetch, headers = context?.getRequestHeaders?.(), signal = null } = {}) {
    const response = await fetchFn('/api/users/me', { headers, signal });
    if (!response.ok) throw new Error(`Unable to identify the current SillyTavern user (${response.status}).`);
    const handle = String((await response.json())?.handle ?? '').trim();
    if (!handle) throw new Error('SillyTavern did not return a current user handle.');
    return handle;
}

function parseSearchRequest(input, init) {
    try {
        const url = typeof input === 'string' || input instanceof URL ? new URL(input, location.href) : new URL(input.url, location.href);
        if (url.origin !== location.origin || url.pathname !== '/api/chats/search') return null;
        const rawBody = init?.body;
        if (typeof rawBody !== 'string') return null;
        const body = JSON.parse(rawBody);
        const scopeKey = getScopeKey({ groupId: body.group_id, avatar: body.avatar_url });
        return { body, scopeKey };
    } catch {
        return null;
    }
}

export function parseDeletedGroupId(input, init, baseUrl = globalThis.location?.href ?? 'http://localhost/') {
    try {
        const base = new URL(baseUrl);
        const url = typeof input === 'string' || input instanceof URL ? new URL(input, baseUrl) : new URL(input.url, baseUrl);
        if (url.origin !== base.origin || url.pathname !== '/api/groups/delete' || typeof init?.body !== 'string') return null;
        return String(JSON.parse(init.body)?.id ?? '').trim() || null;
    } catch {
        return null;
    }
}

export function installFetchWrapper() {
    if (fetchInstalled) return;
    const delegate = globalThis.fetch;
    const state = { enabled: true };
    previousFetch = delegate;
    installedFetchState = state;
    installedFetch = async function cfaFetch(input, init) {
        if (!state.enabled) return Reflect.apply(delegate, globalThis, [input, init]);
        const parsed = parseSearchRequest(input, init);
        const deletedGroupId = parseDeletedGroupId(input, init);
        const query = String(parsed?.body?.query ?? '').trim();
        if (parsed && !query && settings.config.writeToChatFiles && !parsed.body.group_id) {
            try { return await fetchCharacterListWithMetadata(parsed, init, delegate); }
            catch (error) { console.warn('[Chat File AI] Batched chat metadata load failed; using the native search:', error); }
        }
        const response = await Reflect.apply(delegate, globalThis, [input, init]);
        if (deletedGroupId && response.ok) {
            const scopeKey = getScopeKey({ groupId: deletedGroupId });
            void recordStore.deleteScope(scopeKey).then(() => {
                metadataCache.delete(scopeKey); metadataByScope.delete(scopeKey);
            }).catch(error => console.warn('[Chat File AI] Deleted group cache cleanup failed:', error));
        }
        if (!parsed || !response.ok) return response;
        if (!query) {
            const expectedEpoch = dataEpoch;
            void response.clone().json().then(nativeResults => {
                if (!Array.isArray(nativeResults) || expectedEpoch !== dataEpoch) return;
                metadataCache.set(parsed.scopeKey, nativeResults);
                metadataByScope.set(parsed.scopeKey, new Map(nativeResults.map(item => [normalizeFileName(item.file_name), item])));
                return reconcileScopeRecords(parsed.scopeKey, nativeResults, expectedEpoch).then(() => requestAnimationFrame(renderVisibleCards));
            }).catch(error => console.warn('[Chat File AI] Metadata caching failed:', error));
            return response;
        }
        try { await recordStore.loadScope(parsed.scopeKey); }
        catch (error) {
            console.warn('[Chat File AI] Search index load failed; returning native results:', error);
            return response;
        }
        const scopeRecords = recordStore.scope(parsed.scopeKey);
        if (!scopeRecords || !metadataCache.has(parsed.scopeKey)) return response;
        try {
            const nativeResults = await response.clone().json();
            if (!Array.isArray(nativeResults)) return response;
            const merged = mergeSearchResults(
                nativeResults,
                metadataCache.get(parsed.scopeKey) ?? [],
                scopeRecords,
                query,
            );
            const headers = new Headers(response.headers);
            headers.delete('content-length');
            headers.delete('content-encoding');
            headers.set('content-type', 'application/json; charset=utf-8');
            return new Response(JSON.stringify(merged), {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        } catch (error) {
            console.warn('[Chat File AI] Search augmentation failed:', error);
            return response;
        }
    };
    globalThis.fetch = installedFetch;
    fetchInstalled = true;
}

async function fetchCharacterListWithMetadata(parsed, init, delegate) {
    const expectedEpoch = dataEpoch;
    const response = await Reflect.apply(delegate, globalThis, ['/api/characters/chats', {
        method: 'POST', headers: init?.headers ?? context.getRequestHeaders(),
        body: JSON.stringify({ avatar_url: parsed.body.avatar_url, metadata: true }),
    }]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const source = await response.json();
    if (!Array.isArray(source)) throw new Error('Unexpected character chats response.');
    if (expectedEpoch !== dataEpoch) throw new DOMException('The operation was aborted.', 'AbortError');
    await recordStore.loadScope(parsed.scopeKey);
    const nativeResults = [];
    const embeddedRecords = [];
    for (const item of source) {
        const fileName = normalizeFileName(item.file_id ?? item.file_name);
        embeddedChecked.add(`${parsed.scopeKey}\n${fileName}`);
        const message = String(item.mes ?? '');
        nativeResults.push({
            file_name: fileName,
            file_size: item.file_size,
            message_count: Number(item.chat_items ?? 0),
            last_mes: item.last_mes,
            preview_message: message.length > 400 ? `...${message.slice(-400)}` : message,
        });
        const embedded = item.chat_metadata?.[CHAT_METADATA_KEY];
        if (embedded && typeof embedded === 'object') {
            const merged = mergeStoredRecords(recordFor(parsed.scopeKey, fileName), embedded);
            embeddedRecords.push([fileName, merged]);
        }
    }
    if (embeddedRecords.length && expectedEpoch === dataEpoch) await recordStore.putMany(parsed.scopeKey, embeddedRecords);
    await reconcileScopeRecords(parsed.scopeKey, nativeResults, expectedEpoch);
    if (expectedEpoch !== dataEpoch) throw new DOMException('The operation was aborted.', 'AbortError');
    metadataCache.set(parsed.scopeKey, nativeResults);
    metadataByScope.set(parsed.scopeKey, new Map(nativeResults.map(item => [normalizeFileName(item.file_name), item])));
    requestAnimationFrame(renderVisibleCards);
    return new Response(JSON.stringify(nativeResults), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
    });
}

export function uninstallFetchWrapper() {
    if (!fetchInstalled) return;
    installedFetchState.enabled = false;
    if (globalThis.fetch === installedFetch) globalThis.fetch = previousFetch;
    else console.warn('[Chat File AI] Another extension replaced fetch after this extension; the inactive wrapper will remain as a pass-through.');
    fetchInstalled = false;
    installedFetch = null;
    installedFetchState = null;
    previousFetch = null;
}

async function readChat(fileName, scope = currentScope(), signal = null) {
    const headers = context.getRequestHeaders();
    const endpoint = scope.groupId ? '/api/chats/group/get' : '/api/chats/get';
    const body = scope.groupId
        ? { id: normalizeFileName(fileName) }
        : { file_name: normalizeFileName(fileName), avatar_url: scope.avatar };
    const fetchFn = previousFetch ?? globalThis.fetch;
    const response = await Reflect.apply(fetchFn, globalThis, [endpoint, { method: 'POST', headers, cache: 'no-cache', body: JSON.stringify(body), signal }]);
    if (!response.ok) throw new Error(`Unable to read chat (${response.status}).`);
    const messages = await response.json();
    if (!Array.isArray(messages)) throw new Error('The chat response was not an array.');
    return messages;
}

function messagesFingerprint(messages, scope) {
    return getChatContentGuard(messages, { skipHeader: !scope.groupId });
}

async function writeEmbeddedRecord(scopeKey, fileName, record, suppliedMessages = null) {
    const normalized = normalizeFileName(fileName);
    const liveContext = SillyTavern.getContext();
    if (isCurrentChatTarget(scopeKey, normalized, liveContext)) {
        liveContext.chatMetadata[CHAT_METADATA_KEY] = structuredClone(record);
        await liveContext.saveMetadata();
        return;
    }
    void suppliedMessages;
    throw new Error(s().historicalWriteUnsafe);
}

async function removeEmbeddedRecord(scopeKey, fileName) {
    const normalized = normalizeFileName(fileName);
    const liveContext = SillyTavern.getContext();
    if (isCurrentChatTarget(scopeKey, normalized, liveContext)) {
        if (!Object.hasOwn(liveContext.chatMetadata, CHAT_METADATA_KEY)) return;
        delete liveContext.chatMetadata[CHAT_METADATA_KEY];
        await liveContext.saveMetadata();
        return;
    }
    throw new Error(s().historicalWriteUnsafe);
}

async function restoreEmbeddedRecord(fileName, scope = currentScope(), messages = null, { render = true } = {}) {
    const data = messages ?? await readChat(fileName, scope);
    embeddedChecked.add(`${scope.key}\n${normalizeFileName(fileName)}`);
    const embedded = getEmbeddedRecord(data);
    if (!embedded) return null;
    const local = recordFor(scope.key, fileName);
    const merged = mergeStoredRecords(local, embedded);
    await recordStore.put(scope.key, fileName, merged);
    if (render) renderVisibleCards();
    return merged;
}

function metaFor(scopeKey, fileName) {
    return metadataByScope.get(scopeKey)?.get(normalizeFileName(fileName)) ?? {};
}

async function generateFor(fileName, card = null, externalSignal = null, targetScope = currentScope()) {
    if (dataResetting) throw new DOMException('The local index is being reset.', 'AbortError');
    const scope = { ...targetScope };
    const taskDataEpoch = dataEpoch;
    const key = `${scope.key}\n${normalizeFileName(fileName)}`;
    if (activeJobs.has(key)) return activeJobs.get(key);
    const controller = new AbortController();
    activeControllers.set(key, controller);
    if (externalSignal) externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), { once: true });
    const job = (async () => {
        setCardBusy(card, true);
        try {
            const taskConfig = generationConfig();
            const taskPromptHash = configHash(taskConfig);
            const rawMessages = await readChat(fileName, scope, controller.signal);
            const skipHeader = !scope.groupId;
            const serialized = serializeRecentMessages(rawMessages, {
                skipHeader,
                mode: taskConfig.contextMode,
                maxLayers: taskConfig.recentMessageCount,
            });
            if (!serialized) throw new Error(s().empty);
            const result = await summarizeWithChunking(serialized, taskConfig, context, controller.signal, progress => {
                updateCardProgress(card, progress);
            });
            controller.signal.throwIfAborted();
            const latestMessages = await readChat(fileName, scope, controller.signal);
            if (taskDataEpoch !== dataEpoch) throw new DOMException('The operation was aborted.', 'AbortError');
            if (!chatGuardsEqual(messagesFingerprint(rawMessages, scope), messagesFingerprint(latestMessages, scope))) {
                throw new Error(s().generationChanged);
            }
            const contentMessages = skipHeader ? rawMessages.slice(1) : rawMessages;
            const lastMessage = contentMessages.findLast(message => message && !message.is_system && (message.mes || message.content));
            const cachedMeta = metaFor(scope.key, fileName);
            const meta = {
                ...cachedMeta,
                last_mes: lastMessage?.send_date ?? cachedMeta.last_mes ?? null,
                message_count: countConversationLayers(rawMessages, { skipHeader }),
                file_size: cachedMeta.file_size ?? '',
            };
            const existing = recordFor(scope.key, fileName, true);
            const aliasDate = chooseChatDate({ messages: rawMessages, fileName, lastMes: meta.last_mes });
            const userName = getChatUserName(rawMessages, { skipHeader });
            const messageCountAtGeneration = countConversationLayers(rawMessages, { skipHeader });
            Object.assign(existing, {
                fingerprint: getFingerprint(meta), promptHash: taskPromptHash, summary: result.summary,
                suggestedTitle: formatAlias(aliasDate, result.title), acceptedAlias: formatAlias(aliasDate, result.title),
                userName: userName || existing.userName || '', messageCountAtGeneration,
                generatedAt: new Date().toISOString(), stale: false,
                generator: { mode: taskConfig.providerMode, presetId: taskConfig.customPresetId },
            });
            delete existing.autoFailureCount;
            delete existing.autoRetryAfterCount;
            await saveRecord(scope.key, fileName, existing, { messages: latestMessages });
            renderVisibleCards();
            return existing;
        } catch (error) {
            if (error?.name !== 'AbortError') {
                console.error('[Chat File AI] Generation failed:', error);
                globalThis.toastr?.error(error.message, s().failed);
            }
            throw error;
        } finally {
            setCardBusy(card, false);
            activeJobs.delete(key);
            activeControllers.delete(key);
        }
    })();
    activeJobs.set(key, job);
    return job;
}

function setCardBusy(card, busy) {
    if (!card?.isConnected) return;
    card.classList.toggle('cfa-busy', busy);
    card.querySelectorAll('.cfa-action').forEach(button => button.classList.toggle('cfa-disabled', busy));
    const action = card.querySelector('.cfa-generate');
    if (action && busy) action.title = s().generating;
}

function updateCardProgress(card, progress) {
    if (!card?.isConnected) return;
    const action = card.querySelector('.cfa-generate');
    if (action) action.title = `${s().generating} ${progress.current}/${progress.total}`;
}

function makeIconButton(icon, title, handler) {
    const button = document.createElement('div');
    button.className = `cfa-action hoverglow opacity50p fa-solid fa-sm ${icon}`;
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    button.title = title;
    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (!button.classList.contains('cfa-disabled')) handler(event);
    });
    button.addEventListener('keydown', event => {
        if ((event.key === 'Enter' || event.key === ' ') && !button.classList.contains('cfa-disabled')) {
            event.preventDefault(); handler(event);
        }
    });
    return button;
}

async function editAlias(fileName, record) {
    const suggested = record?.acceptedAlias || record?.suggestedTitle || '';
    const value = await context.Popup.show.input(s().aliasTitle, s().aliasHelp, suggested);
    if (typeof value !== 'string' || !value.trim()) return;
    const target = recordFor(currentScope().key, fileName, true);
    target.acceptedAlias = value.trim();
    await saveRecord(currentScope().key, fileName, target);
    renderVisibleCards();
}

async function clearAlias(fileName) {
    const scopeKey = currentScope().key;
    const record = recordFor(scopeKey, fileName);
    if (!record?.acceptedAlias) return;
    delete record.acceptedAlias;
    await saveRecord(scopeKey, fileName, record);
    renderVisibleCards();
}

async function clearSummary(fileName) {
    const scopeKey = currentScope().key;
    const record = recordFor(scopeKey, fileName);
    if (!record?.summary) return;
    delete record.summary;
    delete record.fingerprint;
    delete record.promptHash;
    delete record.generatedAt;
    delete record.messageCountAtGeneration;
    record.stale = true;
    await saveRecord(scopeKey, fileName, record);
    renderVisibleCards();
}

async function editSummary(fileName) {
    const scopeKey = currentScope().key;
    const record = recordFor(scopeKey, fileName);
    if (!record?.summary) return;
    const value = await context.Popup.show.input(s().summaryTitle, s().summaryHelp, record.summary, { rows: 12 });
    if (typeof value !== 'string' || !value.trim() || value.trim() === record.summary) return;
    record.summary = value.trim();
    await saveRecord(scopeKey, fileName, record);
    renderVisibleCards();
}

function enhanceCard(wrapper) {
    const block = wrapper.querySelector('.select_chat_block');
    const originalNameElement = wrapper.querySelector('.select_chat_block_filename');
    const preview = wrapper.querySelector('.select_chat_block_mes');
    const titleLeft = originalNameElement?.parentElement;
    if (!block || !originalNameElement || !preview || !titleLeft) return;
    const renameButton = wrapper.querySelector('.renameChatButton');
    if (renameButton?.closest('.cfa-injected')) titleLeft.append(renameButton);
    const fileName = normalizeFileName(block.getAttribute('file_name') || wrapper.dataset.cfaRealFile || originalNameElement.textContent);
    const nativePreview = wrapper.dataset.cfaNativePreview ?? preview.textContent;
    wrapper.dataset.cfaNativePreview = nativePreview;
    wrapper.dataset.cfaRealFile = fileName;
    wrapper.dataset.cfaFile = fileName;
    wrapper.querySelectorAll('.cfa-injected').forEach(element => element.remove());

    const scope = currentScope();
    const record = recordFor(scope.key, fileName);
    const stale = isRecordStale(record, getFingerprint(metaFor(scope.key, fileName)), configHash());

    originalNameElement.textContent = fileName;
    if (record?.acceptedAlias) {
        const alias = document.createElement('small');
        alias.className = 'cfa-alias cfa-injected select_chat_block_filename_item';
        alias.textContent = formatDisplayAlias(record.acceptedAlias, record.userName, settings.config.showUserName);
        alias.title = `${s().original}: ${fileName}`;
        originalNameElement.before(alias);
    } else {
        originalNameElement.removeAttribute('title');
    }
    if (settings.config.showUserName && record?.acceptedAlias && !record.userName) queueUserNameLookup(fileName, scope);

    const controls = document.createElement('span');
    controls.className = 'cfa-controls cfa-injected';
    const generate = makeIconButton(stale ? 'fa-wand-magic-sparkles' : 'fa-rotate', stale && record?.summary ? s().stale : stale ? s().generate : s().refresh, () => generateFor(fileName, wrapper).catch(() => {}));
    generate.classList.add('cfa-generate');
    if (record?.suggestedTitle || record?.acceptedAlias) controls.append(makeIconButton('fa-pen', s().edit, () => editAlias(fileName, record)));
    if (record?.acceptedAlias) controls.append(makeIconButton('fa-eraser', s().clear, () => clearAlias(fileName).catch(error => globalThis.toastr?.error(error.message))));
    if (renameButton) controls.append(renameButton);
    controls.append(generate);
    if (record?.summary) {
        controls.append(makeIconButton('fa-file-pen', s().editSummary, () => editSummary(fileName).catch(error => globalThis.toastr?.error(error.message))));
        controls.append(makeIconButton('fa-trash-can', s().clearSummary, () => clearSummary(fileName).catch(error => globalThis.toastr?.error(error.message))));
    }
    titleLeft.append(controls);

    if (record?.summary) {
        preview.textContent = record.summary;
        preview.classList.add('cfa-summary');
        preview.classList.toggle('cfa-stale', stale);
        preview.onclick = event => { event.stopPropagation(); preview.classList.toggle('cfa-expanded'); };
    } else {
        preview.textContent = nativePreview;
        preview.classList.remove('cfa-summary', 'cfa-stale', 'cfa-expanded');
        preview.onclick = null;
    }
}

function queueUserNameLookup(fileName, scope) {
    const normalized = normalizeFileName(fileName);
    const key = `${scope.key}\n${normalized}`;
    if (userNameJobs.has(key)) return;
    userNameJobs.add(key);
    userNameQueue.push({ key, fileName: normalized, scope: { ...scope }, epoch: dataEpoch });
    void pumpUserNameQueue();
}

function pumpUserNameQueue() {
    if (userNamePumpPromise || !initialized) return userNamePumpPromise;
    userNameQueueRunning = true;
    userNamePumpPromise = (async () => {
        while (initialized && userNameQueue.length) {
            const job = userNameQueue.shift();
            try {
                if (job.epoch !== dataEpoch) continue;
                const messages = await readChat(job.fileName, job.scope, backgroundReadController.signal);
                if (!initialized || job.epoch !== dataEpoch) continue;
                if (job.restoreEmbedded) {
                    if (!settings.config.writeToChatFiles) continue;
                    await restoreEmbeddedRecord(job.fileName, job.scope, messages);
                    continue;
                }
                const userName = getChatUserName(messages, { skipHeader: !job.scope.groupId });
                if (userName) {
                    recordFor(job.scope.key, job.fileName, true).userName = userName;
                    await saveRecord(job.scope.key, job.fileName, recordFor(job.scope.key, job.fileName), { embed: false });
                    if (currentScope().key === job.scope.key) {
                        const card = [...document.querySelectorAll('#select_chat_div .select_chat_block_wrapper')]
                            .find(item => item.dataset.cfaFile === job.fileName);
                        if (card) enhanceCard(card);
                    }
                }
            } catch (error) {
                if (error?.name !== 'AbortError') console.debug('[Chat File AI] Could not read historical user name:', error);
            } finally { userNameJobs.delete(job.key); }
        }
    })().finally(() => {
        userNameQueueRunning = false;
        userNamePumpPromise = null;
        if (initialized && userNameQueue.length) void pumpUserNameQueue();
    });
    return userNamePumpPromise;
}

function renderVisibleCards() {
    if (!initialized) return;
    const scope = currentScope();
    if (!recordStore.loadedScopes.has(scope.key)) {
        void recordStore.loadScope(scope.key).then(() => {
            renderVisibleCards();
            if (settings.config.writeToChatFiles) restoreEmbeddedForVisibleCards();
        }).catch(error => console.warn('[Chat File AI] IndexedDB scope load failed:', error));
        ensureToolbar();
        return;
    }
    document.querySelectorAll('#select_chat_div .select_chat_block_wrapper').forEach(enhanceCard);
    ensureToolbar();
    if (settings.config.writeToChatFiles) observeEmbeddedCards();
}

function observeEmbeddedCards() {
    embeddedObserver ??= new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            embeddedObserver.unobserve(entry.target);
            const fileName = entry.target.dataset.cfaFile;
            const scope = currentScope();
            const checkKey = `${scope.key}\n${normalizeFileName(fileName)}`;
            if (fileName && !embeddedChecked.has(checkKey)) {
                embeddedChecked.add(checkKey);
                queueEmbeddedRestore(fileName, entry.target, scope);
            }
        }
    }, { root: document.querySelector('#select_chat_div'), rootMargin: '200px' });
    const scope = currentScope();
    document.querySelectorAll('#select_chat_div .select_chat_block_wrapper').forEach(card => {
        const checkKey = `${scope.key}\n${normalizeFileName(card.dataset.cfaFile)}`;
        if (!embeddedChecked.has(checkKey)) embeddedObserver.observe(card);
    });
}

function restoreEmbeddedForVisibleCards() {
    embeddedObserver?.disconnect();
    embeddedObserver = null;
    observeEmbeddedCards();
}

function queueEmbeddedRestore(fileName, card, scope = currentScope()) {
    const key = `embedded\n${scope.key}\n${normalizeFileName(fileName)}`;
    if (userNameJobs.has(key)) return;
    userNameJobs.add(key);
    userNameQueue.push({ key, fileName: normalizeFileName(fileName), scope: { ...scope }, restoreEmbedded: true, card, epoch: dataEpoch });
    void pumpUserNameQueue();
}

function handleCardMutations(mutations) {
    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (node.matches('.select_chat_block_wrapper')) enhanceCard(node);
            else node.querySelectorAll?.('.select_chat_block_wrapper').forEach(enhanceCard);
        }
    }
}

function ensureToolbar() {
    const header = document.querySelector('#select_chat_popup [name="selectChatPopupHeader"]');
    if (!header || header.querySelector('#cfa_toolbar')) return;
    const toolbar = document.createElement('div');
    toolbar.id = 'cfa_toolbar';
    toolbar.className = 'cfa-toolbar cfa-injected';
    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'menu_button menu_button_icon';
    run.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
    const runLabel = document.createElement('span'); runLabel.textContent = s().generateMissing; run.append(runLabel);
    run.addEventListener('click', event => { event.stopPropagation(); runBatch(); });
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'menu_button fa-solid fa-stop cfa-cancel'; cancel.title = s().cancel;
    cancel.addEventListener('click', event => { event.stopPropagation(); batchController?.abort(); });
    const progress = document.createElement('span'); progress.className = 'cfa-batch-progress'; progress.textContent = s().idle;
    toolbar.append(run, cancel, progress);
    const search = header.querySelector('#select_chat_search');
    header.insertBefore(toolbar, search);
    updateBatchToolbar();
}

function updateBatchToolbar(current = 0, total = 0) {
    const toolbar = document.querySelector('#cfa_toolbar');
    if (!toolbar) return;
    toolbar.classList.toggle('cfa-running', batchRunning);
    const progress = toolbar.querySelector('.cfa-batch-progress');
    if (progress) progress.textContent = batchRunning ? s().progress(current, total) : s().idle;
}

async function runBatch() {
    if (batchRunning) return;
    const scope = currentScope();
    const cards = [...document.querySelectorAll('#select_chat_div .select_chat_block_wrapper')];
    const jobs = cards.filter(card => {
        const fileName = card.dataset.cfaFile;
        return isRecordStale(recordFor(scope.key, fileName), getFingerprint(metaFor(scope.key, fileName)), configHash());
    });
    if (!jobs.length) return;
    batchRunning = true;
    batchController = new AbortController();
    try {
        let nextIndex = 0;
        let completed = 0;
        const worker = async () => {
            while (nextIndex < jobs.length) {
                batchController.signal.throwIfAborted();
                const card = jobs[nextIndex++];
                try { await generateFor(card.dataset.cfaFile, card, batchController.signal, scope); }
                catch (error) { if (error?.name === 'AbortError') throw error; }
                finally { updateBatchToolbar(++completed, jobs.length); }
            }
        };
        const workerCount = Math.min(settings.config.maxConcurrentRequests, jobs.length);
        await Promise.all(Array.from({ length: workerCount }, worker));
        globalThis.toastr?.success(s().batchDone);
    } catch (error) {
        if (error?.name === 'AbortError') globalThis.toastr?.info(s().batchCancelled);
    } finally {
        batchRunning = false;
        batchController = null;
        updateBatchToolbar();
    }
}

function startObserver() {
    observer?.disconnect();
    embeddedObserver?.disconnect();
    embeddedObserver = null;
    embeddedChecked.clear();
    observedContainer = document.querySelector('#select_chat_div');
    observer = new MutationObserver(mutations => {
        if (!observedContainer) {
            observedContainer = document.querySelector('#select_chat_div');
            if (observedContainer) {
                observer.disconnect();
                observer.observe(observedContainer, { childList: true });
                renderVisibleCards();
            }
            return;
        }
        handleCardMutations(mutations);
    });
    if (observedContainer) observer.observe(observedContainer, { childList: true });
    else if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    renderVisibleCards();
}

function stopObserver() {
    observer?.disconnect(); observer = null; observedContainer = null;
    document.querySelectorAll('#select_chat_div .renameChatButton').forEach(renameButton => {
        const wrapper = renameButton.closest('.select_chat_block_wrapper');
        const filename = wrapper?.querySelector('.select_chat_block_filename');
        filename?.after(renameButton);
    });
    document.querySelectorAll('.cfa-injected').forEach(element => element.remove());
    document.querySelectorAll('.cfa-summary').forEach(element => {
        const wrapper = element.closest('.select_chat_block_wrapper');
        if (wrapper?.dataset.cfaNativePreview !== undefined) element.textContent = wrapper.dataset.cfaNativePreview;
        element.classList.remove('cfa-summary', 'cfa-stale', 'cfa-expanded');
        element.onclick = null;
    });
    document.querySelectorAll('#select_chat_div .select_chat_block_wrapper').forEach(wrapper => {
        const filename = wrapper.querySelector('.select_chat_block_filename');
        if (filename && wrapper.dataset.cfaRealFile) filename.textContent = wrapper.dataset.cfaRealFile;
        delete wrapper.dataset.cfaNativePreview;
        delete wrapper.dataset.cfaRealFile;
        delete wrapper.dataset.cfaFile;
    });
}

function updateProviderVisibility() {
    const box = document.querySelector('#cfa_custom_api');
    if (box) box.hidden = settings.config.providerMode !== 'custom';
    const outputTokens = document.querySelector('#cfa_output_tokens');
    if (outputTokens) outputTokens.disabled = settings.config.providerMode !== 'custom';
}

function presetById(id) {
    return settings.apiPresets.find(preset => preset.id === id) ?? null;
}

function newId() {
    return globalThis.crypto?.randomUUID?.() ?? `cfa-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function rotateApiSecret(id) {
    try {
        const response = await fetch('/api/secrets/rotate', {
            method: 'POST', headers: context.getRequestHeaders(),
            body: JSON.stringify({ key: 'api_key_custom', id }),
        });
        return response.ok;
    } catch {
        return false;
    }
}

async function writeApiSecret(value, label, replacingId = null) {
    let priorActiveId = null;
    const stateResponse = await fetch('/api/secrets/read', { method: 'POST', headers: context.getRequestHeaders() });
    if (!stateResponse.ok) throw new Error(`Unable to read the current shared API key state (${stateResponse.status}).`);
    const state = await stateResponse.json();
    priorActiveId = Array.isArray(state?.api_key_custom)
        ? state.api_key_custom.find(secret => secret?.active)?.id ?? null
        : null;
    const response = await fetch('/api/secrets/write', {
        method: 'POST', headers: context.getRequestHeaders(),
        body: JSON.stringify({ key: 'api_key_custom', value, label: `Chat File AI: ${label}` }),
    });
    if (!response.ok) throw new Error(`Unable to save API key (${response.status}).`);
    const id = (await response.json()).id;
    const activeAfterWrite = priorActiveId === replacingId ? id : priorActiveId;
    if (activeAfterWrite && activeAfterWrite !== id) {
        if (!await rotateApiSecret(activeAfterWrite)) {
            try { await deleteApiSecret(id); }
            catch (error) { console.warn('[Chat File AI] Could not remove a newly written API key after active-key restoration failed:', error); }
            try { await rotateApiSecret(activeAfterWrite); }
            catch { /* The operation below still fails closed. */ }
            throw new Error('Could not restore the previously active shared custom API key.');
        }
    }
    return id;
}

async function deleteApiSecret(id) {
    if (!id) return;
    const response = await fetch('/api/secrets/delete', {
        method: 'POST', headers: context.getRequestHeaders(),
        body: JSON.stringify({ key: 'api_key_custom', id }),
    });
    if (!response.ok) throw new Error(`Unable to delete API key (${response.status}).`);
}

function updatePresetSelect() {
    const select = document.querySelector('#cfa_api_preset');
    if (!select) return;
    select.replaceChildren();
    select.append(new Option('—', ''));
    for (const preset of settings.apiPresets) select.append(new Option(preset.name, preset.id));
    select.value = apiDraftId ?? '';
    document.querySelector('#cfa_api_delete').disabled = !apiDraftId;
    document.querySelector('#cfa_api_save_as').disabled = !apiDraftId;
}

function showPreset(id) {
    const preset = presetById(id);
    apiDraftId = preset?.id ?? null;
    document.querySelector('#cfa_api_name').value = preset?.name ?? '';
    document.querySelector('#cfa_api_url').value = preset?.url ?? '';
    document.querySelector('#cfa_api_key').value = '';
    document.querySelector('#cfa_api_key').placeholder = preset?.secretId ? s().keySaved : s().keyOptional;
    document.querySelector('#cfa_api_model').value = preset?.model ?? '';
    const hint = document.querySelector('#cfa_api_hint');
    if (hint) hint.textContent = '';
    updatePresetSelect();
}

function beginBlankPreset() {
    apiDraftId = null;
    document.querySelector('#cfa_api_name').value = '';
    document.querySelector('#cfa_api_url').value = '';
    document.querySelector('#cfa_api_key').value = '';
    document.querySelector('#cfa_api_key').placeholder = s().keyOptional;
    document.querySelector('#cfa_api_model').value = '';
    document.querySelector('#cfa_model_list').replaceChildren();
    document.querySelector('#cfa_api_hint').textContent = '';
    updatePresetSelect();
    document.querySelector('#cfa_api_name').focus();
}

async function saveApiPreset({ asNew = false, nameOverride = null, silent = false, allowMissingModel = false } = {}) {
    const current = !asNew ? presetById(apiDraftId) : null;
    const name = String(nameOverride ?? document.querySelector('#cfa_api_name').value).trim();
    const url = normalizeApiBaseUrl(document.querySelector('#cfa_api_url').value);
    const model = String(document.querySelector('#cfa_api_model').value).trim();
    const keyValue = document.querySelector('#cfa_api_key').value.trim();
    if (!name) throw new Error(s().presetNameRequired);
    if (!url) throw new Error(s().invalidUrl);
    if (!model && !allowMissingModel) throw new Error(s().modelRequired);

    let secretId = current?.secretId ?? null;
    let obsoleteSecretId = null;
    if (asNew && !keyValue) secretId = presetById(apiDraftId)?.secretId ?? null;
    if (keyValue) {
        const oldSecretId = secretId;
        secretId = await writeApiSecret(keyValue, name, oldSecretId);
        if (oldSecretId && !settings.apiPresets.some(preset => preset.id !== current?.id && preset.secretId === oldSecretId)) {
            obsoleteSecretId = oldSecretId;
        }
    }
    const now = new Date().toISOString();
    const preset = {
        id: current?.id ?? newId(), name, url, model, secretId,
        createdAt: current?.createdAt ?? now, updatedAt: now,
    };
    if (current) Object.assign(current, preset);
    else settings.apiPresets.push(preset);
    settings.config.customPresetId = preset.id;
    apiDraftId = preset.id;
    document.querySelector('#cfa_api_key').value = '';
    save();
    showPreset(preset.id);
    renderVisibleCards();
    if (obsoleteSecretId) {
        try { await deleteApiSecret(obsoleteSecretId); }
        catch (error) { console.warn('[Chat File AI] The replaced API key could not be removed:', error); }
    }
    if (!silent) globalThis.toastr?.success(s().presetSaved);
    return preset;
}

async function saveApiPresetSafely(options) {
    try { return await saveApiPreset(options); }
    catch (error) { globalThis.toastr?.error(error.message); return null; }
}

async function saveApiPresetAs() {
    const source = presetById(apiDraftId);
    if (!source) return;
    const name = await context.Popup.show.input(s().presetName, '', `${source.name} Copy`);
    if (typeof name !== 'string' || !name.trim()) return;
    document.querySelector('#cfa_api_name').value = name.trim();
    await saveApiPresetSafely({ asNew: true, nameOverride: name.trim() });
}

async function deleteCurrentPreset() {
    const preset = presetById(apiDraftId);
    if (!preset || !await context.Popup.show.confirm(s().toolbar, s().deletePreset)) return;
    const remainingPresets = settings.apiPresets.filter(item => item.id !== preset.id);
    if (preset.secretId && !remainingPresets.some(item => item.secretId === preset.secretId)) await deleteApiSecret(preset.secretId);
    settings.apiPresets = remainingPresets;
    settings.config.customPresetId = settings.apiPresets[0]?.id ?? null;
    save();
    if (settings.config.customPresetId) showPreset(settings.config.customPresetId);
    else beginBlankPreset();
    renderVisibleCards();
    globalThis.toastr?.success(s().presetDeleted);
}

async function fetchModels() {
    const button = document.querySelector('#cfa_fetch_models');
    button.disabled = true;
    try {
        const preset = await saveApiPresetSafely({ silent: true, allowMissingModel: true });
        if (!preset) return;
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST', headers: context.getRequestHeaders(),
            body: JSON.stringify({ chat_completion_source: 'custom', custom_url: preset.url, secret_id: preset.secretId ?? KEYLESS_SECRET_ID }),
        });
        const data = await response.json();
        const models = Array.isArray(data?.data) ? data.data.map(item => typeof item === 'string' ? item : item?.id).filter(Boolean) : [];
        if (!response.ok || data?.error || !models.length) throw new Error(s().modelsFailed);
        const list = document.querySelector('#cfa_model_list');
        list.replaceChildren(...models.sort().map(model => new Option(model, model)));
        document.querySelector('#cfa_api_hint').textContent = s().modelsLoaded(models.length);
    } catch (error) {
        document.querySelector('#cfa_api_hint').textContent = error.message;
        globalThis.toastr?.error(error.message);
    } finally { button.disabled = false; }
}

async function renderSettings(expectedEpoch = lifecycleEpoch) {
    if (document.querySelector('#cfa_settings')) return;
    const html = await context.renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings');
    if (!initialized || expectedEpoch !== lifecycleEpoch) return;
    document.querySelector('#extensions_settings2')?.insertAdjacentHTML('beforeend', html);
    const provider = document.querySelector('#cfa_provider_mode');
    const prompt = document.querySelector('#cfa_summary_prompt');
    const showUserName = document.querySelector('#cfa_show_user_name');
    const autoSummarize = document.querySelector('#cfa_auto_summarize');
    const autoSummaryInterval = document.querySelector('#cfa_auto_summary_interval');
    const outputTokens = document.querySelector('#cfa_output_tokens');
    const concurrentRequests = document.querySelector('#cfa_concurrent_requests');
    const contextMode = document.querySelector('#cfa_context_mode');
    const recentMessageCount = document.querySelector('#cfa_recent_message_count');
    const writeChatFiles = document.querySelector('#cfa_write_chat_files');
    provider.value = settings.config.providerMode;
    prompt.value = settings.config.summaryPrompt;
    showUserName.checked = settings.config.showUserName;
    autoSummarize.checked = settings.config.autoSummarize;
    autoSummaryInterval.value = settings.config.autoSummaryInterval;
    autoSummaryInterval.disabled = !settings.config.autoSummarize;
    outputTokens.value = settings.config.maxOutputTokens;
    concurrentRequests.value = settings.config.maxConcurrentRequests;
    contextMode.value = settings.config.contextMode;
    recentMessageCount.value = settings.config.recentMessageCount;
    recentMessageCount.disabled = settings.config.contextMode !== 'recent';
    writeChatFiles.checked = settings.config.writeToChatFiles;
    provider.addEventListener('change', () => { settings.config.providerMode = provider.value; updateProviderVisibility(); save(); renderVisibleCards(); });
    document.querySelector('#cfa_api_preset').addEventListener('change', event => {
        settings.config.customPresetId = event.target.value || null; save(); showPreset(settings.config.customPresetId); renderVisibleCards();
    });
    document.querySelector('#cfa_api_new').addEventListener('click', beginBlankPreset);
    document.querySelector('#cfa_api_save').addEventListener('click', () => saveApiPresetSafely());
    document.querySelector('#cfa_api_save_as').addEventListener('click', saveApiPresetAs);
    document.querySelector('#cfa_api_delete').addEventListener('click', () => deleteCurrentPreset().catch(error => globalThis.toastr?.error(error.message)));
    document.querySelector('#cfa_fetch_models').addEventListener('click', fetchModels);
    prompt.addEventListener('input', () => { settings.config.summaryPrompt = prompt.value || DEFAULT_SUMMARY_PROMPT; save(); renderVisibleCards(); });
    showUserName.addEventListener('change', () => {
        settings.config.showUserName = showUserName.checked; save(); renderVisibleCards();
    });
    autoSummarize.addEventListener('change', () => {
        settings.config.autoSummarize = autoSummarize.checked;
        autoSummaryInterval.disabled = !autoSummarize.checked;
        if (!autoSummarize.checked) {
            for (const timer of autoSummaryTimers.values()) clearTimeout(timer);
            autoSummaryTimers.clear();
        }
        save();
    });
    autoSummaryInterval.addEventListener('change', () => {
        settings.config.autoSummaryInterval = Math.min(1000, Math.max(1, Math.round(Number(autoSummaryInterval.value) || 10)));
        autoSummaryInterval.value = settings.config.autoSummaryInterval; save();
    });
    outputTokens.addEventListener('change', () => {
        settings.config.maxOutputTokens = Math.min(65535, Math.max(64, Number(outputTokens.value) || 8096));
        outputTokens.value = settings.config.maxOutputTokens; save(); renderVisibleCards();
    });
    concurrentRequests.addEventListener('change', () => {
        settings.config.maxConcurrentRequests = Math.min(20, Math.max(1, Math.round(Number(concurrentRequests.value) || 3)));
        concurrentRequests.value = settings.config.maxConcurrentRequests;
        setMaxConcurrentRequests(settings.config.maxConcurrentRequests);
        save();
    });
    contextMode.addEventListener('change', () => {
        settings.config.contextMode = contextMode.value === 'recent' ? 'recent' : 'all';
        recentMessageCount.disabled = settings.config.contextMode !== 'recent';
        save(); renderVisibleCards();
    });
    recentMessageCount.addEventListener('change', () => {
        settings.config.recentMessageCount = Math.min(10000, Math.max(1, Math.round(Number(recentMessageCount.value) || 20)));
        recentMessageCount.value = settings.config.recentMessageCount;
        save(); renderVisibleCards();
    });
    document.querySelector('#cfa_reset_prompt').addEventListener('click', () => { settings.config.summaryPrompt = DEFAULT_SUMMARY_PROMPT; prompt.value = DEFAULT_SUMMARY_PROMPT; save(); renderVisibleCards(); });
    document.querySelector('#cfa_clear_data').addEventListener('click', async () => {
        if (await context.Popup.show.confirm(s().toolbar, s().clearConfirm)) await clearData();
    });
    document.querySelector('#cfa_abort_all').addEventListener('click', abortAllSummaryRequests);
    writeChatFiles.addEventListener('change', () => {
        settings.config.writeToChatFiles = writeChatFiles.checked;
        save();
        if (writeChatFiles.checked) { embeddedChecked.clear(); restoreEmbeddedForVisibleCards(); }
        else { embeddedObserver?.disconnect(); embeddedObserver = null; }
    });
    document.querySelector('#cfa_embed_existing').addEventListener('click', () => runStorageTask('embed'));
    document.querySelector('#cfa_rebuild_index').addEventListener('click', () => runStorageTask('rebuild'));
    document.querySelector('#cfa_clear_embedded').addEventListener('click', async () => {
        if (await context.Popup.show.confirm(s().toolbar, s().clearEmbeddedConfirm)) runStorageTask('clear');
    });
    document.querySelector('#cfa_cancel_storage').addEventListener('click', () => storageTaskController?.abort());
    if (settings.config.customPresetId) showPreset(settings.config.customPresetId);
    else beginBlankPreset();
    updateProviderVisibility();
}

function setStorageProgress(current = 0, total = 0) {
    const box = document.querySelector('.cfa-storage-box');
    box?.classList.toggle('cfa-task-running', Boolean(storageTaskController));
    const progress = document.querySelector('#cfa_storage_progress');
    if (progress) progress.textContent = total ? s().progress(current, total) : '';
}

async function getScopeFileNames(scope, signal = null) {
    if (scope.groupId) {
        const group = SillyTavern.getContext().groups?.find(item => String(item.id) === String(scope.groupId));
        return Array.isArray(group?.chats) ? group.chats.map(normalizeFileName) : [];
    }
    if (!scope.avatar) throw new Error(s().noActiveScope);
    const response = await fetch('/api/characters/chats', {
        method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ avatar_url: scope.avatar, simple: true }), signal,
    });
    if (!response.ok) throw new Error(`Unable to list chats (${response.status}).`);
    return (await response.json()).map(item => normalizeFileName(item.file_id ?? item.file_name));
}

function runStorageTask(mode) {
    if (storageTaskPromise) return storageTaskPromise;
    storageTaskController = new AbortController();
    const signal = storageTaskController.signal;
    const taskEpoch = dataEpoch;
    storageTaskPromise = (async () => {
      setStorageProgress();
      try {
        const scope = currentScope();
        await recordStore.loadScope(scope.key);
        if (taskEpoch !== dataEpoch) throw new DOMException('The operation was aborted.', 'AbortError');
        if (mode === 'embed' || mode === 'clear') {
            signal.throwIfAborted();
            const fileName = normalizeFileName(SillyTavern.getContext().chatId);
            if (!fileName) throw new Error(s().noActiveChat);
            if (mode === 'embed') {
                const record = recordFor(scope.key, fileName);
                if (!record) throw new Error(s().noStoredRecord);
                signal.throwIfAborted();
                await writeEmbeddedRecord(scope.key, fileName, record);
            } else {
                signal.throwIfAborted();
                await removeEmbeddedRecord(scope.key, fileName);
            }
            globalThis.toastr?.success(s().storageDone);
            return;
        }
        const files = await getScopeFileNames(scope, signal);
        for (let index = 0; index < files.length; index++) {
            signal.throwIfAborted();
            if (taskEpoch !== dataEpoch) throw new DOMException('The operation was aborted.', 'AbortError');
            setStorageProgress(index + 1, files.length);
            const fileName = files[index];
            if (mode === 'rebuild') {
                const messages = await readChat(fileName, scope, signal);
                signal.throwIfAborted();
                if (taskEpoch !== dataEpoch) throw new DOMException('The operation was aborted.', 'AbortError');
                await restoreEmbeddedRecord(fileName, scope, messages, { render: false });
            }
        }
        globalThis.toastr?.success(s().storageDone);
    } catch (error) {
        if (error?.name === 'AbortError') globalThis.toastr?.info(s().storageCancelled);
        else { console.error('[Chat File AI] Storage task failed:', error); globalThis.toastr?.error(error.message); }
      } finally {
        storageTaskController = null;
        setStorageProgress();
        renderVisibleCards();
      }
    })().finally(() => { storageTaskPromise = null; });
    return storageTaskPromise;
}

async function markCurrentStale() {
    const ctx = SillyTavern.getContext();
    const scope = currentScope();
    await recordStore.loadScope(scope.key);
    if (!initialized) return;
    const record = recordFor(scope.key, ctx.chatId);
    if (record) {
        record.stale = true;
        await saveRecord(scope.key, ctx.chatId, record, { embed: false });
        renderVisibleCards();
    }
}

function scheduleAutoSummary(_messageId, type) {
    if (!settings.config.autoSummarize || ['swipe', 'continue', 'append', 'appendFinal', 'extension'].includes(type)) return;
    const ctx = SillyTavern.getContext();
    const scope = currentScope();
    const fileName = normalizeFileName(ctx.chatId);
    if (!fileName) return;
    const timerKey = `${scope.key}\n${fileName}`;
    clearTimeout(autoSummaryTimers.get(timerKey));
    const timer = setTimeout(async () => {
        autoSummaryTimers.delete(timerKey);
        if (!initialized || !settings.config.autoSummarize) return;
        const latestContext = SillyTavern.getContext();
        const latestScope = currentScope();
        if (latestScope.key !== scope.key || normalizeFileName(latestContext.chatId) !== fileName) return;
        await new Promise(resolve => setTimeout(resolve, 750));
        if (!initialized) return;
        let rawMessages;
        try { rawMessages = await readChat(fileName, scope); }
        catch (error) { console.warn('[Chat File AI] Could not read chat for automatic summary:', error); return; }
        const messageCount = countConversationLayers(rawMessages, { skipHeader: !scope.groupId });
        await recordStore.loadScope(scope.key);
        if (!initialized) return;
        const record = recordFor(scope.key, fileName);
        if (messageCount < Number(record?.autoRetryAfterCount ?? 0)) return;
        if (!shouldAutoSummarize({
            messageCount,
            lastSummaryCount: record?.messageCountAtGeneration,
            interval: settings.config.autoSummaryInterval,
            hasSummary: Boolean(record?.summary),
        })) return;
        try { await generateFor(fileName, null, null, scope); }
        catch (error) {
            if (error?.name !== 'AbortError') {
                console.warn('[Chat File AI] Automatic summary failed:', error);
                const failureRecord = recordFor(scope.key, fileName, true);
                const failures = Math.min(5, Math.max(0, Number(failureRecord.autoFailureCount) || 0) + 1);
                failureRecord.autoFailureCount = failures;
                failureRecord.autoRetryAfterCount = getAutoRetryAfterCount(
                    messageCount,
                    settings.config.autoSummaryInterval,
                    failures,
                );
                try { await saveRecord(scope.key, fileName, failureRecord, { embed: false }); }
                catch (saveError) { console.warn('[Chat File AI] Could not store automatic-summary backoff:', saveError); }
            }
        }
    }, 2000);
    autoSummaryTimers.set(timerKey, timer);
}

function bindEvents() {
    const events = context.eventTypes;
    const bind = (event, handler) => {
        if (!event) return;
        context.eventSource.on(event, handler);
        eventBindings.push([event, handler]);
    };
    for (const event of [events.MESSAGE_SENT, events.MESSAGE_RECEIVED, events.MESSAGE_EDITED, events.MESSAGE_DELETED, events.MESSAGE_UPDATED, events.MESSAGE_SWIPED]) {
        bind(event, markCurrentStale);
    }
    bind(events.MESSAGE_RECEIVED, scheduleAutoSummary);
    bind(events.CHAT_RENAMED, data => {
        if (dataResetting) return;
        const scopeKey = getScopeKey({ groupId: data?.groupId, avatar: data?.avatarId });
        void recordStore.rename(scopeKey, data?.oldFileName, data?.newFileName).catch(error => console.warn('[Chat File AI] IndexedDB rename failed:', error));
    });
    bind(events.CHARACTER_RENAMED, (...args) => {
        if (dataResetting) return;
        const data = args[0] && typeof args[0] === 'object' ? args[0] : null;
        const oldAvatar = String(data?.oldAvatar ?? data?.old_avatar ?? args[0] ?? '').trim();
        const newAvatar = String(data?.newAvatar ?? data?.new_avatar ?? args[1] ?? '').trim();
        if (!oldAvatar || !newAvatar || oldAvatar === '[object Object]' || newAvatar === '[object Object]') return;
        const oldScope = getScopeKey({ avatar: oldAvatar });
        const newScope = getScopeKey({ avatar: newAvatar });
        void recordStore.moveScope(oldScope, newScope).then(() => {
            if (metadataCache.has(oldScope)) metadataCache.set(newScope, metadataCache.get(oldScope));
            if (metadataByScope.has(oldScope)) metadataByScope.set(newScope, metadataByScope.get(oldScope));
            metadataCache.delete(oldScope); metadataByScope.delete(oldScope);
            renderVisibleCards();
        }).catch(error => console.warn('[Chat File AI] Character scope migration failed:', error));
    });
    bind(events.CHARACTER_DELETED, (...args) => {
        if (dataResetting) return;
        const data = args[0] && typeof args[0] === 'object' ? args[0] : null;
        const avatar = String(data?.character?.avatar ?? data?.avatar ?? data?.avatar_url ?? data?.oldAvatar
            ?? args.find(value => typeof value === 'string' && /\.[a-z0-9]+$/i.test(value)) ?? '').trim();
        if (!avatar) return;
        const scopeKey = getScopeKey({ avatar });
        void recordStore.deleteScope(scopeKey).then(() => {
            metadataCache.delete(scopeKey); metadataByScope.delete(scopeKey);
        }).catch(error => console.warn('[Chat File AI] Character cache cleanup failed:', error));
    });
    bind(events.GROUP_CHAT_DELETED, fileName => {
        if (dataResetting) return;
        const scope = currentScope();
        if (!scope.groupId) return;
        const group = SillyTavern.getContext().groups?.find(item => String(item.id) === String(scope.groupId));
        if (!group || group.chats?.map(normalizeFileName).includes(normalizeFileName(fileName))) return;
        void recordStore.delete(scope.key, fileName).catch(error => console.warn('[Chat File AI] Group chat cache cleanup failed:', error));
    });
}

function unbindEvents() {
    for (const [event, handler] of eventBindings.splice(0)) context.eventSource.removeListener(event, handler);
}

async function clearData() {
    if (dataResetting) return;
    dataResetting = true;
    dataEpoch += 1;
    backgroundReadController.abort();
    storageTaskController?.abort();
    for (const controller of activeControllers.values()) controller.abort();
    await Promise.allSettled([
        ...activeJobs.values(),
        ...(storageTaskPromise ? [storageTaskPromise] : []),
        ...(userNamePumpPromise ? [userNamePumpPromise] : []),
    ]);
    userNameQueue.length = 0;
    userNameJobs.clear();
    embeddedChecked.clear();
    settings.config.writeToChatFiles = false;
    const writeToggle = document.querySelector('#cfa_write_chat_files');
    if (writeToggle) writeToggle.checked = false;
    embeddedObserver?.disconnect(); embeddedObserver = null;
    for (const timer of autoSummaryTimers.values()) clearTimeout(timer);
    autoSummaryTimers.clear();
    try {
        await recordStore.clearUser();
        metadataCache.clear(); metadataByScope.clear();
        save(); renderVisibleCards();
        globalThis.toastr?.success(s().cleaned);
    } finally {
        backgroundReadController = new AbortController();
        dataResetting = false;
    }
}

export async function onActivate() {
    if (initialized) return;
    const activationEpoch = ++lifecycleEpoch;
    initialized = true;
    const activationContext = SillyTavern.getContext();
    const activationSettings = normalizeSettings(activationContext.extensionSettings[MODULE_NAME]);
    const thisActivationController = new AbortController();
    activationController = thisActivationController;
    let activationStore;
    try {
        const handle = await getUserHandle({ headers: activationContext.getRequestHeaders(), signal: thisActivationController.signal });
        if (!initialized || activationEpoch !== lifecycleEpoch) return;
        activationStore = new IndexedRecordStore(handle);
        await activationStore.open();
    } catch (error) {
        if (activationEpoch !== lifecycleEpoch) {
            activationStore?.close();
            return;
        }
        initialized = false;
        console.error('[Chat File AI] IndexedDB initialization failed:', error);
        globalThis.toastr?.error(s().storageError);
        return;
    }
    if (!initialized || activationEpoch !== lifecycleEpoch) {
        activationStore?.close();
        return;
    }
    context = activationContext;
    settings = activationSettings;
    recordStore = activationStore;
    backgroundReadController = new AbortController();
    dataResetting = false;
    setMaxConcurrentRequests(settings.config.maxConcurrentRequests);
    if (activationController === thisActivationController) activationController = null;
    context.extensionSettings[MODULE_NAME] = settings;
    save();
    await renderSettings(activationEpoch);
    if (!initialized || activationEpoch !== lifecycleEpoch) return;
    installFetchWrapper();
    bindEvents();
    startObserver();
}

export async function onDisable() {
    ++lifecycleEpoch;
    dataEpoch += 1;
    initialized = false;
    const storeToClose = recordStore;
    const jobsToWait = [
        ...activeJobs.values(),
        ...(storageTaskPromise ? [storageTaskPromise] : []),
        ...(userNamePumpPromise ? [userNamePumpPromise] : []),
    ];
    activationController?.abort();
    activationController = null;
    batchController?.abort();
    storageTaskController?.abort();
    backgroundReadController.abort();
    for (const controller of activeControllers.values()) controller.abort();
    embeddedObserver?.disconnect(); embeddedObserver = null;
    for (const timer of autoSummaryTimers.values()) clearTimeout(timer);
    autoSummaryTimers.clear();
    userNameQueue.length = 0;
    userNameJobs.clear();
    embeddedChecked.clear();
    stopObserver();
    uninstallFetchWrapper();
    unbindEvents();
    document.querySelector('#cfa_settings')?.remove();
    await Promise.allSettled(jobsToWait);
    await storeToClose?.drain();
    storeToClose?.close();
    if (recordStore === storeToClose) recordStore = null;
}

export async function onClean() {
    context ??= SillyTavern.getContext();
    const current = normalizeSettings(context.extensionSettings[MODULE_NAME]);
    const secretIds = [...new Set(current.apiPresets.map(preset => preset.secretId).filter(Boolean))];
    for (const id of secretIds) {
        try { await deleteApiSecret(id); }
        catch (error) { console.warn('[Chat File AI] Could not remove API secret during cleanup:', error); }
    }
    if (initialized) await onDisable();
    let store = recordStore;
    if (!store) {
        try { store = new IndexedRecordStore(await getUserHandle()); }
        catch (error) { console.warn('[Chat File AI] Could not identify the current user during cleanup:', error); }
    }
    if (store) {
        try { await store.clearUser(); }
        catch (error) { console.warn('[Chat File AI] Could not clear the current user\'s IndexedDB records:', error); }
        store.close();
    }
    delete context.extensionSettings[MODULE_NAME];
    settings = normalizeSettings(null);
    recordStore = null;
    metadataCache.clear(); metadataByScope.clear();
    document.querySelector('#cfa_settings')?.remove();
}
