import { normalizeFileName } from './core.js';

const DATABASE_NAME = 'SillyTavern-Chat-File-Assistant-v1';
const DATABASE_VERSION = 1;
const STORE_NAME = 'records';

export class IndexedRecordStore {
    constructor(userHandle, indexedDb = globalThis.indexedDB) {
        this.userHandle = String(userHandle || 'default-user');
        this.indexedDb = indexedDb;
        this.database = null;
        this.records = {};
        this.loadedScopes = new Set();
    }

    async open() {
        if (this.database) return this.database;
        if (!this.indexedDb) throw new Error('IndexedDB is unavailable.');
        this.database = await new Promise((resolve, reject) => {
            const request = this.indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
            request.onupgradeneeded = () => {
                const database = request.result;
                const store = database.objectStoreNames.contains(STORE_NAME)
                    ? request.transaction.objectStore(STORE_NAME)
                    : database.createObjectStore(STORE_NAME, { keyPath: 'id' });
                if (!store.indexNames.contains('userScope')) store.createIndex('userScope', ['userHandle', 'scopeKey']);
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return this.database;
    }

    id(scopeKey, fileName) {
        return `${this.userHandle}\n${scopeKey}\n${normalizeFileName(fileName)}`;
    }

    async transaction(mode, callback) {
        const database = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, mode);
            const store = transaction.objectStore(STORE_NAME);
            let result;
            try { result = callback(store, transaction); }
            catch (error) { reject(error); return; }
            transaction.oncomplete = () => resolve(result);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
        });
    }

    async loadScope(scopeKey, { force = false } = {}) {
        if (!force && this.loadedScopes.has(scopeKey)) return this.records[scopeKey] ?? {};
        const result = {};
        await this.transaction('readonly', store => {
            const index = store.index('userScope');
            const request = index.openCursor(IDBKeyRange.only([this.userHandle, scopeKey]));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                result[cursor.value.fileName] = cursor.value.record;
                cursor.continue();
            };
        });
        this.records[scopeKey] = result;
        this.loadedScopes.add(scopeKey);
        return result;
    }

    scope(scopeKey, create = false) {
        if (create) this.records[scopeKey] ??= {};
        return this.records[scopeKey];
    }

    record(scopeKey, fileName, create = false) {
        const scope = this.scope(scopeKey, create);
        const key = normalizeFileName(fileName);
        if (create) scope[key] ??= {};
        return scope?.[key];
    }

    async put(scopeKey, fileName, record) {
        const key = normalizeFileName(fileName);
        await this.transaction('readwrite', store => store.put({
            id: this.id(scopeKey, key), userHandle: this.userHandle, scopeKey, fileName: key, record,
        }));
        this.scope(scopeKey, true)[key] = record;
        return record;
    }

    async putMany(scopeKey, entries) {
        const normalized = entries.map(([fileName, record]) => [normalizeFileName(fileName), record]);
        await this.transaction('readwrite', store => {
            for (const [fileName, record] of normalized) {
                store.put({
                    id: this.id(scopeKey, fileName), userHandle: this.userHandle, scopeKey, fileName, record,
                });
            }
        });
        const scope = this.scope(scopeKey, true);
        for (const [fileName, record] of normalized) scope[fileName] = record;
        return normalized.length;
    }

    async rename(scopeKey, oldFileName, newFileName) {
        await this.loadScope(scopeKey);
        const oldKey = normalizeFileName(oldFileName);
        const newKey = normalizeFileName(newFileName);
        const record = this.record(scopeKey, oldKey);
        if (!record || oldKey === newKey) return;
        await this.put(scopeKey, newKey, record);
        await this.delete(scopeKey, oldKey);
    }

    async delete(scopeKey, fileName) {
        const key = normalizeFileName(fileName);
        await this.transaction('readwrite', store => store.delete(this.id(scopeKey, key)));
        const scope = this.scope(scopeKey);
        if (scope) delete scope[key];
    }

    async clearUser() {
        const ids = [];
        await this.transaction('readwrite', store => {
            const request = store.openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                if (cursor.value.userHandle === this.userHandle) {
                    ids.push(cursor.primaryKey);
                    cursor.delete();
                }
                cursor.continue();
            };
        });
        this.records = {};
        this.loadedScopes.clear();
        return ids.length;
    }

    close() {
        this.database?.close();
        this.database = null;
    }
}
