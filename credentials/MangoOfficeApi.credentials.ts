import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class MangoOfficeApi implements ICredentialType {
	name = 'mangoOfficeApi';

	displayName = 'Mango Office VPBX API';

	documentationUrl = 'https://www.mango-office.ru/support/instruktsii-i-rukovodstva/api/';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key (vpbx_api_key)',
			name: 'apiKey',
			type: 'string',
			default: '',
			required: true,
			description: 'Уникальный код вашей АТС. ЛК → Интеграции → API коннектор.',
		},
		{
			displayName: 'API Salt (vpbx_api_salt)',
			name: 'apiSalt',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Ключ для создания подписи. ЛК → Интеграции → API коннектор. Не передаётся в запросах — используется только для подписи sha256.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://app.mango-office.ru/vpbx',
			description: 'Адрес API Виртуальной АТС (без завершающего слэша).',
		},
	];
}
