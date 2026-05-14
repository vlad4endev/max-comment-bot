import { v4 as uuidv4 } from 'uuid'

import { logger } from '../utils/logger'

export interface Comment {
  id: string
  /** Чат, из которого пришёл комментарий (изоляция между каналами) */
  sourceChatId: number
  postId: string
  userId: number
  userName: string
  text: string
  createdAt: Date
  status: 'pending' | 'approved' | 'rejected'
  reply?: string
  replyAt?: Date
}

export class CommentService {
  private comments: Comment[] = []

  async create(
    data: Omit<Comment, 'id' | 'createdAt' | 'status'>,
  ): Promise<Comment> {
    const id = uuidv4()
    const comment: Comment = {
      ...data,
      id,
      createdAt: new Date(),
      status: 'pending',
    }
    this.comments.push(comment)
    logger.info(`Комментарий создан: ${id}`)
    return comment
  }

  async getByPostId(postId: string, sourceChatId?: number): Promise<Comment[]> {
    const list = this.comments.filter((c) => {
      if (c.postId !== postId) {
        return false
      }
      if (sourceChatId === undefined) {
        return true
      }
      return c.sourceChatId === sourceChatId
    })
    logger.debug(`${list.length} комментариев`)
    return list
  }

  /**
   * Количество комментариев, созданных в указанном чате.
   */
  countByChatId(sourceChatId: number): number {
    return this.comments.filter((c) => c.sourceChatId === sourceChatId).length
  }

  async getById(id: string): Promise<Comment | null> {
    return this.comments.find((c) => c.id === id) ?? null
  }

  async addReply(id: string, reply: string): Promise<Comment> {
    const comment = this.comments.find((c) => c.id === id)
    if (!comment) {
      throw new Error(`Комментарий не найден: ${id}`)
    }
    comment.reply = reply
    comment.replyAt = new Date()
    logger.info(`Ответ добавлен к ${id}`)
    return comment
  }

  async markAsApproved(id: string): Promise<Comment> {
    const comment = this.comments.find((c) => c.id === id)
    if (!comment) {
      throw new Error(`Комментарий не найден: ${id}`)
    }
    comment.status = 'approved'
    logger.info(`Комментарий ${id} одобрен`)
    return comment
  }
}

export const commentService = new CommentService()
