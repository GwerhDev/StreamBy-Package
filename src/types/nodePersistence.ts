import { NodePersistence } from './index';

// Only node types that write to a real database/storage connection need an entry here.
// Process nodes (transcodeNode, captionNode, etc.) operate on a fileId already resolved by
// the internal job pipeline (mediaProcessor.ts), not directly on project connections, so
// they're 'none' — same for filter/deliverable/distribution/annotation/connection nodes.
export const NODE_PERSISTENCE: Record<string, NodePersistence> = {
  dataSourceNode: 'database',
  ingestNode: 'storage',
};

export function getNodePersistence(nodeType: string): NodePersistence {
  return NODE_PERSISTENCE[nodeType] ?? 'none';
}
