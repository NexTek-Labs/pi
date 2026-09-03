import type { StorageBackend, StorageTransaction } from "../../src/storage/types.ts";

/**
 * In-memory StorageBackend for contract tests. Values are structured-cloned on the
 * way in and out so a test cannot mutate the store through a returned reference,
 * which is also how IndexedDB behaves.
 */
export class MemoryStorageBackend implements StorageBackend {
	private readonly stores = new Map<string, Map<string, unknown>>();

	private store(name: string): Map<string, unknown> {
		let store = this.stores.get(name);
		if (!store) {
			store = new Map();
			this.stores.set(name, store);
		}
		return store;
	}

	async get<T = unknown>(storeName: string, key: string): Promise<T | null> {
		const value = this.store(storeName).get(key);
		return value === undefined ? null : (structuredClone(value) as T);
	}

	async set<T = unknown>(storeName: string, key: string, value: T): Promise<void> {
		this.store(storeName).set(key, structuredClone(value));
	}

	async delete(storeName: string, key: string): Promise<void> {
		this.store(storeName).delete(key);
	}

	async keys(storeName: string, prefix?: string): Promise<string[]> {
		const keys = Array.from(this.store(storeName).keys());
		return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
	}

	async getAllFromIndex<T = unknown>(storeName: string, _indexName: string, direction?: "asc" | "desc"): Promise<T[]> {
		const values = Array.from(this.store(storeName).values()).map((v) => structuredClone(v) as T);
		return direction === "desc" ? values.reverse() : values;
	}

	async clear(storeName: string): Promise<void> {
		this.store(storeName).clear();
	}

	async has(storeName: string, key: string): Promise<boolean> {
		return this.store(storeName).has(key);
	}

	async transaction<T>(
		_storeNames: string[],
		_mode: "readonly" | "readwrite",
		operation: (tx: StorageTransaction) => Promise<T>,
	): Promise<T> {
		return operation({
			get: (storeName, key) => this.get(storeName, key),
			set: (storeName, key, value) => this.set(storeName, key, value),
			delete: (storeName, key) => this.delete(storeName, key),
		});
	}

	async getQuotaInfo(): Promise<{ usage: number; quota: number; percent: number }> {
		return { usage: 0, quota: 0, percent: 0 };
	}

	async requestPersistence(): Promise<boolean> {
		return true;
	}
}
