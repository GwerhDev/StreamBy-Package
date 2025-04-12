import { Router } from 'express';
import { StreamByConfig, StorageAdapter } from '../types';
export declare function createStreamByRouter(config: StreamByConfig & {
    adapter?: StorageAdapter;
}): Router;
