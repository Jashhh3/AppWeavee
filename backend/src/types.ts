export type User = { id: string; email: string; passwordHash: string; createdAt: string };
export type Project = { id: string; ownerId: string; name: string; environment: 'development'|'preview'|'production'; publicClientId: string; previewUrl: string; productionUrl: string; createdAt: string; updatedAt: string };
export type Product = { id: string; projectId: string; name: string; sku: string; price: number; description?: string; createdAt: string; updatedAt: string };
export type Audit = { id: string; projectId?: string; userId?: string; action: string; requestId: string; metadata: unknown; createdAt: string };
export type AppSpec = { id: string; projectId: string; version: number; schema: unknown; createdAt: string; createdBy: string };
export type Deployment = { id: string; projectId: string; environment: 'preview'|'production'; version: number; status: 'building'|'active'|'failed'|'rolled_back'; url: string; buildId: string; buildLog: string[]; createdAt: string; createdBy: string };
export type Snapshot = { id: string; projectId: string; version: number; reason: string; state: { specs: AppSpec[] }; files: Record<string, string>; commitSha?: string; createdAt: string; createdBy: string };
export type DB = { users: User[]; projects: Project[]; products: Product[]; audits: Audit[]; specs: AppSpec[]; deployments: Deployment[]; snapshots: Snapshot[] };
