import path from 'path';
import dotenv from 'dotenv';

export interface BackendEnvironmentStatus {
    envFilePath: string;
    openAIKeyConfigured: boolean;
    imageGenerationProviderConfigured: boolean;
}

export function loadBackendEnvironment(backendDirectory: string): BackendEnvironmentStatus {
    const envFilePath = path.resolve(backendDirectory, '.env');
    const result = dotenv.config({ path: envFilePath });
    if (result.error && !('code' in result.error && result.error.code === 'ENOENT')) {
        throw result.error;
    }

    return {
        envFilePath,
        openAIKeyConfigured: typeof process.env.OPENAI_API_KEY === 'string' &&
            process.env.OPENAI_API_KEY.trim().length > 0,
        imageGenerationProviderConfigured: process.env.IMAGE_GENERATION_PROVIDER?.trim().toLowerCase() === 'openai'
    };
}
