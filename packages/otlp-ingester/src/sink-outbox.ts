import {
	closeSync,
	existsSync,
	readdirSync as listDir,
	rmSync,
	utimesSync,
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
 * Shared mode (SINK_OUTBOX_SHARED=1, for a network volume such as EFS
 * mounted into every task): each process keeps its batches in its own
 * subdirectory, `<dir>/<instance>/`, and touches `.heartbeat` there every
 * 10 s. A subdirectory whose heartbeat is older than two minutes — or that
 * its owner closed on shutdown — belongs to a task that is gone (a deploy,
 * a crash, scale-in): any live process adopts its batches (atomic renames,
 * so two adopters never take the same file) and sends them. Pids say
 * nothing across hosts, so shared mode uses no lock file.
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
	/** Batches taken over from gone processes (shared mode). */
	adopted: number;
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

/** A sibling whose heartbeat is older than this belongs to a gone process. */
export const SHARED_STALE_MS = 120_000;
const HEARTBEAT_MS = 10_000;

export class SinkOutbox {
	/** The directory this process keeps its batches in. */
	readonly dir: string;
	readonly deadDir: string;
	private readonly lockFile: string;
	private readonly root: string;
	private readonly shared: boolean;
	private heartbeat: NodeJS.Timeout | null = null;
	private adopted = 0;
	private files = new Map<string, number>();
	private deadFiles = new Map<string, number>();
	private writeFailures = 0;
	private deadPruned = 0;
	private locked = false;

	constructor(
		dir: string,
		private readonly options: {
			fsync?: boolean;
			deadLetterMaxBytes?: number;
			/** Shared mode: `dir` is the root every process shares. */
			shared?: boolean;
			/** Names this process's subdirectory in shared mode. */
			instance?: string;
			now?: () => number;
		} = {},
	) {
		this.root = dir;
		this.shared = Boolean(options.shared);
		this.dir = this.shared
			? join(dir, (options.instance ?? `${process.pid}-${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, "_"))
			: dir;
		this.deadDir = join(this.dir, "dead");
		this.lockFile = join(this.dir, ".lock");
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	/**
	 * Create the directories, take the lock and read every pending batch,
	 * oldest first. Unreadable files are moved to dead/ (never deleted).
	 * Throws OutboxLockedError when another live process owns the dir.
	 */
	open(): OutboxRecord[] {
		mkdirSync(this.deadDir, { recursive: true });
		if (this.shared) {
			this.beat();
			this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
			this.heartbeat.unref();
			return this.adoptOrphans();
		}
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

	get isShared(): boolean {
		return this.shared;
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
			adopted: this.adopted,
		};
	}

	/**
	 * Shared mode: take over the pending batches (and dead letters) of every
	 * sibling directory whose process is gone, oldest first. Each file moves
	 * by rename, so a batch is adopted by exactly one process. Returns the
	 * adopted batches for the caller to send. Never throws.
	 */
	adoptOrphans(staleMs = SHARED_STALE_MS): OutboxRecord[] {
		if (!this.shared) return [];
		const records: OutboxRecord[] = [];
		let siblings: string[];
		try {
			siblings = listDir(this.root, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && join(this.root, entry.name) !== this.dir)
				.map((entry) => join(this.root, entry.name));
		} catch {
			return records;
		}
		for (const sibling of siblings) {
			try {
				if (!this.orphaned(sibling, staleMs)) continue;
				for (const name of listDir(sibling).sort()) {
					if (!RECORD_FILE.test(name)) continue;
					const target = join(this.dir, name);
					try {
						renameSync(join(sibling, name), target);
					} catch {
						continue; // another process adopted it first
					}
					try {
						const record = JSON.parse(readFileSync(target, "utf8")) as OutboxRecord;
						if (record?.v !== 1 || typeof record.body !== "string") throw new Error("not an outbox record");
						this.files.set(name, Buffer.byteLength(record.body));
						records.push(record);
					} catch {
						renameSync(target, join(this.deadDir, `corrupt-${this.now()}-${name}`));
					}
				}
				const siblingDead = join(sibling, "dead");
				if (existsSync(siblingDead)) {
					for (const name of listDir(siblingDead)) {
						try {
							renameSync(join(siblingDead, name), join(this.deadDir, name));
							this.deadFiles.set(name, statSync(join(this.deadDir, name)).size);
						} catch {
							// adopted by another process
						}
					}
				}
				// Gone for good once empty of batches; a file that appears
				// meanwhile keeps the directory for the next scan.
				if (!listDir(sibling).some((name) => RECORD_FILE.test(name))) rmSync(sibling, { recursive: true, force: true });
			} catch (err) {
				console.warn(`sink outbox: could not adopt ${sibling} (${(err as Error).message})`);
			}
		}
		if (records.length > 0) {
			this.adopted += records.length;
			console.log(`sink outbox: adopted ${records.length} undelivered batch(es) from ingester(s) that are gone`);
		}
		this.pruneDead();
		return records.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
	}

	/** Its owner closed it, or its heartbeat stopped long enough ago. */
	private orphaned(dir: string, staleMs: number): boolean {
		if (existsSync(join(dir, ".closed"))) return true;
		const beat = join(dir, ".heartbeat");
		const last = existsSync(beat) ? statSync(beat).mtimeMs : statSync(dir).mtimeMs;
		return this.now() - last > staleMs;
	}

	private beat(): void {
		const file = join(this.dir, ".heartbeat");
		try {
			const at = new Date(this.now());
			if (existsSync(file)) utimesSync(file, at, at);
			else writeFileSync(file, "");
		} catch (err) {
			console.warn(`sink outbox: heartbeat not written (${(err as Error).message})`);
		}
	}

	/** Release the lock (shutdown). Pending batches stay for the next start;
	 * in shared mode the directory is marked closed so a live process adopts
	 * them on its next scan instead of waiting out the heartbeat. */
	close(): void {
		if (this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = null;
			try {
				writeFileSync(join(this.dir, ".closed"), "");
			} catch {
				// the heartbeat going stale covers it
			}
		}
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
