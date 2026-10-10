export type ImageFormat = 'png' | 'jpeg' | 'webp';
export type ImageSize = 'auto' | '1024x1024' | '1536x1024' | '1024x1536';

export interface ImageGenerationRequest {
    prompt: string;
    size?: ImageSize;
    format?: ImageFormat;
    count?: number;
}

export interface GeneratedImage {
    bytes: Uint8Array;
    format: ImageFormat;
    mimeType: `image/${ImageFormat}`;
}

export interface ImageGenerationProvider {
    readonly name: string;
    readonly status: 'CONFIGURED' | 'NOT_CONFIGURED';
    generate(request: ImageGenerationRequest): Promise<GeneratedImage[]>;
}

export type ImageGenerationErrorCode =
    | 'IMAGE_GENERATION_NOT_CONFIGURED'
    | 'IMAGE_GENERATION_INVALID_REQUEST'
    | 'IMAGE_GENERATION_PROVIDER_ERROR'
    | 'IMAGE_GENERATION_INVALID_PROVIDER_RESPONSE';

export class ImageGenerationError extends Error {
    constructor(
        readonly code: ImageGenerationErrorCode,
        message: string
    ) {
        super(message);
        this.name = 'ImageGenerationError';
    }
}

const MAX_PROMPT_LENGTH = 4_000;
const MAX_COUNT = 4;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_SIZE: ImageSize = '1024x1024';
const DEFAULT_FORMAT: ImageFormat = 'png';

type ProviderConfig = {
    apiKey: string;
    fetchImplementation: typeof fetch;
};

function invalidRequest(message: string): never {
    throw new ImageGenerationError('IMAGE_GENERATION_INVALID_REQUEST', message);
}

function validateRequest(request: ImageGenerationRequest): Required<ImageGenerationRequest> {
    if (!request || typeof request !== 'object') {
        return invalidRequest('An image generation request is required.');
    }

    if (typeof request.prompt !== 'string') {
        return invalidRequest('Prompt must be a string.');
    }
    const prompt = request.prompt.trim();
    if (prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH) {
        return invalidRequest(`Prompt must contain 1 to ${MAX_PROMPT_LENGTH} characters.`);
    }

    const size = request.size ?? DEFAULT_SIZE;
    if (!['auto', '1024x1024', '1536x1024', '1024x1536'].includes(size)) {
        return invalidRequest('Size must be auto, 1024x1024, 1536x1024, or 1024x1536.');
    }

    const format = request.format ?? DEFAULT_FORMAT;
    if (!['png', 'jpeg', 'webp'].includes(format)) {
        return invalidRequest('Format must be png, jpeg, or webp.');
    }

    const count = request.count ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
        return invalidRequest(`Count must be an integer from 1 to ${MAX_COUNT}.`);
    }

    return { prompt, size, format, count };
}

function invalidProviderResponse(message: string): never {
    throw new ImageGenerationError('IMAGE_GENERATION_INVALID_PROVIDER_RESPONSE', message);
}

export function isValidImageBytes(bytes: Uint8Array, format: ImageFormat): boolean {
    if (format === 'png') {
        if (bytes.length < 45 || !(
            bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
            bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a &&
            bytes[6] === 0x1a && bytes[7] === 0x0a
        )) return false;
        let offset = 8;
        let hasHeader = false;
        let hasImageData = false;
        while (offset + 12 <= bytes.length) {
            const chunkLength = (bytes[offset] * 0x1000000) +
                (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
            const chunkType = String.fromCharCode(
                bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]
            );
            const chunkEnd = offset + 12 + chunkLength;
            if (chunkEnd > bytes.length) return false;
            if (!hasHeader) {
                if (chunkType !== 'IHDR' || chunkLength !== 13) return false;
                const width = (bytes[offset + 8] * 0x1000000) +
                    (bytes[offset + 9] << 16) + (bytes[offset + 10] << 8) + bytes[offset + 11];
                const height = (bytes[offset + 12] * 0x1000000) +
                    (bytes[offset + 13] << 16) + (bytes[offset + 14] << 8) + bytes[offset + 15];
                if (width < 1 || height < 1) return false;
                hasHeader = true;
            } else if (chunkType === 'IDAT' && chunkLength > 0) {
                hasImageData = true;
            } else if (chunkType === 'IEND') {
                return chunkLength === 0 && hasImageData && chunkEnd === bytes.length;
            }
            offset = chunkEnd;
        }
        return false;
    }

    if (format === 'jpeg') {
        return bytes.length >= 4 &&
            bytes[0] === 0xff && bytes[1] === 0xd8 &&
            bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
    }

    return bytes.length >= 16 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 &&
        (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38);
}

