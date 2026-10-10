"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const OllamaProvider_1 = require("./ai/OllamaProvider");
const systemStatus_1 = require("./system/systemStatus");
dotenv_1.default.config();
const app = (0, express_1.default)();
const port = process.env.PORT || 3001;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const aiProvider = new OllamaProvider_1.OllamaProvider();
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        system: (0, systemStatus_1.getSystemStatus)()
    });
});
app.get('/api/ai/connection', async (req, res) => {
    const isConnected = await aiProvider.checkConnection();
    res.json({ connected: isConnected });
});
app.get('/api/ai/models', async (req, res) => {
    const models = await aiProvider.listModels();
    res.json({ models });
});
app.post('/api/ai/chat', async (req, res) => {
    const { prompt, model } = req.body;
    if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
    }
    const selectedModel = model || process.env.OLLAMA_MODEL || 'llama2';
    try {
        const response = await aiProvider.chat(prompt, selectedModel);
        res.json({ response });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.listen(port, () => {
    console.log(`CLIRO Backend running on http://localhost:${port}`);
});
//# sourceMappingURL=index.js.map