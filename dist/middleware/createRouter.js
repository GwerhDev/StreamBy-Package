"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStreamByRouter = createStreamByRouter;
const express_1 = __importDefault(require("express"));
const s3_1 = require("../adapters/s3");
function createStreamByRouter(config) {
    const router = express_1.default.Router();
    const adapter = (() => {
        switch (config.storageProvider.type) {
            case 's3':
                return (0, s3_1.createS3Adapter)(config.storageProvider.config);
            default:
                throw new Error('Unsupported storage type');
        }
    })();
    router.get('/files', async (req, res) => {
        try {
            const auth = await config.authProvider(req);
            const files = await adapter.listFiles(auth.projectId);
            res.json(files);
        }
        catch (err) {
            res.status(500).json({ error: 'Failed to list files', details: err });
        }
    });
    router.post('/upload', async (req, res) => {
        try {
            const auth = await config.authProvider(req);
            const result = await adapter.uploadFile(req, auth.projectId);
            res.json(result);
        }
        catch (err) {
            res.status(500).json({ error: 'Failed to upload file', details: err });
        }
    });
    return router;
}
