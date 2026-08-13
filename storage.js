const DATABASE_NAME = 'SillyTavern-Chat-File-Assistant-v1';
const DATABASE_VERSION = 1;
const STORE_NAME = 'records';

export class IndexedRecordStore {
    constructor(userHandle, indexedDb = globalThis.indexedDB) {
        this.userHandle = String(userHandle ?? '').trim();
        if (!this.userHandle) throw new Error('A SillyTavern user handle is required for IndexedDB isolation.');
        this.indexedDb = indexedDb;
        this.database = null;
        this.records = Object.create(null);
        this.loadedScopes = new Set();
        this.mutationTail = Promise.resolve();
        this.cacheEpoch = 0;
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
            request.onblocked = () => reject(new Error('IndexedDB upgrade was blocked by another open page.'));
        });
        this.database.onversionchange = () => {
            this.database?.close();
            this.database = null;
        };
        return this.database;
    }

    id(scopeKey, fileName) {
        return `${this.userHandle}\n${scopeKey}\n${String(fileName ?? '')}`;
    }

    async transaction(mode, callback) {
        const database = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, mode);
            const store = transaction.objectStore(STORE_NAME);
            let result;
            let callbackError = null;
            let settled = false;
            const rejectOnce = error => {
                if (settled) return;
                settled = true;
                reject(error);
            };
            transaction.oncomplete = () => {
                if (settled) return;
                settled = true;
                resolve(result);
            };
            transaction.onerror = () => rejectOnce(callbackError || transaction.error);
            transaction.onabort = () => rejectOnce(callbackError || transaction.error || new Error('IndexedDB transaction aborted.'));
            try { result = callback(store, transaction); }
            catch (error) {
                callbackError = error;
                try { transaction.abort(); }
                catch { rejectOnce(error); }
            }
        });
    }

    enqueueMutation(callback) {
        const operation = this.mutationTail.catch(() => {}).then(callback);
        this.mutationTail = operation;
        return operation;
    }

    async loadScope(scopeKey, { force = false } = {}) {
        if (!force && this.loadedScopes.has(scopeKey)) return this.records[scopeKey] ?? {};
        const cacheEpoch = this.cacheEpoch;
        const result = Object.create(null);
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
        if (cacheEpoch === this.cacheEpoch) {
            this.records[scopeKey] = result;
            this.loadedScopes.add(scopeKey);
        }
        return result;
    }

    scope(scopeKey, create = false) {
        if (create && !Object.hasOwn(this.records, scopeKey)) this.records[scopeKey] = Object.create(null);
        return this.records[scopeKey];
    }

    record(scopeKey, fileName, create = false) {
        const scope = this.scope(scopeKey, create);
        const key = String(fileName ?? '');
        if (create && !Object.hasOwn(scope, key)) scope[key] = {};
        return scope?.[key];
    }

    async put(scopeKey, fileName, record) {
        const key = String(fileName ?? '');
        return this.enqueueMutation(async () => {
            await this.transaction('readwrite', store => store.put({
                id: this.id(scopeKey, key), userHandle: this.userHandle, scopeKey, fileName: key, record,
            }));
            this.scope(scopeKey, true)[key] = record;
            return record;
        });
    }

    async putMany(scopeKey, entries) {
        const normalized = entries.map(([fileName, record]) => [String(fileName ?? ''), record]);
        return this.enqueueMutation(async () => {
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
        });
    }

    async rename(scopeKey, oldFileName, newFileName) {
        await this.loadScope(scopeKey);
        const oldKey = String(oldFileName ?? '');
        const newKey = String(newFileName ?? '');
        return this.enqueueMutation(async () => {
            const record = this.record(scopeKey, oldKey);
            if (!record || oldKey === newKey) return;
            await this.transaction('readwrite', store => {
                store.put({
                    id: this.id(scopeKey, newKey), userHandle: this.userHandle, scopeKey, fileName: newKey, record,
                });
                store.delete(this.id(scopeKey, oldKey));
            });
            const scope = this.scope(scopeKey, true);
            scope[newKey] = record;
            delete scope[oldKey];
        });
    }

    async moveScope(oldScopeKey, newScopeKey) {
        if (!oldScopeKey || !newScopeKey || oldScopeKey === newScopeKey) return 0;
        await Promise.all([this.loadScope(oldScopeKey), this.loadScope(newScopeKey)]);
        return this.enqueueMutation(async () => {
            const moved = Object.entries(this.scope(oldScopeKey) ?? {});
            await this.transaction('readwrite', store => {
                for (const [fileName, record] of moved) {
                    store.put({
                        id: this.id(newScopeKey, fileName), userHandle: this.userHandle, scopeKey: newScopeKey, fileName, record,
                    });
                    store.delete(this.id(oldScopeKey, fileName));
                }
            });
            const target = this.scope(newScopeKey, true);
            for (const [fileName, record] of moved) target[fileName] = record;
            delete this.records[oldScopeKey];
            this.loadedScopes.delete(oldScopeKey);
            this.loadedScopes.add(newScopeKey);
            return moved.length;
        });
    }

    async deleteScope(scopeKey) {
        return this.enqueueMutation(async () => {
            let deleted = 0;
            await this.transaction('readwrite', store => {
                const index = store.index('userScope');
                const request = index.openCursor(IDBKeyRange.only([this.userHandle, scopeKey]));
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) return;
                    deleted += 1;
                    cursor.delete();
                    cursor.continue();
                };
            });
            delete this.records[scopeKey];
            this.loadedScopes.delete(scopeKey);
            return deleted;
        });
    }

    async delete(scopeKey, fileName) {
        const key = String(fileName ?? '');
        return this.enqueueMutation(async () => {
            await this.transaction('readwrite', store => store.delete(this.id(scopeKey, key)));
            const scope = this.scope(scopeKey);
            if (scope) delete scope[key];
        });
    }

    async clearUser() {
        this.cacheEpoch += 1;
        return this.enqueueMutation(async () => {
            let deleted = 0;
            await this.transaction('readwrite', store => {
                const request = store.openCursor();
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor) return;
                    if (cursor.value.userHandle === this.userHandle) {
                        deleted += 1;
                        cursor.delete();
                    }
                    cursor.continue();
                };
            });
            this.records = Object.create(null);
            this.loadedScopes.clear();
            return deleted;
        });
    }

    async drain() {
        await this.mutationTail.catch(() => {});
    }

    close() {
        this.database?.close();
        this.database = null;
    }
}
