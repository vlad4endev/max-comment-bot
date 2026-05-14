"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.commentService = exports.CommentService = void 0;
const uuid_1 = require("uuid");
const logger_1 = require("../utils/logger");
class CommentService {
    comments = [];
    async create(data) {
        const id = (0, uuid_1.v4)();
        const comment = {
            ...data,
            id,
            createdAt: new Date(),
            status: 'pending',
        };
        this.comments.push(comment);
        logger_1.logger.info(`Комментарий создан: ${id}`);
        return comment;
    }
    async getByPostId(postId, sourceChatId) {
        const list = this.comments.filter((c) => {
            if (c.postId !== postId) {
                return false;
            }
            if (sourceChatId === undefined) {
                return true;
            }
            return c.sourceChatId === sourceChatId;
        });
        logger_1.logger.debug(`${list.length} комментариев`);
        return list;
    }
    /**
     * Количество комментариев, созданных в указанном чате.
     */
    countByChatId(sourceChatId) {
        return this.comments.filter((c) => c.sourceChatId === sourceChatId).length;
    }
    async getById(id) {
        return this.comments.find((c) => c.id === id) ?? null;
    }
    async addReply(id, reply) {
        const comment = this.comments.find((c) => c.id === id);
        if (!comment) {
            throw new Error(`Комментарий не найден: ${id}`);
        }
        comment.reply = reply;
        comment.replyAt = new Date();
        logger_1.logger.info(`Ответ добавлен к ${id}`);
        return comment;
    }
    async markAsApproved(id) {
        const comment = this.comments.find((c) => c.id === id);
        if (!comment) {
            throw new Error(`Комментарий не найден: ${id}`);
        }
        comment.status = 'approved';
        logger_1.logger.info(`Комментарий ${id} одобрен`);
        return comment;
    }
}
exports.CommentService = CommentService;
exports.commentService = new CommentService();
//# sourceMappingURL=commentService.js.map