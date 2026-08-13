export const SCHEMA_VERSION = 1;
export const CHAT_METADATA_KEY = 'chat_file_assistant';

export const DEFAULT_SUMMARY_PROMPT = `请忠实总结所提供的聊天记录，概括主要人物、重要事件、关系或目标的进展，以及尚未解决的事项。使用聊天主要语言。总结控制在约 200 个英文词或等量中文以内。同时提出一个不超过 24 个字符、具体且便于辨认的内容标题。`;

export const DEFAULT_SETTINGS = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    config: {
        providerMode: 'current',
        customPresetId: null,
        summaryPrompt: DEFAULT_SUMMARY_PROMPT,
        maxOutputTokens: 8096,
        maxConcurrentRequests: 3,
        contextMode: 'all',
        recentMessageCount: 20,
        showUserName: true,
        autoSummarize: true,
        autoSummaryInterval: 10,
        writeToChatFiles: false,
    },
    apiPresets: [],
});

export function cloneDefaultSettings() {
    return structuredClone(DEFAULT_SETTINGS);
}

export function normalizeSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    const normalized = cloneDefaultSettings();
    if (Number(source.schemaVersion) !== SCHEMA_VERSION) return normalized;
    const sourceConfig = source.config && typeof source.config === 'object' ? source.config : {};
    for (const key of Object.keys(normalized.config)) {
        if (Object.hasOwn(sourceConfig, key)) normalized.config[key] = sourceConfig[key];
    }
    normalized.apiPresets = Array.isArray(source.apiPresets)
        ? source.apiPresets.map(sanitizeApiPreset).filter(Boolean)
        : [];
    normalized.config.providerMode = normalized.config.providerMode === 'custom' ? 'custom' : 'current';
    normalized.config.customPresetId = typeof normalized.config.customPresetId === 'string' ? normalized.config.customPresetId : null;
    if (!normalized.apiPresets.some(preset => preset.id === normalized.config.customPresetId)) {
        normalized.config.customPresetId = normalized.apiPresets[0]?.id ?? null;
    }
    normalized.config.summaryPrompt = String(normalized.config.summaryPrompt || DEFAULT_SUMMARY_PROMPT);
    normalized.config.maxOutputTokens = clampInteger(normalized.config.maxOutputTokens, 64, 65535, 8096);
    normalized.config.maxConcurrentRequests = clampInteger(normalized.config.maxConcurrentRequests, 1, 20, 3);
    normalized.config.contextMode = normalized.config.contextMode === 'recent' ? 'recent' : 'all';
    normalized.config.recentMessageCount = clampInteger(normalized.config.recentMessageCount, 1, 10000, 20);
    normalized.config.showUserName = normalized.config.showUserName !== false;
    normalized.config.autoSummarize = normalized.config.autoSummarize !== false;
    normalized.config.autoSummaryInterval = clampInteger(normalized.config.autoSummaryInterval, 1, 1000, 10);
    normalized.config.writeToChatFiles = normalized.config.writeToChatFiles === true;
    return normalized;
}

function sanitizeApiPreset(value) {
    if (!value || typeof value !== 'object') return null;
    const id = String(value.id ?? '').trim();
    const name = String(value.name ?? '').trim();
    const url = normalizeApiBaseUrl(value.url);
    const model = String(value.model ?? '').trim();
    if (!id || !name) return null;
    return {
        id,
        name,
        url,
        model,
        secretId: typeof value.secretId === 'string' && value.secretId ? value.secretId : null,
        createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    };
}

export function normalizeApiBaseUrl(value) {
    const text = String(value ?? '').trim().replace(/\/+$/, '');
    if (!text) return '';
    try {
        const url = new URL(text);
        if (!['http:', 'https:'].includes(url.protocol)) return '';
        if (url.username || url.password || url.search) return '';
        return url.toString().replace(/\/$/, '');
    } catch {
        return '';
    }
}

function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

export function getScopeKey({ groupId, avatar }) {
    return groupId ? `group:${groupId}` : `character:${avatar ?? ''}`;
}

export function getFingerprint(meta = {}) {
    return {
        lastMes: meta.last_mes ?? meta.lastMes ?? null,
        messageCount: Number(meta.message_count ?? meta.messageCount ?? 0),
        fileSize: String(meta.file_size ?? meta.fileSize ?? ''),
    };
}

export function fingerprintsEqual(left, right) {
    return Boolean(left && right)
        && String(left.lastMes ?? '') === String(right.lastMes ?? '')
        && Number(left.messageCount ?? 0) === Number(right.messageCount ?? 0);
}

