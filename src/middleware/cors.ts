
import { Request, Response, NextFunction } from 'express';
import { getModel } from '../models/manager';

export const projectOriginMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    const projectId = req.params.projectId;
    const origin = req.headers.origin;

    if (!projectId) {
        return next();
    }

    if (!origin) {
        return res.status(403).json({ message: 'Origin header is required' });
    }

    try {
        const Project = getModel('projects');
        const project = await Project.findOne({ id: projectId });

        if (!project) {
            return res.status(404).json({ message: 'Project not found' });
        }

        if (project.allowedOrigin && project.allowedOrigin.length > 0) {
            // Allow if public ('*') or origin is in the list
            if (project.allowedOrigin.includes('*') || project.allowedOrigin.includes(origin)) {
                res.header('Access-Control-Allow-Origin', origin);
                res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
                res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
                return next();
            } else {
                return res.status(403).json({ message: 'Origin not allowed' });
            }
        } else {
            // If allowedOrigin is empty, deny access for security.
            return res.status(403).json({ message: 'Origin not allowed' });
        }
    } catch (error) {
        console.error('Error in projectOriginMiddleware:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};
