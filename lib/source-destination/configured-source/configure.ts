/*
 * Copyright 2018 balena.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { interact } from 'balena-image-fs';
import { Disk } from 'file-disk';
import { getPartitions } from 'partitioninfo';
import { promisify } from 'util';

import { execute as configureAction } from './operations/configure';
import { execute as copyAction } from './operations/copy';

// This code comes from resin-image maker, converted to typescript and dropped Edison zip archive support.

type OperationCommand = 'configure' | 'copy';

interface Operation {
	command: OperationCommand;
	when: any;
}

const MBR_LAST_PRIMARY_PARTITION = 4;

const ACTIONS = {
	configure: configureAction,
	copy: copyAction,
};

const executeOperation = async (
	operation: Operation,
	disk: Disk,
): Promise<void> => {
	return await ACTIONS[operation.command](operation, disk);
};

const getPartitionIndex = (
	partition: number | { primary?: number; logical?: number },
): number => {
	// New device-type.json partition format: partition index
	if (typeof partition === 'number') {
		return partition;
	}
	// Old device-type.json partition format: { primary: 4, logical: 1 }
	if (typeof partition.logical === 'number') {
		return partition.logical + MBR_LAST_PRIMARY_PARTITION;
	}
	// Old device-type.json partition format: { primary: 4 }
	if (typeof partition.primary === 'number') {
		return partition.primary;
	}
	throw new Error(`Invalid partition: ${partition}`);
};

const getDiskDeviceType = async (disk: Disk): Promise<any> => {
	const partitions = await getPartitions(disk);
	for (const partition of partitions.partitions) {
		if (partition.type === 14) {
			const deviceType = await interact(disk, partition.index, async (fs) => {
				try {
					return await promisify(fs.readFile)('/device-type.json');
				} catch (error) {
					return undefined;
				}
			});
			if (deviceType) {
				return JSON.parse(deviceType.toString());
			}
		}
	}
};

export const configure = async (
	disk: Disk,
	options: { [k: string]: any; config?: any } = {},
): Promise<void> => {
	console.log('options', options);
	const deviceType = await getDiskDeviceType(disk);
	console.log(
		'device type read from disk image:\n',
		JSON.stringify(deviceType, null, 4),
	);
	let operations = deviceType?.configuration?.operations ?? [];
	operations = JSON.parse(JSON.stringify(operations));
	const config = deviceType?.configuration?.config;

	if (config) {
		operations.push({
			command: 'configure',
			partition: config.partition,
			data: options.config,
		});
	}

	operations = operations.filter((operation: Operation) => {
		if (operation.when !== undefined) {
			for (const key in operation.when) {
				if (options[key] !== operations.when[key]) {
					return false;
				}
			}
		}
		return true;
	});

	for (const operation of operations) {
		if (operation.partition !== undefined) {
			operation.partition = getPartitionIndex(operation.partition);
		}
		if (operation.to?.partition !== undefined) {
			operation.to.partition = getPartitionIndex(operation.to.partition);
		}
		if (operation.from?.partition !== undefined) {
			operation.from.partition = getPartitionIndex(operation.from.partition);
		}
		await executeOperation(operation, disk);
	}
};