export function isRecordStale(record, fingerprint, promptHash) {
    if (!record?.summary) return true;
    return record.stale === true || !fingerprintsEqual(record.fingerprint, fingerprint) || record.promptHash !== promptHash;
}

export function normalizeFileName(value, { physical = false } = {}) {
    const fileName = String(value ?? '');
    return physical ? fileName.replace(/\.jsonl$/i, '') : fileName;
}

export function parseScopeKey(scopeKey) {
    const text = String(scopeKey ?? '');
    if (text.startsWith('group:')) return { groupId: text.slice(6), avatar: null };
    if (text.startsWith('character:')) return { groupId: null, avatar: text.slice(10) };
    return { groupId: null, avatar: null };
}

export function getChatContentGuard(messages = [], { skipHeader = false } = {}) {
    const content = skipHeader ? messages.slice(1) : messages;
    return {
        messageCount: countConversationLayers(messages, { skipHeader }),
        contentHash: simpleHash(JSON.stringify(content)),
    };
}

export function chatGuardsEqual(left, right) {
    return Boolean(left && right)
        && Number(left.messageCount) === Number(right.messageCount)
        && String(left.contentHash) === String(right.contentHash);
}

export function prepareStoredRecord(record, { now = new Date().toISOString(), recordId } = {}) {
    const copy = structuredClone(record ?? {});
    copy.recordId = String(copy.recordId || recordId || '');
    copy.updatedAt = now;
    return copy;
}

export function mergeStoredRecords(localRecord, embeddedRecord) {
    if (!localRecord) return embeddedRecord ? structuredClone(embeddedRecord) : undefined;
    if (!embeddedRecord) return structuredClone(localRecord);
    const localTime = Date.parse(localRecord.updatedAt ?? localRecord.generatedAt ?? 0) || 0;
    const embeddedTime = Date.parse(embeddedRecord.updatedAt ?? embeddedRecord.generatedAt ?? 0) || 0;
    return structuredClone(embeddedTime > localTime ? embeddedRecord : localRecord);
}

export function getEmbeddedRecord(messages = []) {
    const value = messages?.[0]?.chat_metadata?.[CHAT_METADATA_KEY];
    return value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : undefined;
}

export function simpleHash(value) {
    let hash = 2166136261;
    const text = String(value ?? '');
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function cleanTitle(value) {
    return String(value ?? '')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[.\s·—_-]+|[.\s·—_-]+$/g, '')
        .slice(0, 48)
        .trim();
}

export function formatAlias(dateValue, title) {
    const clean = cleanTitle(title);
    if (!clean) return '';
    const date = parseDateCandidate(dateValue);
    return date ? `${clean} · ${formatLocalDate(date)}` : clean;
}

export function formatDisplayAlias(alias, userName, showUserName = true) {
    const base = String(alias ?? '').trim();
    const user = String(userName ?? '').replace(/[\r\n·]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!base || !showUserName || !user) return base;
    const dated = base.match(/^(.*?)\s*·\s*(20\d{2}-\d{2}-\d{2})$/);
    return dated ? `${dated[1].trim()} · ${user} · ${dated[2]}` : `${base} · ${user}`;
}

export function getChatUserName(messages = [], { skipHeader = false } = {}) {
    const list = skipHeader ? messages.slice(1) : messages;
    const userMessage = list.findLast(message => message?.is_user === true && !message?.is_system && String(message?.name ?? '').trim());
    return String(userMessage?.name ?? '').trim();
}

export function countConversationLayers(messages = [], { skipHeader = false } = {}) {
    const list = skipHeader ? messages.slice(1) : messages;
    return list.filter(message => message && !message.is_system).length;
}

export function shouldAutoSummarize({ messageCount, lastSummaryCount = 0, interval = 10, hasSummary = false } = {}) {
    const count = Math.max(0, Number(messageCount) || 0);
    const last = Math.max(0, Number(lastSummaryCount) || 0);
    const step = Math.max(1, Number(interval) || 10);
    return count >= step && (hasSummary ? count - last >= step : count >= step);
}

export function getAutoRetryAfterCount(messageCount, interval = 10, failureCount = 1) {
    const count = Math.max(0, Number(messageCount) || 0);
    const step = Math.max(1, Number(interval) || 10);
    const failures = Math.max(1, Math.round(Number(failureCount) || 1));
    return count + step * (2 ** Math.min(3, failures - 1));
}

