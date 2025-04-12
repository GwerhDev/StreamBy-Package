"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveAuth = resolveAuth;
exports.checkRole = checkRole;
async function resolveAuth(config, req) {
    const auth = await config.authProvider(req);
    if (!auth || !auth.userId || !auth.projectId || !auth.role) {
        throw new Error('Invalid or missing authentication context');
    }
    return auth;
}
function checkRole(auth, required) {
    const roles = ['viewer', 'editor', 'admin'];
    const userIdx = roles.indexOf(auth.role);
    const requiredIdx = roles.indexOf(required);
    if (userIdx < requiredIdx) {
        throw new Error(`Insufficient role: requires ${required}, found ${auth.role}`);
    }
}
