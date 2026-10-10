const DEFAULT_MODEL = 'gpt-4o-mini';
const REQUEST_TIMEOUT_MS = 120_000;

export class OpenAIProvider {
    private readonly apiKey = process.env.OPENAI_API_KEY?.trim() || '';
    readonly configuredModel = process.env.OPENAI_MODEL || DEFAULT_MODEL;

    get configured(): boolean {
        return this.apiKey.length > 0;
    }

    async chat(prompt: string): Promise<string> {
        if (!this.configured) {
            throw new Error('OpenAI is not configured. Set OPENAI_API_KEY in the backend environment.');
        }
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            body: JSON.stringify({
                model: this.configuredModel,
                messages: [
                    {
                        role: 'system',
                        content: 'You are CLIRO, a local computer assistant. You may explain and discuss, but never claim or execute computer actions. Deterministic CLIRO tools handle all system actions. Do not invent current facts; those are verified separately.'
                    },
                    { role: 'user', content: prompt }
                ]
            })
        });
        if (!response.ok) {
            const body = await response.text();
            let detail = response.statusText || `HTTP ${response.status}`;
            try {
                const parsed: unknown = JSON.parse(body);
                if (parsed && typeof parsed === 'object' && 'error' in parsed) {
                    const error = parsed.error;
                    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
                        detail = error.message;
                    }
                }
            } catch {
                if (body.trim()) detail = body.trim().slice(0, 500);
            }
            throw new Error(`OpenAI request failed: ${detail}`);
        }

        const data: unknown = await response.json();
        if (!data || typeof data !== 'object' || !('choices' in data) || !Array.isArray(data.choices)) {
            throw new Error('OpenAI returned an invalid response shape.');
        }
        const message = data.choices[0]?.message;
        if (!message || typeof message !== 'object' || !('content' in message) ||
            typeof message.content !== 'string' || !message.content.trim()) {
            throw new Error('OpenAI returned an empty response.');
        }
        return message.content;
    }
}
