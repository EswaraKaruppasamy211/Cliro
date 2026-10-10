export interface AIProvider {
    checkConnection(): Promise<boolean>;
    listModels(): Promise<string[]>;
    chat(prompt: string, model: string): Promise<string>;
}
//# sourceMappingURL=AIProvider.d.ts.map