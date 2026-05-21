type CandidateReason = 'log:id_mismatch' | 'log:post_lookup_not_found' | 'db:duplicate_abs_chat_mid';
export interface PostLinkCandidate {
    post_id?: string;
    chat_id?: number;
    message_mid?: string;
    reasons: CandidateReason[];
    signals: number;
}
export interface PostLinkDiagnosis {
    signals_total: number;
    id_mismatch: number;
    post_lookup_not_found: number;
    orphan_comment_post_refs: number;
    duplicate_abs_chat_mid: number;
    candidates: PostLinkCandidate[];
}
export declare function diagnosePostLinks(chatIdFilter?: number): Promise<PostLinkDiagnosis>;
export {};
