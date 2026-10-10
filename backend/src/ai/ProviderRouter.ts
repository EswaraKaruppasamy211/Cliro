export type LanguageProviderName = 'OPENAI' | 'OLLAMA';

export function selectLanguageProvider(
    requested: unknown,
    openAIConfigured: boolean,
    preferred = 'OLLAMA'
): LanguageProviderName {
    const choice = typeof requested === 'string' ? requested.toUpperCase() : preferred.toUpperCase();
    return choice === 'OPENAI' && openAIConfigured ? 'OPENAI' : 'OLLAMA';
}
