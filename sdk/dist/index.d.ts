export type AppWeaveError = {
    code: string;
    message: string;
    requestId?: string;
};
export declare class AppWeaveRequestError extends Error {
    readonly details: AppWeaveError;
    readonly status: number;
    constructor(details: AppWeaveError, status: number);
}
export type AppWeaveClientOptions = {
    baseUrl: string;
    publicClientId: string;
    token?: string;
};
export declare function createAppWeaveClient(options: AppWeaveClientOptions): {
    setToken(value: string | undefined): void;
    register(email: string, password: string): Promise<{
        user: {
            id: string;
            email: string;
        };
        token: string;
    }>;
    login(email: string, password: string): Promise<{
        user: {
            id: string;
            email: string;
        };
        token: string;
    }>;
    projects(): Promise<{
        projects: unknown[];
    }>;
    products(projectId: string): Promise<{
        products: unknown[];
    }>;
    createProduct(projectId: string, product: {
        name: string;
        sku: string;
        price: number;
        description?: string;
    }): Promise<unknown>;
    api<T = unknown>(path: string, init?: RequestInit): Promise<T>;
};
