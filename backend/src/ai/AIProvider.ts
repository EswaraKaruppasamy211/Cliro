export interface AIProvider {
    checkConnection(): Promise<boolean>;
    listModels(): Promise<string[]>;
    chat(prompt: string, model: string): Promise<string>;
    chatStream?(prompt: string, model: string, onChunk: (chunk: string) => void): Promise<void>;
}
