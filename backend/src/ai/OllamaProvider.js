"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OllamaProvider = void 0;
const AIProvider_1 = require("./AIProvider");
class OllamaProvider {
    baseUrl;
    constructor() {
        this.baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    }
    async checkConnection() {
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`);
            return response.ok;
        }
        catch (error) {
            return false;
        }
    }
    async listModels() {
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`);
            if (!response.ok)
                return [];
            const data = await response.json();
            return data.models.map((model) => model.name);
        }
        catch (error) {
            return [];
        }
    }
    async chat(prompt, model) {
        const systemPrompt = `You are CLIRO, a local AI computer agent.
CLIRO means a personal AI computer agent created by the user.
You are running locally through Ollama.
You assist the user with conversation, coding analysis, project understanding,
and computer assistance.
You do not claim to have performed an action unless a CLIRO tool actually
performed and verified it.
You must respect CLIRO's permission system.
You must ask for approval before protected actions.
You must never bypass operating-system or organizational security.`;
        try {
            const response = await fetch(`${this.baseUrl}/api/generate`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: model,
                    prompt: prompt,
                    system: systemPrompt,
                    stream: false
                })
            });
            if (!response.ok) {
                throw new Error('Ollama API error: ' + response.statusText);
            }
            const data = await response.json();
            return data.response;
        }
        catch (error) {
            throw new Error(`Failed to communicate with Ollama: ${error.message}`);
        }
    }
}
exports.OllamaProvider = OllamaProvider;
//# sourceMappingURL=OllamaProvider.js.map