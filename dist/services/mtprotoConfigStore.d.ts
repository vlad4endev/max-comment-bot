export interface MtprotoConfigFile {
    apiId: number;
    apiHash: string;
    session: string;
    phone?: string;
    userId?: string;
    userDisplay?: string;
    updatedAt?: string;
}
export type MtprotoCredentialSource = 'file' | 'env' | 'mixed' | 'none';
export interface ResolvedMtprotoCredentials {
    apiId: number | null;
    apiHash: string;
    session: string;
    source: MtprotoCredentialSource;
}
export declare function readMtprotoConfigFile(): MtprotoConfigFile | null;
export declare function writeMtprotoConfigFile(patch: Partial<MtprotoConfigFile>): MtprotoConfigFile;
export declare function clearMtprotoSession(): void;
export declare function deleteMtprotoConfigFile(): void;
export declare function resolveMtprotoCredentials(): ResolvedMtprotoCredentials;
export declare function maskPhone(phone: string): string;
