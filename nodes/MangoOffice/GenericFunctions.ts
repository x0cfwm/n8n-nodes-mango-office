import { createHash } from 'crypto';
import type { IDataObject, IExecuteFunctions, IHttpRequestOptions } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

export interface MangoCreds {
	apiKey: string;
	apiSalt: string;
	baseUrl: string;
}

/** Mango signature: sha256(vpbx_api_key + json + vpbx_api_salt). Salt is never sent. */
export function mangoSign(key: string, json: string, salt: string): string {
	return createHash('sha256').update(key + json + salt).digest('hex');
}

function urlForm(creds: MangoCreds, json: string): string {
	const sign = mangoSign(creds.apiKey, json, creds.apiSalt);
	return (
		'json=' +
		encodeURIComponent(json) +
		'&vpbx_api_key=' +
		encodeURIComponent(creds.apiKey) +
		'&sign=' +
		sign
	);
}

function baseUrl(creds: MangoCreds): string {
	return (creds.baseUrl || 'https://app.mango-office.ru/vpbx').replace(/\/$/, '');
}

export function parseMaybeJson(input: unknown): any {
	if (input === null || input === undefined || input === '') return null;
	if (typeof input === 'string') {
		try {
			return JSON.parse(input);
		} catch {
			return { _raw: input };
		}
	}
	return input;
}

/** Signed POST returning the parsed JSON body (or full response when returnFullResponse=true). */
export async function mangoRequest(
	this: IExecuteFunctions,
	creds: MangoCreds,
	path: string,
	payload: IDataObject,
	returnFullResponse = false,
): Promise<any> {
	const json = JSON.stringify(payload);
	const options: IHttpRequestOptions = {
		method: 'POST',
		url: baseUrl(creds) + path,
		body: urlForm(creds, json),
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		json: false,
		returnFullResponse,
	};
	try {
		const resp = await this.helpers.httpRequest(options);
		if (returnFullResponse) return resp;
		return parseMaybeJson(resp);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as any, {
			message: `Mango request failed: ${path}`,
		});
	}
}

/** Download a recording as a Buffer (recording/post -> 302 -> file). */
export async function mangoDownloadRecording(
	this: IExecuteFunctions,
	creds: MangoCreds,
	recordingId: string,
	action: string,
): Promise<Buffer> {
	const json = JSON.stringify({ recording_id: recordingId, action });
	const options: IHttpRequestOptions = {
		method: 'POST',
		url: baseUrl(creds) + '/queries/recording/post',
		body: urlForm(creds, json),
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		encoding: 'arraybuffer',
		json: false,
	};
	try {
		const resp = await this.helpers.httpRequest(options);
		return Buffer.from(resp as ArrayBuffer);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as any, {
			message: `Mango recording download failed: ${recordingId}`,
		});
	}
}

/**
 * Extended call statistics: async request -> poll result until 'complete'.
 * Returns the data.list array of calls.
 */
export async function mangoFetchCalls(
	this: IExecuteFunctions,
	creds: MangoCreds,
	payload: IDataObject,
	maxPolls = 20,
	pollDelayMs = 2500,
): Promise<IDataObject[]> {
	const req = await mangoRequest.call(this, creds, '/stats/calls/request/', payload);
	const key = req?.key;
	if (!key) {
		throw new NodeApiError(this.getNode(), req ?? {}, {
			message: 'Mango /stats/calls/request did not return a key',
		});
	}

	for (let attempt = 0; attempt < maxPolls; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, pollDelayMs));

		let full: any;
		try {
			full = await mangoRequest.call(this, creds, '/stats/calls/result/', { key }, true);
		} catch {
			continue;
		}

		const statusCode = full?.statusCode;
		if (statusCode === 204) continue; // result not ready yet

		const body = parseMaybeJson(full?.body ?? full);
		const status: string | undefined = body?.status;
		const data = body?.data;
		// Mango returns `data` as an ARRAY of chunks, each with its own `list`: data[].list[]
		const flat: IDataObject[] = Array.isArray(data)
			? (data.flatMap((d: any) => (d?.list ?? [])) as IDataObject[])
			: ((data?.list ?? []) as IDataObject[]);
		const hasData = Array.isArray(data) ? data.length > 0 : !!data?.list;

		// Return ONLY when the job is complete. A 'work' response can already carry a
		// partial first chunk; returning on it truncated the result to a few calls.
		if (status === 'complete') return flat;
		if (!status && hasData) return flat; // fallback: data present with no status field
		if (status === 'not-found') {
			throw new NodeApiError(this.getNode(), body ?? {}, {
				message: 'Mango /stats/calls/result: key not found',
			});
		}
		if (status === 'cancel' || status === 'error') {
			throw new NodeApiError(this.getNode(), body ?? {}, {
				message: `Mango stats result returned status "${status}"`,
			});
		}
		// status 'work' (or empty) -> keep polling
	}

	throw new NodeApiError(this.getNode(), {}, {
		message: `Mango stats result not ready after ${maxPolls} polls`,
	});
}

/**
 * Convert a datetime to Mango's expected string "DD.MM.YYYY HH:MM:SS".
 * Mango rejects ISO "YYYY-MM-DD" (error 3104). For a naive datetime (no timezone,
 * as n8n's fixed dateTime provides) the wall-clock components are used as-is and
 * treated as Mango time (UTC+3). For a timezone-aware instant we convert to UTC+3.
 */
export function toMangoDate(input: string): string {
	const m = String(input).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?/);
	if (m && !m[7]) {
		const [, y, mo, d, h, mi, s] = m;
		return `${d}.${mo}.${y} ${h}:${mi}:${s || '00'}`;
	}
	const ms = new Date(input).getTime();
	if (Number.isNaN(ms)) {
		throw new Error(`Invalid date: ${input}`);
	}
	const dt = new Date(ms + 3 * 3600 * 1000);
	const p = (n: number) => String(n).padStart(2, '0');
	return (
		`${p(dt.getUTCDate())}.${p(dt.getUTCMonth() + 1)}.${dt.getUTCFullYear()} ` +
		`${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`
	);
}

export function csvToArray(value: unknown): string[] {
	if (!value) return [];
	return String(value)
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}
