import { AIProvider } from './AIProvider';
export declare class OllamaProvider implements AIProvider {
    private baseUrl;
    constructor();
    checkConnection(): Promise<boolean>;
    listModels(): Promise<string[]>;
    chat(prompt: string, model: string): Promise<string>;
}
//# sourceMappingURL=OllamaProvider.d.ts.map