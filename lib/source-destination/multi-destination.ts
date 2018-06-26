import { each, map } from 'bluebird';
import { ReadResult, WriteResult } from 'file-disk';
import { every, minBy } from 'lodash';
import { PassThrough } from 'stream';

import BlockMap = require('blockmap');

import { PROGRESS_EMISSION_INTERVAL } from '../constants';
import { ProgressEvent } from './progress';
import { SourceDestination, Verifier } from './source-destination';
import { SparseWriteStream } from '../sparse-write-stream';

function isntNull(x: any) {
	return x !== null;
}

export class MultiDestinationError extends Error {
	constructor(public error: Error, public destination: SourceDestination) {
		super();
	}
}

export class MultiDestinationVerifier extends Verifier {
	private verifiers: Verifier[];
	private remaining: number;
	private timer: NodeJS.Timer;

	constructor(private source: MultiDestination, checksumOrBlockmap: string | BlockMap, size?: number) {
		super();
		const destinations = source.destinations
		.filter((dest: SourceDestination) => {
			// Don't try to verify destinations that failed.
			return !source.erroredDestinations.includes(dest);
		});
		this.remaining = destinations.length;
		this.verifiers = destinations
		.map((dest: SourceDestination) => {
			const verifier = dest.createVerifier(checksumOrBlockmap, size);
			verifier.on('error', (error: Error) => {
				this.emit('error', new MultiDestinationError(error, dest));
			});
			verifier.on('finish', () => {
				this.remaining -= 1;
				if (this.remaining === 0) {
					clearInterval(this.timer);
					this.emitProgress();
					this.emit('finish');
				}
			});
			return verifier;
		});
	}

	private emitProgress() {
		const verifier = minBy(this.verifiers, (verifier: Verifier) => {
			return verifier.progress.bytes;
		});
		if (verifier !== undefined) {
			this.emit('progress', verifier.progress);
		}
	}

	async run(): Promise<void> {
		this.timer = setInterval(this.emitProgress.bind(this), PROGRESS_EMISSION_INTERVAL);
		this.verifiers.map((verifier: Verifier) => {
			verifier.run();
		});
	}
}

export class MultiDestination extends SourceDestination {
	erroredDestinations: SourceDestination[] = [];

	constructor(readonly destinations: SourceDestination[]) {
		super();
		if (destinations.length === 0) {
			throw new Error('At least one destination is required');
		}
	}

	private async can(methodName: 'canRead' | 'canWrite' | 'canCreateReadStream' | 'canCreateSparseReadStream' | 'canCreateWriteStream' | 'canCreateSparseWriteStream') {
		return every(
			await map(this.destinations, async (destination: SourceDestination) => {
				return await destination[methodName]();
			}),
		);
	}

	async canRead(): Promise<boolean> {
		return await this.can('canRead');
	}

	async canWrite(): Promise<boolean> {
		return await this.can('canWrite');
	}

	async canCreateReadStream(): Promise<boolean> {
		return await this.can('canCreateReadStream');
	}

	async canCreateSparseReadStream(): Promise<boolean> {
		return await this.can('canCreateSparseReadStream');
	}

	async canCreateWriteStream(): Promise<boolean> {
		return await this.can('canCreateWriteStream');
	}

	async canCreateSparseWriteStream(): Promise<boolean> {
		return await this.can('canCreateSparseWriteStream');
	}

	async read(buffer: Buffer, bufferOffset: number, length: number, sourceOffset: number): Promise<ReadResult> {
		// Reads from the first destination (supposing all destinations contain the same data)
		return await this.destinations[0].read(buffer, bufferOffset, length, sourceOffset);
	}

	async write(buffer: Buffer, bufferOffset: number, length: number, fileOffset: number): Promise<WriteResult> {
		const results = await map(this.destinations, async (destination: SourceDestination) => {
			return await destination.write(buffer, bufferOffset, length, fileOffset);
		});
		// Returns the first WriteResult (they should be all the same)
		return results[0];
		// TODO: handle errors so one destination can fail
	}

	async _createReadStream(...args: any[]): Promise<NodeJS.ReadableStream> {
		// TODO: raise an error or a warning here
		return await this.destinations[0]._createReadStream(...args);
	}

	async _createSparseReadStream(...args: any[]): Promise<BlockMap.FilterStream | BlockMap.ReadStream> {
		// TODO: raise an error or a warning here
		return await this.destinations[0]._createSparseReadStream(...args);
	}

	private async createStream(methodName: 'createWriteStream' | 'createSparseWriteStream') {
		const passthrough = new PassThrough({ objectMode: (methodName === 'createSparseWriteStream') });
		passthrough.setMaxListeners(this.destinations.length + 1);  // all streams listen to end events, +1 because we'll listen too
		const progresses: Map<NodeJS.WritableStream, ProgressEvent | null> = new Map();
		let interval: NodeJS.Timer;

		function oneStreamFinished(stream: NodeJS.WritableStream) {
			if (progresses.size === 1) {
				clearInterval(interval);
				emitProgress();  // Just to be sure we emitted the last state
				passthrough.emit('done');
			}
			progresses.delete(stream);
		}

		function emitProgress() {
			// TODO: avoid Array.from
			passthrough.emit('progress', minBy(Array.from(progresses.values()).filter(isntNull), 'position'));
		}

		const streams = await map(this.destinations, async (destination: SourceDestination, index: number) => {
			const stream = await destination[methodName]();
			progresses.set(stream, null);
			stream.on('progress', (progressEvent: ProgressEvent) => {
				progresses.set(stream, progressEvent);
				if (interval === undefined) {
					interval = setInterval(emitProgress, PROGRESS_EMISSION_INTERVAL);
				}
			});
			stream.on('error', (error: Error) => {
				this.erroredDestinations.push(destination);
				// Don't emit 'error' events as it would unpipe the source from passthrough
				passthrough.emit('fail', new MultiDestinationError(error, destination));
				oneStreamFinished(stream);
			});
			stream.on('finish', oneStreamFinished.bind(null, stream));
			passthrough.pipe(stream);
		});
		return passthrough;
	}

	async createWriteStream(): Promise<NodeJS.WritableStream> {
		return await this.createStream('createWriteStream');
	}

	async createSparseWriteStream(): Promise<SparseWriteStream> {
		return await this.createStream('createSparseWriteStream');
	}

	createVerifier(checksumOrBlockmap: string | BlockMap, size?: number): Verifier {
		return new MultiDestinationVerifier(this, checksumOrBlockmap, size);
	}

	protected async _open(): Promise<void> {
		// TODO: remove destination from destinations list on error?
		// TODO: fix mountutils and use map
		//await map(this.destinations, async (destination) => {
		await each(this.destinations, async (destination) => {
			try {
				await destination.open();
			} catch (error) {
				this.emit('error', new MultiDestinationError(error, destination));
			}
		});
	}

	protected async _close(): Promise<void> {
		// TODO: fix mountutils and use map
		//await map(this.destinations, async (destination) => {
		await each(this.destinations, async (destination) => {
			try {
				await destination.close();
			} catch (error) {
				this.emit('error', new MultiDestinationError(error, destination));
			}
		});
	}
}