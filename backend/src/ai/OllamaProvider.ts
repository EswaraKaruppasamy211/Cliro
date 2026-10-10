import { AIProvider } from './AIProvider';

export class OllamaProvider implements AIProvider {
    private baseUrl: string;
    private readonly requestTimeoutMs = 120_000;
    private readonly healthTimeoutMs = 5_000;
    readonly configuredModel: string;
    
    private systemPrompt = `You are CLIRO, a local AI computer agent.
CLIRO means a personal AI computer agent created by the user.
You are running locally through Ollama.
You assist the user with conversation, coding analysis, project understanding,
and computer assistance.
You do not claim to have performed an action unless a CLIRO tool actually
performed and verified it.
You must respect CLIRO's permission system.
You must ask for approval before protected actions.
You must never bypass operating-system or organizational security.
Do not invent facts, names, dates, statistics, citations, or sources.
Do not claim to have checked a source unless a CLIRO verification result
explicitly supplied one. For uncertain stable facts, say that you are not
confident rather than guessing. Current and time-sensitive questions are
verified separately by CLIRO and must not be answered from memory.
Please be concise and direct.`;

    constructor() {
        this.baseUrl = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
        this.configuredModel = process.env.OLLAMA_MODEL || 'qwen3:4b';
    }

    private async responseError(response: Response): Promise<string> {
        const body = await response.text().catch(() => '');
        if (body) {
            try {
                const data: unknown = JSON.parse(body);
                if (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string') {
                    return data.error;
                }
            } catch {
                return body.trim();
            }
            return body.trim();
        }
        return response.statusText || `HTTP ${response.status}`;
    }

    async checkConnection(): Promise<boolean> {
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`, {
                signal: AbortSignal.timeout(this.healthTimeoutMs)
            });
            return response.ok;
        } catch (error) {
            return false;
        }
    }

    async listModels(): Promise<string[]> {
        const response = await fetch(`${this.baseUrl}/api/tags`, {
            signal: AbortSignal.timeout(this.healthTimeoutMs)
        });
        if (!response.ok) {
            throw new Error(`Ollama model listing failed: ${await this.responseError(response)}`);
        }
        const data: unknown = await response.json();
        if (!data || typeof data !== 'object' || !('models' in data) || !Array.isArray(data.models)) {
            throw new Error('Ollama returned an invalid model list.');
        }
        return data.models
            .filter((model): model is { name: string } =>
                Boolean(model) && typeof model === 'object' && 'name' in model && typeof model.name === 'string')
            .map(model => model.name);
    }

    async chat(prompt: string, model: string): Promise<string> {
        return this.generate(prompt, model, 2048, 300);
    }

    async chatForCodeGeneration(prompt: string, model: string): Promise<string> {
        return this.generate(prompt, model, 16384, 8192);
    }

    private async generate(prompt: string, model: string, contextTokens: number, responseTokens: number): Promise<string> {
        try {
            const response = await fetch(`${this.baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(this.requestTimeoutMs),
                body: JSON.stringify({
                    model: model,
                    prompt: prompt,
                    system: this.systemPrompt,
                    stream: false,
                    keep_alive: '10m',
                    options: {
                        num_ctx: contextTokens,
                        num_predict: responseTokens
                    }
                })
            });
            
            if (!response.ok) {
                throw new Error(`Ollama API error: ${await this.responseError(response)}`);
            }
            
            const data = await response.json();
            if (typeof data.response !== 'string' || !data.response.trim()) {
                throw new Error('Ollama returned an empty response.');
            }
            return data.response;
        } catch (error: any) {
            throw new Error(`Failed to communicate with Ollama: ${error.message}`);
        }
    }

    async chatStream(prompt: string, model: string, onChunk: (chunk: string) => void): Promise<void> {
        try {
            const response = await fetch(`${this.baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(this.requestTimeoutMs),
                body: JSON.stringify({
                    model: model,
                    prompt: prompt,
                    system: this.systemPrompt,
                    stream: true,
                    keep_alive: '10m',
                    options: {
                        num_ctx: 2048,
                        num_predict: 300
                    }
                })
            });
            
            if (!response.ok) {
                throw new Error(`Ollama API streaming error: ${await this.responseError(response)}`);
            }
            if (!response.body) {
                throw new Error('Ollama returned no streaming response body.');
            }
            
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            let receivedResponse = false;
            let streamDone = false;
            
            while (!streamDone) {
                const { value, done } = await reader.read();
                streamDone = done;
                if (value) {
                    buffer += decoder.decode(value, { stream: !done });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    if (done && buffer.trim()) lines.push(buffer);
                    for (const line of lines.filter(item => item.trim() !== '')) {
                        try {
                            const parsed = JSON.parse(line);
                            if (parsed.response) {
                                receivedResponse = true;
                                onChunk(parsed.response);
                            }
                            if (typeof parsed.error === 'string' && parsed.error) {
                                throw new Error(parsed.error);
                            }
                        } catch (error) {
                            if (error instanceof Error && error.message !== 'Unexpected end of JSON input') throw error;
                            throw new Error('Ollama returned invalid streaming data.');
                        }
                    }
                }
            }
            if (!receivedResponse) {
                throw new Error('Ollama returned an empty streaming response.');
            }
        } catch (error: any) {
            throw new Error(`Stream failed: ${error.message}`);
        }
    }
}