export function chooseChatDate({ messages = [], fileName = '', lastMes = null } = {}) {
    const headerDate = messages[0]?.create_date ?? messages[0]?.createDate;
    const firstMessageDate = messages.find(message => message?.send_date)?.send_date;
    return parseDateCandidate(headerDate)
        ?? parseDateFromFilename(fileName)
        ?? parseDateCandidate(firstMessageDate)
        ?? parseDateCandidate(lastMes)
        ?? null;
}

export function parseDateFromFilename(fileName) {
    const text = String(fileName ?? '');
    const match = text.match(/(20\d{2})[-_](\d{1,2})[-_](\d{1,2})/);
    if (!match) return null;
    return parseDateCandidate(`${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}T00:00:00`);
}

function parseDateCandidate(value) {
    if (value === null || value === undefined || value === '') return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date;
}

function formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function parseModelResult(raw) {
    if (raw && typeof raw === 'object') return validateModelResult(raw);
    let text = String(raw ?? '').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('The model did not return a JSON object.');
    let parsed;
    try {
        parsed = JSON.parse(text.slice(start, end + 1));
    } catch (error) {
        throw new Error('The model returned invalid JSON.', { cause: error });
    }
    return validateModelResult(parsed);
}

function validateModelResult(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || typeof parsed.summary !== 'string' || typeof parsed.title !== 'string') {
        throw new Error('The model response must contain string summary and title fields.');
    }
    const summary = parsed.summary.trim();
    const title = cleanTitle(parsed.title);
    if (!summary || !title) throw new Error('The model response must contain non-empty summary and title fields.');
    if ([...title].length > 24) throw new Error('The model response title must be no longer than 24 characters.');
    return { summary, title };
}

export function serializeMessages(messages = [], { skipHeader = false } = {}) {
    return getSerializableEntries(messages, { skipHeader }).map(entry => formatSerializableEntry(entry)).join('\n\n');
}

export function serializeRecentMessages(messages = [], {
    skipHeader = false,
    mode = 'all',
    maxLayers = 20,
} = {}) {
    let entries = getSerializableEntries(messages, { skipHeader });
    if (mode === 'recent') {
        let layers = 0;
        let start = entries.length;
        const limit = Math.max(1, Math.round(Number(maxLayers) || 20));
        for (let index = entries.length - 1; index >= 0; index--) {
            start = index;
            if (!entries[index].message.is_system && ++layers >= limit) break;
        }
        entries = entries.slice(start);
    }

    return entries.map(entry => formatSerializableEntry(entry)).join('\n\n');
}

function getSerializableEntries(messages, { skipHeader }) {
    const list = skipHeader ? messages.slice(1) : messages;
    return list
        .filter(message => message)
        .map((message, index) => ({ message, floor: index + 1 }));
}

function getMessageText(message) {
    const primary = String(message?.mes ?? '').trim();
    return primary || String(message?.content ?? '').trim();
}

function formatSerializableEntry({ message, floor }, textOverride) {
    const role = message.is_system ? 'SYSTEM-DATA' : message.is_user ? 'USER' : 'ASSISTANT';
    const name = String(message.name ?? message.character_name ?? role).replace(/[\r\n\]]/g, ' ');
    const text = textOverride === undefined ? getMessageText(message) : String(textOverride ?? '').trim();
    return `[Floor ${floor} | ${role} | ${name}]\n${text}`;
}

export function resolveAcceptedAlias(record, suggestedTitle) {
    const acceptedAlias = String(record?.acceptedAlias ?? '').trim();
    const previousSuggestion = String(record?.suggestedTitle ?? '').trim();
    return !acceptedAlias || acceptedAlias === previousSuggestion ? suggestedTitle : acceptedAlias;
}

export function matchesAllFragments(record, query) {
    const fragments = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!fragments.length) return true;
    const haystack = [record?.file_name, record?.acceptedAlias, record?.suggestedTitle, record?.userName, record?.summary]
        .filter(Boolean).join('\n').toLowerCase();
    return fragments.every(fragment => haystack.includes(fragment));
}

export function mergeSearchResults(nativeResults, allMetadata, scopeRecords, query) {
    const byName = new Map((nativeResults ?? []).map(item => [normalizeFileName(item.file_name), item]));
    for (const meta of allMetadata ?? []) {
        const name = normalizeFileName(meta.file_name);
        const record = scopeRecords?.[name];
        if (record && matchesAllFragments({ file_name: name, ...record }, query) && !byName.has(name)) {
            byName.set(name, meta);
        }
    }
    return [...byName.values()];
}