function decodeImage(value: unknown, format: ImageFormat): GeneratedImage {
    if (typeof value !== 'string' || value.length === 0 ||
        value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        return invalidProviderResponse('OpenAI returned an invalid or oversized image payload.');
    }

    const bytes = Buffer.from(value, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== value ||
        !isValidImageBytes(bytes, format)) {
        return invalidProviderResponse(`OpenAI did not return valid ${format} image bytes.`);
    }

    return { bytes, format, mimeType: `image/${format}` };
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await response.body?.cancel();
        return invalidProviderResponse('OpenAI response exceeded the allowed size.');
    }

    if (!response.body) {
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > maxBytes) {
            return invalidProviderResponse('OpenAI response exceeded the allowed size.');
        }
        return text;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            if (totalBytes > maxBytes) {
                await reader.cancel();
                return invalidProviderResponse('OpenAI response exceeded the allowed size.');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
        return invalidProviderResponse('OpenAI returned a response that was not valid UTF-8.');
    }
}

function providerErrorDetail(body: string, apiKey: string): string {
    let detail = body.trim();
    try {
        const parsed: unknown = JSON.parse(body);
        if (parsed && typeof parsed === 'object' && 'error' in parsed) {
            const error = parsed.error;
            if (error && typeof error === 'object' && 'message' in error &&
                typeof error.message === 'string') {
                detail = error.message;
            }
        }
    } catch {
        // Preserve a bounded plain-text provider error when the body is not JSON.
    }
    if (!detail) detail = 'The provider returned an error without details.';
    return detail.split(apiKey).join('[redacted]').slice(0, 1_000);
}

class OpenAIImageGenerationProvider implements ImageGenerationProvider {
    constructor(private readonly config: ProviderConfig) {}

    readonly name = 'OpenAI';

    get status(): 'CONFIGURED' {
        return 'CONFIGURED';
    }

    async generate(request: ImageGenerationRequest): Promise<GeneratedImage[]> {
        const validated = validateRequest(request);
        const maxResponseBytes = Math.ceil(MAX_IMAGE_BYTES * validated.count * 4 / 3) + 512 * 1024;

        let response: Response;
        try {
            response = await this.config.fetchImplementation('https://api.openai.com/v1/images/generations', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.config.apiKey}`,
                    'Content-Type': 'application/json'
                },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                body: JSON.stringify({
                    model: 'gpt-image-1',
                    prompt: validated.prompt,
                    size: validated.size,
                    n: validated.count,
                    output_format: validated.format
                })
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : 'Unknown network error.';
            throw new ImageGenerationError(
                'IMAGE_GENERATION_PROVIDER_ERROR',
                `OpenAI image generation request failed: ${detail.split(this.config.apiKey).join('[redacted]').slice(0, 1_000)}`
            );
        }

        const body = await readResponseText(
            response,
            response.ok ? maxResponseBytes : 64 * 1024
        );
        if (!response.ok) {
            throw new ImageGenerationError(
                'IMAGE_GENERATION_PROVIDER_ERROR',
                `OpenAI image generation failed (HTTP ${response.status}): ${providerErrorDetail(body, this.config.apiKey)}`
            );
        }

        let data: unknown;
        try {
            data = JSON.parse(body);
        } catch {
            return invalidProviderResponse('OpenAI returned invalid JSON for the image generation response.');
        }

        if (!data || typeof data !== 'object' || !('data' in data) || !Array.isArray(data.data) ||
            data.data.length !== validated.count) {
            return invalidProviderResponse('OpenAI returned an unexpected number of images.');
        }

        return data.data.map((item: unknown) => {
            if (!item || typeof item !== 'object' || !('b64_json' in item)) {
                return invalidProviderResponse('OpenAI returned an image without base64 image data.');
            }
            return decodeImage(item.b64_json, validated.format);
        });
    }
}

class UnconfiguredImageGenerationProvider implements ImageGenerationProvider {
    readonly name = 'Unavailable';
    readonly status = 'NOT_CONFIGURED' as const;

    async generate(request: ImageGenerationRequest): Promise<GeneratedImage[]> {
        validateRequest(request);
        throw new ImageGenerationError(
            'IMAGE_GENERATION_NOT_CONFIGURED',
            'Image generation is not configured. Set OPENAI_API_KEY in the backend environment.'
        );
    }
}

/**
 * Selects the configured backend provider. Credentials are read only from the
 * backend process environment and are never exposed through this abstraction.
 */
export function createImageGenerationProvider(
    fetchImplementation: typeof fetch = fetch,
    environment: NodeJS.ProcessEnv = process.env
): ImageGenerationProvider {
    const requestedProvider = environment.IMAGE_GENERATION_PROVIDER?.trim().toLowerCase();
    const apiKey = environment.OPENAI_API_KEY?.trim() ?? '';
    if ((!requestedProvider || requestedProvider === 'openai') && apiKey) {
        return new OpenAIImageGenerationProvider({ apiKey, fetchImplementation });
    }
    return new UnconfiguredImageGenerationProvider();
}
