import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

/**
 * On-disk outbox for the sink webhook (1.12).
 *
 * Before 1.12 the sink's retry queue lived in memory only: a restart, a
 * crash or a deploy while the webhook was down lost every batch waiting to
 * be sent. Now each batch is written to SINK_OUTBOX_DIR before the ingest
 * request is answered and deleted once the webhook accepts it; at startup
 * the ingester loads what is left and sends it again. Delivery is therefore
 * at-least-once across restarts — the consumer dedupes on `batchId`.
 *
 * Batches the sink gives up on (a permanent 4xx, the age or attempt
 * budget, buffer overflow) move to `<dir>/dead/` with the reason, bounded
 * by SINK_DEAD_LETTER_MAX_MB (oldest deleted first). Moving a file from
 * `dead/` back into the outbox directory and restarting re-sends it.
 *
 * One directory per ingester process: a `.lock` file holds the owner's
 * pid, and a second live process refusing to share it falls back to
 * memory-only delivery (logged), rather than double-sending.
 *
 * Writes are synchronous (tmp file + rename, so a crash never leaves a
 * half-written batch under its real name). They go to the page cache, which
 * survives a process crash; SINK_OUTBOX_FSYNC=1 also survives a host crash
 * at the cost of one fsync per batch.
 */

/** One persisted batch: everything needed to send it again. */
export interface OutboxRecord {
	v: 1;
	seq: number;
	batchId: string;
	orgId: string;
	repositoryId: string;
	occurrences: number;
	metricPoints: number;
	llmCalls: number;
	signalsFrom: string | null;
	signalsTo: string | null;
	/** ms since epoch. */
	enqueuedAt: number;
	/** The exact webhook body. */
	body: string;
}

/** A dead-lettered batch: the record plus why and when it was given up. */
export interface DeadLetterRecord extends OutboxRecord {
	reason: string;
	attempts: number;
	droppedAt: number;
}

export interface OutboxStats {
	/** Batches on disk waiting for delivery. */
	files: number;
	bytes: number;
	deadFiles: number;
	deadBytes: number;
	/** Batches that could not be written (kept in memory only). */
	writeFailures: number;
	/** Dead letters deleted to stay under the dead-letter budget. */
	deadPruned: number;
}

export class OutboxLockedError extends Error {
	constructor(dir: string, pid: number) {
		super(`sink outbox ${dir} is in use by process ${pid}`);
		this.name = "OutboxLockedError";
	}
}

