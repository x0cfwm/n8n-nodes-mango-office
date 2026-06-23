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

/** Parse a Mango date string "DD.MM.YYYY HH:MM:SS" (MSK wall time) into a UTC epoch ms. */
function parseMangoDateMs(s: string): number {
	const m = String(s).match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
	if (!m) return NaN;
	const [, d, mo, y, h, mi, sec] = m;
	// Wall time is MSK (UTC+3); the same wall components in UTC are 3 hours ahead.
	return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec)) - 3 * 3600 * 1000;
}

/** Format a UTC epoch ms back into Mango's "DD.MM.YYYY HH:MM:SS" MSK wall string. */
function formatMangoDateFromMs(ms: number): string {
	const dt = new Date(ms + 3 * 3600 * 1000);
	const p = (n: number) => String(n).padStart(2, '0');
	return (
		`${p(dt.getUTCDate())}.${p(dt.getUTCMonth() + 1)}.${dt.getUTCFullYear()} ` +
		`${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`
	);
}

// Mango /stats/calls caps a single request at strictly less than 30 days
// (live-verified 2026-06-22: "24.04 00:00 -> 24.05 00:00" = exactly 30d FAILS
// with result 3100 / fields 3111, but "24.04 00:00 -> 23.05 23:59:59" = 30d-1s
// works; ≥31d also fails). We chunk at 30d-1s to maximize coverage per request.
const MANGO_STATS_MAX_PERIOD_MS = 30 * 24 * 3600 * 1000 - 1000;

/** One stats/calls cycle (request -> poll until complete) for a single ≤30-day window. */
async function mangoStatsCallsOnce(
	ctx: IExecuteFunctions,
	creds: MangoCreds,
	payload: IDataObject,
	maxPolls: number,
	pollDelayMs: number,
): Promise<IDataObject[]> {
	const req = await mangoRequest.call(ctx, creds, '/stats/calls/request/', payload);
	const key = req?.key;
	if (!key) {
		throw new NodeApiError(ctx.getNode(), req ?? {}, {
			message: 'Mango /stats/calls/request did not return a key',
		});
	}

	for (let attempt = 0; attempt < maxPolls; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, pollDelayMs));

		let full: any;
		try {
			full = await mangoRequest.call(ctx, creds, '/stats/calls/result/', { key }, true);
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
			throw new NodeApiError(ctx.getNode(), body ?? {}, {
				message: 'Mango /stats/calls/result: key not found',
			});
		}
		if (status === 'cancel' || status === 'error') {
			throw new NodeApiError(ctx.getNode(), body ?? {}, {
				message: `Mango stats result returned status "${status}"`,
			});
		}
		// status 'work' (or empty) -> keep polling
	}

	throw new NodeApiError(ctx.getNode(), {}, {
		message: `Mango stats result not ready after ${maxPolls} polls`,
	});
}

/**
 * Extended call statistics with automatic 30-day chunking.
 *
 * Mango limits a single /stats/calls request to a 30-day period. When the
 * requested span exceeds 30 days, this function walks it in sequential
 * ≤30-day chunks and concatenates the results, deduplicating by `entry_id`
 * (which guarantees no duplicates across chunk boundaries). If the dates
 * aren't in Mango's "DD.MM.YYYY HH:MM:SS" format, the payload is sent
 * through unchanged (single window).
 */
export async function mangoFetchCalls(
	this: IExecuteFunctions,
	creds: MangoCreds,
	payload: IDataObject,
	maxPolls = 20,
	pollDelayMs = 2500,
): Promise<IDataObject[]> {
	const startStr = typeof payload.start_date === 'string' ? payload.start_date : '';
	const endStr = typeof payload.end_date === 'string' ? payload.end_date : '';
	const startMs = parseMangoDateMs(startStr);
	const endMs = parseMangoDateMs(endStr);
	const datesKnown = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;

	// Fast path: unparseable dates, or span ≤ 30 days → one request.
	if (!datesKnown || endMs - startMs <= MANGO_STATS_MAX_PERIOD_MS) {
		return mangoStatsCallsOnce(this, creds, payload, maxPolls, pollDelayMs);
	}

	// Long span → split into ≤30-day chunks. `offset` is per-request and meaningless
	// across chunks, so reject it explicitly instead of silently mis-paging.
	if (typeof payload.offset === 'number' && payload.offset > 0) {
		throw new NodeApiError(this.getNode(), {}, {
			message:
				'Mango: offset cannot be combined with periods longer than 30 days. Shorten the period or remove the offset.',
		});
	}

	const all: IDataObject[] = [];
	const seenEntryIds = new Set<string>();
	let cursor = startMs;
	while (cursor < endMs) {
		const chunkEnd = Math.min(cursor + MANGO_STATS_MAX_PERIOD_MS, endMs);
		const chunkPayload: IDataObject = {
			...payload,
			start_date: formatMangoDateFromMs(cursor),
			end_date: formatMangoDateFromMs(chunkEnd),
		};
		const chunk = await mangoStatsCallsOnce(this, creds, chunkPayload, maxPolls, pollDelayMs);
		for (const call of chunk) {
			const id = String((call as any)?.entry_id ?? '');
			if (id) {
				if (seenEntryIds.has(id)) continue;
				seenEntryIds.add(id);
			}
			all.push(call);
		}
		// Advance ≥1s past the chunk's end so the next window doesn't reuse the
		// boundary second (Mango is second-precision); the entry_id dedup above
		// is the real safety net.
		cursor = chunkEnd + 1000;
		if (cursor < endMs) {
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
	return all;
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
