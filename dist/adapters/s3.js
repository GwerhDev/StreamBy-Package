"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createS3Adapter = createS3Adapter;
const client_s3_1 = require("@aws-sdk/client-s3");
function createS3Adapter(config) {
    const s3 = new client_s3_1.S3Client({
        region: config.region,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
    });
    return {
        async uploadFile(req, projectId) {
            const file = req.body.file;
            const command = new client_s3_1.PutObjectCommand({
                Bucket: config.bucket,
                Key: `${projectId}/${file.name}`,
                Body: file.buffer,
            });
            await s3.send(command);
            return { success: true, key: command.input.Key };
        },
        async listFiles(projectId) {
            const command = new client_s3_1.ListObjectsV2Command({
                Bucket: config.bucket,
                Prefix: `${projectId}/`
            });
            const result = await s3.send(command);
            return result.Contents || [];
        },
    };
}