const RECORD_FILE = /^(\d{12})-[A-Za-z0-9-]{1,128}\.json$/;

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: it exists, it is just not ours to signal.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class SinkOutbox {
	readonly deadDir: string;
	private readonly lockFile: string;
	private files = new Map<string, number>();
	private deadFiles = new Map<string, number>();
	private writeFailures = 0;
	private deadPruned = 0;
	private locked = false;

	constructor(
		readonly dir: string,
		private readonly options: { fsync?: boolean; deadLetterMaxBytes?: number } = {},
	) {
		this.deadDir = join(dir, "dead");
		this.lockFile = join(dir, ".lock");
	}

	/**
	 * Create the directories, take the lock and read every pending batch,
	 * oldest first. Unreadable files are moved to dead/ (never deleted).
	 * Throws OutboxLockedError when another live process owns the dir.
	 */
	open(): OutboxRecord[] {
		mkdirSync(this.deadDir, { recursive: true });
		if (existsSync(this.lockFile)) {
			const owner = Number.parseInt(readFileSync(this.lockFile, "utf8"), 10);
			if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && isAlive(owner)) {
				throw new OutboxLockedError(this.dir, owner);
			}
		}
		writeFileSync(this.lockFile, String(process.pid));
		this.locked = true;

		for (const name of readdirSync(this.deadDir)) {
			if (name.endsWith(".json")) this.deadFiles.set(name, statSync(join(this.deadDir, name)).size);
		}
		const records: OutboxRecord[] = [];
		for (const name of readdirSync(this.dir).sort()) {
			const path = join(this.dir, name);
			if (name.endsWith(".tmp")) {
				// A write the last process did not finish: it was never acknowledged.
				unlinkSync(path);
				continue;
			}
			if (!RECORD_FILE.test(name)) continue;
			try {
				const record = JSON.parse(readFileSync(path, "utf8")) as OutboxRecord;
				if (record?.v !== 1 || typeof record.body !== "string" || typeof record.batchId !== "string") {
					throw new Error("not an outbox record");
				}
				this.files.set(name, Buffer.byteLength(record.body));
				records.push(record);
			} catch (err) {
				console.error(`sink outbox: ${name} is unreadable (${(err as Error).message}) — moved to dead/`);
				renameSync(path, join(this.deadDir, `corrupt-${Date.now()}-${name}`));
			}
		}
		this.pruneDead();
		return records;
	}

	/** Persist one batch before it is acknowledged. Never throws: a failed
	 * write is counted and the batch stays in memory only. */
	write(record: OutboxRecord): boolean {
		const name = this.fileName(record);
		const path = join(this.dir, name);
		const tmp = `${path}.tmp`;
		try {
			const data = JSON.stringify(record);
			if (this.options.fsync) {
				const fd = openSync(tmp, "w");
				try {
					writeSync(fd, data);
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
			} else {
				writeFileSync(tmp, data);
			}
			renameSync(tmp, path);
			this.files.set(name, Buffer.byteLength(record.body));
			return true;
		} catch (err) {
			this.writeFailures += 1;
			console.error(`sink outbox: could not write batch ${record.batchId} (${(err as Error).message}) — kept in memory only`);
			try {
				unlinkSync(tmp);
			} catch {
				// nothing to clean up
			}
			return false;
		}
	}

	/** Delivered: forget the batch. */
	remove(record: Pick<OutboxRecord, "seq" | "batchId">): void {
		const name = this.fileName(record);
		this.files.delete(name);
		try {
			unlinkSync(join(this.dir, name));
		} catch {
			// Already gone (never written, or removed by hand).
		}
	}

	/** Given up: keep the batch under dead/ with the reason. Returns the
	 * dead-letter file name, or null when it could not be written. */
	deadLetter(record: OutboxRecord, reason: string, attempts: number, droppedAt: number): string | null {
		const name = `${String(droppedAt).padStart(13, "0")}-${record.batchId}.json`;
		const dead: DeadLetterRecord = { ...record, reason, attempts, droppedAt };
		let written: string | null = null;
		try {
			const data = JSON.stringify(dead);
			writeFileSync(join(this.deadDir, name), data);
			this.deadFiles.set(name, Buffer.byteLength(data));
			written = name;
		} catch (err) {
			console.error(`sink outbox: could not dead-letter batch ${record.batchId} (${(err as Error).message})`);
		}
		this.remove(record);
		this.pruneDead();
		return written;
	}

	stats(): OutboxStats {
		let bytes = 0;
		for (const size of this.files.values()) bytes += size;
		let deadBytes = 0;
		for (const size of this.deadFiles.values()) deadBytes += size;
		return {
			files: this.files.size,
			bytes,
			deadFiles: this.deadFiles.size,
			deadBytes,
			writeFailures: this.writeFailures,
			deadPruned: this.deadPruned,
		};
	}

	/** Release the lock (shutdown). Pending batches stay for the next start. */
	close(): void {
		if (!this.locked) return;
		this.locked = false;
		try {
			unlinkSync(this.lockFile);
		} catch {
			// already gone
		}
	}

	private fileName(record: Pick<OutboxRecord, "seq" | "batchId">): string {
		return `${String(record.seq).padStart(12, "0")}-${record.batchId}.json`;
	}

	/** Oldest dead letters go first once the budget is exceeded. */
	private pruneDead(): void {
		const max = this.options.deadLetterMaxBytes ?? 256 * 1024 * 1024;
		let total = 0;
		for (const size of this.deadFiles.values()) total += size;
		if (total <= max) return;
		for (const name of [...this.deadFiles.keys()].sort()) {
			if (total <= max) break;
			total -= this.deadFiles.get(name) ?? 0;
			this.deadFiles.delete(name);
			this.deadPruned += 1;
			try {
				unlinkSync(join(this.deadDir, name));
			} catch {
				// already gone
			}
			console.warn(`sink outbox: dead letter ${name} deleted (SINK_DEAD_LETTER_MAX_MB reached)`);
		}
	}
}
