import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import {
	csvToArray,
	mangoDownloadRecording,
	mangoFetchCalls,
	mangoRequest,
	parseMaybeJson,
	toMangoDate,
	type MangoCreds,
} from './GenericFunctions';

export class MangoOffice implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Mango Office',
		name: 'mangoOffice',
		icon: 'file:mango.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		description: 'Работа с Mango Office VPBX: звонки, записи разговоров, группы, сотрудники',
		defaults: { name: 'Mango Office' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'mangoOfficeApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				default: 'call',
				options: [
					{ name: 'Call', value: 'call' },
					{ name: 'Recording', value: 'recording' },
					{ name: 'Group', value: 'group' },
					{ name: 'User', value: 'user' },
				],
			},

			// ---------- Call ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'getMany',
				displayOptions: { show: { resource: ['call'] } },
				options: [
					{
						name: 'Get Many',
						value: 'getMany',
						action: 'Get many calls',
						description: 'Список звонков через stats/calls (асинхронный запрос с опросом результата)',
					},
				],
			},
			{
				displayName: 'Start Date',
				name: 'startDate',
				type: 'dateTime',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['call'], operation: ['getMany'] } },
				description: 'Начало периода. Интерпретируется как время Mango (UTC+3).',
			},
			{
				displayName: 'End Date',
				name: 'endDate',
				type: 'dateTime',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['call'], operation: ['getMany'] } },
				description: 'Конец периода (период не более 1 месяца).',
			},
			{
				displayName: 'Filters',
				name: 'callFilters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['call'], operation: ['getMany'] } },
				options: [
					{
						displayName: 'Group IDs',
						name: 'groupIds',
						type: 'string',
						default: '',
						description: 'Через запятую. Фильтр по группам ВАТС.',
					},
					{
						displayName: 'User IDs',
						name: 'userIds',
						type: 'string',
						default: '',
						description: 'Через запятую. Фильтр по сотрудникам ВАТС.',
					},
					{
						displayName: 'Direction',
						name: 'contextType',
						type: 'options',
						default: 0,
						options: [
							{ name: 'Any', value: 0 },
							{ name: 'Incoming', value: 1 },
							{ name: 'Outgoing', value: 2 },
							{ name: 'Internal', value: 3 },
						],
					},
					{
						displayName: 'Only Answered',
						name: 'onlyAnswered',
						type: 'boolean',
						default: false,
						description: 'Whether to return only successful (answered) calls',
					},
					{
						displayName: 'Search String',
						name: 'searchString',
						type: 'string',
						default: '',
						description: 'Поиск по номеру (не менее 3 символов)',
					},
					{
						displayName: 'Limit',
						name: 'limit',
						type: 'options',
						default: 1000,
						options: [1, 5, 10, 20, 50, 100, 500, 1000, 2000, 5000].map((n) => ({
							name: String(n),
							value: n,
						})),
					},
				],
			},

			// ---------- Recording ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'download',
				displayOptions: { show: { resource: ['recording'] } },
				options: [
					{
						name: 'Download',
						value: 'download',
						action: 'Download a recording',
						description: 'Скачать запись разговора по recording_id (бинарный файл)',
					},
				],
			},
			{
				displayName: 'Recording ID',
				name: 'recordingId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['recording'], operation: ['download'] } },
			},
			{
				displayName: 'Action',
				name: 'recAction',
				type: 'options',
				default: 'download',
				options: [
					{ name: 'Download', value: 'download' },
					{ name: 'Play', value: 'play' },
				],
				displayOptions: { show: { resource: ['recording'], operation: ['download'] } },
			},
			{
				displayName: 'Put Output In Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				displayOptions: { show: { resource: ['recording'], operation: ['download'] } },
				description: 'Имя бинарного поля, в которое попадёт mp3',
			},

			// ---------- Group ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'getMany',
				displayOptions: { show: { resource: ['group'] } },
				options: [
					{ name: 'Get Many', value: 'getMany', action: 'Get many groups' },
				],
			},

			// ---------- User ----------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				default: 'getMany',
				displayOptions: { show: { resource: ['user'] } },
				options: [
					{ name: 'Get Many', value: 'getMany', action: 'Get many users' },
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const c = (await this.getCredentials('mangoOfficeApi')) as unknown as MangoCreds;
		const creds: MangoCreds = {
			apiKey: c.apiKey,
			apiSalt: c.apiSalt,
			baseUrl: c.baseUrl || 'https://app.mango-office.ru/vpbx',
		};

		const returnData: INodeExecutionData[] = [];
		const total = items.length === 0 ? 1 : items.length;

		for (let i = 0; i < total; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				if (resource === 'call' && operation === 'getMany') {
					const start = this.getNodeParameter('startDate', i) as string;
					const end = this.getNodeParameter('endDate', i) as string;
					const f = this.getNodeParameter('callFilters', i, {}) as IDataObject;

					const payload: IDataObject = {
						start_date: toMangoDate(start),
						end_date: toMangoDate(end),
					};
					const groupIds = csvToArray(f.groupIds);
					const userIds = csvToArray(f.userIds);
					if (groupIds.length) payload.group_ids = groupIds;
					if (userIds.length) payload.user_ids = userIds;
					if (f.contextType) payload.context_type = f.contextType;
					if (f.onlyAnswered === true) payload.context_status = 1;
					if (f.searchString) payload.search_string = f.searchString;
					if (f.limit) payload.limit = f.limit;

					const calls = await mangoFetchCalls.call(this, creds, payload);
					for (const call of calls) {
						returnData.push({ json: call, pairedItem: { item: i } });
					}
				} else if (resource === 'recording' && operation === 'download') {
					const recordingId = this.getNodeParameter('recordingId', i) as string;
					const action = this.getNodeParameter('recAction', i) as string;
					const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;

					const buffer = await mangoDownloadRecording.call(this, creds, recordingId, action);
					const binary = await this.helpers.prepareBinaryData(
						buffer,
						`${recordingId}.mp3`,
						'audio/mpeg',
					);
					returnData.push({
						json: { recording_id: recordingId, action },
						binary: { [binaryPropertyName]: binary },
						pairedItem: { item: i },
					});
				} else if (resource === 'group' && operation === 'getMany') {
					const body = await mangoRequest.call(this, creds, '/groups', {});
					const parsed = parseMaybeJson(body);
					const list = Array.isArray(parsed?.groups) ? parsed.groups : parsed;
					if (Array.isArray(list)) {
						for (const g of list) returnData.push({ json: g as IDataObject, pairedItem: { item: i } });
					} else {
						returnData.push({ json: (parsed ?? {}) as IDataObject, pairedItem: { item: i } });
					}
				} else if (resource === 'user' && operation === 'getMany') {
					const body = await mangoRequest.call(this, creds, '/config/users/request', {});
					const parsed = parseMaybeJson(body);
					const list = Array.isArray(parsed?.users) ? parsed.users : parsed;
					if (Array.isArray(list)) {
						for (const u of list) returnData.push({ json: u as IDataObject, pairedItem: { item: i } });
					} else {
						returnData.push({ json: (parsed ?? {}) as IDataObject, pairedItem: { item: i } });
					}
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
