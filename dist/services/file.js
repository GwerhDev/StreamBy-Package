"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listFilesService = listFilesService;
exports.uploadFileService = uploadFileService;
async function listFilesService(adapter, req, projectId) {
    return adapter.listFiles(projectId);
}
async function uploadFileService(adapter, req, projectId) {
    return adapter.uploadFile(req, projectId);
}
