"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDashboardPeriodDays = parseDashboardPeriodDays;
exports.buildDashboardAnalytics = buildDashboardAnalytics;
const database_1 = require("../db/database");
const channelNotifyLinkStore_1 = require("./channelNotifyLinkStore");
const channelRegistry_1 = require("./channelRegistry");
const commentStore_1 = require("./commentStore");
const postStore_1 = require("./postStore");
const stateManager_1 = require("./stateManager");
const subscriberStore_1 = require("./subscriberStore");
const userMiniappSettingsStore_1 = require("./userMiniappSettingsStore");
function parsePeriodDays(raw) {
    const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : 7;
    if (n === 30) {
        return 30;
    }
    if (n === 0) {
        return 0;
    }
    return 7;
}
function periodCutoffIso(days) {
    if (days === 0) {
        return null;
    }
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString();
}
function clampPct(n) {
    if (!Number.isFinite(n)) {
        return 0;
    }
    return Math.min(100, Math.max(0, Math.round(n * 10) / 10));
}
function gradeFromScore(score) {
    if (score >= 75) {
        return 'excellent';
    }
    if (score >= 50) {
        return 'good';
    }
    if (score >= 30) {
        return 'fair';
    }
    return 'low';
}
function labelFromGrade(grade) {
    switch (grade) {
        case 'excellent':
            return 'Высокая эффективность';
        case 'good':
            return 'Хорошая эффективность';
        case 'fair':
            return 'Средняя эффективность';
        default:
            return 'Низкая эффективность';
    }
}
function buildInsights(metrics) {
    const out = [];
    if (metrics.channels_pending > 0) {
        out.push(`${metrics.channels_pending} канал(ов) ждут прав администратора — бот не может ставить кнопки комментариев.`);
    }
    if (metrics.reply_rate < 40) {
        out.push('Мало ответов админов на комментарии — отвечайте в мини-приложении, чтобы удерживать аудиторию.');
    }
    else if (metrics.reply_rate >= 70) {
        out.push('Высокий процент ответов админов — отличная работа с обратной связью.');
    }
    if (metrics.engagement_rate < 0.3) {
        out.push('Мало комментариев на пост — проверьте, что кнопки «Комментарии» видны под публикациями.');
    }
    else if (metrics.engagement_rate >= 1.5) {
        out.push('Высокая вовлечённость: в среднем больше одного комментария на пост.');
    }
    if (metrics.coverage_rate < 50) {
        out.push('Не все каналы получают комментарии — продвигайте кнопку комментариев в постах.');
    }
    if (metrics.activation_rate < 5 && metrics.activation_rate >= 0) {
        out.push('Мало подписчиков бота пишут комментарии — напомните про /start и уведомления.');
    }
    if (metrics.posts_with_comments_pct < 30) {
        out.push('Большинство постов без комментариев — усильте призыв к обсуждению в канале.');
    }
    if (out.length === 0) {
        out.push('Показатели в норме. Следите за активностью по каналам и отвечайте на комментарии.');
    }
    return out.slice(0, 4);
}
function parseDashboardPeriodDays(raw) {
    return parsePeriodDays(raw);
}
function buildDashboardAnalytics(periodDays) {
    const cutoff = periodCutoffIso(periodDays);
    const db = (0, database_1.getDb)();
    const channels = channelRegistry_1.channelRegistry.getAllChannels().filter((c) => c.type === 'channel');
    const channelCount = channels.length;
    let channelsPending = 0;
    for (const ch of channels) {
        if (stateManager_1.stateManager.isChannelPendingAdminRights(ch.chat_id)) {
            channelsPending += 1;
        }
    }
    const channelsActive = channelCount - channelsPending;
    const totalPosts = postStore_1.postStore.getTotalPostCount();
    const totalComments = commentStore_1.commentStore.totalCount;
    const botSubscribers = subscriberStore_1.subscriberStore.getAllSubscribers().length;
    const postsInPeriod = cutoff
        ? Number(db.prepare('SELECT COUNT(*) AS n FROM posts WHERE timestamp >= ?').get(cutoff).n) || 0
        : totalPosts;
    const commentsInPeriod = cutoff
        ? Number(db.prepare('SELECT COUNT(*) AS n FROM comments WHERE timestamp >= ?').get(cutoff).n) || 0
        : totalComments;
    const adminRepliesInPeriod = countRepliesAll(db, cutoff);
    const subscribersInPeriod = cutoff
        ? Number(db.prepare('SELECT COUNT(*) AS n FROM subscribers WHERE created_at >= ?').get(cutoff)
            .n) || 0
        : botSubscribers;
    const uniqueCommentersInPeriod = cutoff
        ? Number(db
            .prepare('SELECT COUNT(DISTINCT user_id) AS n FROM comments WHERE timestamp >= ?')
            .get(cutoff).n) || 0
        : Number(db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM comments').get().n) || 0;
    const uniqueCommentersAll = Number(db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM comments').get().n) || 0;
    const notifyLinks = channelNotifyLinkStore_1.channelNotifyLinkStore.getAllLinks();
    const miniappUsers = userMiniappSettingsStore_1.userMiniappSettingsStore.getAllUserIdsWithSettings().length;
    const engagementRate = totalPosts > 0 ? totalComments / totalPosts : 0;
    const repliedAll = adminRepliesInPeriod;
    const commentsForReplyRate = cutoff ? commentsInPeriod : totalComments;
    const replyRateCorrect = commentsForReplyRate > 0 ? repliedAll / commentsForReplyRate : 0;
    const channelsWithComments = db.prepare(`SELECT COUNT(DISTINCT p.chat_id) AS n
       FROM comments c
       INNER JOIN posts p ON p.post_id = c.post_id`).get().n;
    const coverageRate = channelCount > 0 ? (channelsWithComments / channelCount) * 100 : 0;
    const postsWithComments = db.prepare(`SELECT COUNT(DISTINCT post_id) AS n FROM comments`).get().n;
    const postsWithCommentsPct = totalPosts > 0 ? (postsWithComments / totalPosts) * 100 : 0;
    const activationRate = botSubscribers > 0 ? (uniqueCommentersAll / botSubscribers) * 100 : 0;
    const scoreEngagement = Math.min(100, engagementRate * 25);
    const scoreReply = replyRateCorrect * 100;
    const scoreCoverage = coverageRate;
    const scoreActivation = Math.min(100, activationRate * 2);
    const score = Math.round(scoreEngagement * 0.3 + scoreReply * 0.25 + scoreCoverage * 0.25 + scoreActivation * 0.2);
    const grade = gradeFromScore(score);
    const effectiveness = {
        score,
        grade,
        label: labelFromGrade(grade),
        engagement_rate: Math.round(engagementRate * 100) / 100,
        reply_rate: clampPct(replyRateCorrect * 100),
        coverage_rate: clampPct(coverageRate),
        activation_rate: clampPct(activationRate),
        posts_with_comments_pct: clampPct(postsWithCommentsPct),
        insights: buildInsights({
            engagement_rate: engagementRate,
            reply_rate: replyRateCorrect * 100,
            coverage_rate: coverageRate,
            activation_rate: activationRate,
            posts_with_comments_pct: postsWithCommentsPct,
            channels_pending: channelsPending,
        }),
    };
    const timeseries = buildTimeseries(db, periodDays, cutoff);
    const notifyByChat = new Map();
    for (const link of notifyLinks) {
        notifyByChat.set(link.channel_chat_id, (notifyByChat.get(link.channel_chat_id) ?? 0) + 1);
    }
    const channelRows = [];
    for (const ch of channels) {
        const stats = queryChannelStats(db, ch.chat_id, cutoff);
        const postCount = stats.post_count;
        const commentCount = stats.comment_count;
        const engagement = postCount > 0 ? commentCount / postCount : 0;
        const replyRateCh = commentCount > 0 ? (stats.replied_count / commentCount) * 100 : 0;
        channelRows.push({
            chat_id: ch.chat_id,
            title: ch.title,
            status: stateManager_1.stateManager.isChannelPendingAdminRights(ch.chat_id) ? 'pending' : 'active',
            post_count: postCount,
            comment_count: commentCount,
            posts_in_period: stats.posts_in_period,
            comments_in_period: stats.comments_in_period,
            unique_commenters: stats.unique_commenters,
            replied_count: stats.replied_count,
            reply_rate: clampPct(replyRateCh),
            engagement_rate: Math.round(engagement * 100) / 100,
            notify_links: notifyByChat.get(ch.chat_id) ?? 0,
            last_activity_at: stats.last_activity_at,
        });
    }
    channelRows.sort((a, b) => {
        const ac = a.comments_in_period;
        const bc = b.comments_in_period;
        if (bc !== ac) {
            return bc - ac;
        }
        return b.comment_count - a.comment_count;
    });
    return {
        period_days: periodDays,
        generated_at: new Date().toISOString(),
        totals: {
            channels: channelCount,
            channels_active: channelsActive,
            channels_pending: channelsPending,
            bot_subscribers: botSubscribers,
            posts: totalPosts,
            comments: totalComments,
            posts_in_period: postsInPeriod,
            comments_in_period: commentsInPeriod,
            admin_replies_in_period: adminRepliesInPeriod,
            subscribers_in_period: subscribersInPeriod,
            unique_commenters_in_period: uniqueCommentersInPeriod || 0,
            unique_commenters_all: uniqueCommentersAll,
        },
        funnel: {
            bot_subscribers: botSubscribers,
            notify_opt_ins: notifyLinks.length,
            unique_commenters: uniqueCommentersAll,
            miniapp_users: miniappUsers,
        },
        effectiveness,
        timeseries,
        channels: channelRows,
    };
}
function countRepliesAll(db, cutoff) {
    if (!cutoff) {
        return db.prepare('SELECT COUNT(*) AS n FROM comments WHERE reply IS NOT NULL').get()
            .n;
    }
    return db.prepare('SELECT COUNT(*) AS n FROM comments WHERE timestamp >= ? AND reply IS NOT NULL').get(cutoff).n;
}
function queryChannelStats(db, chatId, cutoff) {
    const base = db
        .prepare(`SELECT
        (SELECT COUNT(*) FROM posts WHERE chat_id = ?) AS post_count,
        (SELECT COUNT(*) FROM comments c INNER JOIN posts p ON p.post_id = c.post_id WHERE p.chat_id = ?) AS comment_count,
        (SELECT COUNT(DISTINCT c.user_id) FROM comments c INNER JOIN posts p ON p.post_id = c.post_id WHERE p.chat_id = ?) AS unique_commenters,
        (SELECT COUNT(*) FROM comments c INNER JOIN posts p ON p.post_id = c.post_id WHERE p.chat_id = ? AND c.reply IS NOT NULL) AS replied_count,
        (SELECT MAX(c.timestamp) FROM comments c INNER JOIN posts p ON p.post_id = c.post_id WHERE p.chat_id = ?) AS last_comment,
        (SELECT MAX(timestamp) FROM posts WHERE chat_id = ?) AS last_post`)
        .get(chatId, chatId, chatId, chatId, chatId, chatId);
    let postsInPeriod = base.post_count;
    let commentsInPeriod = base.comment_count;
    if (cutoff) {
        postsInPeriod = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE chat_id = ? AND timestamp >= ?').get(chatId, cutoff).n;
        commentsInPeriod = db
            .prepare(`SELECT COUNT(*) AS n FROM comments c
           INNER JOIN posts p ON p.post_id = c.post_id
           WHERE p.chat_id = ? AND c.timestamp >= ?`)
            .get(chatId, cutoff).n;
    }
    let lastActivity = null;
    if (base.last_comment && base.last_post) {
        lastActivity = base.last_comment > base.last_post ? base.last_comment : base.last_post;
    }
    else {
        lastActivity = base.last_comment ?? base.last_post ?? null;
    }
    return {
        post_count: Number(base.post_count) || 0,
        comment_count: Number(base.comment_count) || 0,
        posts_in_period: Number(postsInPeriod) || 0,
        comments_in_period: Number(commentsInPeriod) || 0,
        unique_commenters: Number(base.unique_commenters) || 0,
        replied_count: Number(base.replied_count) || 0,
        last_activity_at: lastActivity,
    };
}
function buildTimeseries(db, periodDays, cutoff) {
    const days = [];
    const span = periodDays === 0 ? 30 : periodDays;
    const now = new Date();
    for (let i = span - 1; i >= 0; i--) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
        const key = d.toISOString().slice(0, 10);
        days.push({ date: key, comments: 0, posts: 0, subscribers: 0 });
    }
    const commentRows = cutoff
        ? db
            .prepare(`SELECT substr(timestamp, 1, 10) AS day, COUNT(*) AS n
           FROM comments WHERE timestamp >= ? GROUP BY day`)
            .all(cutoff)
        : db
            .prepare(`SELECT substr(timestamp, 1, 10) AS day, COUNT(*) AS n FROM comments GROUP BY day`)
            .all();
    const postRows = cutoff
        ? db
            .prepare(`SELECT substr(timestamp, 1, 10) AS day, COUNT(*) AS n
           FROM posts WHERE timestamp >= ? GROUP BY day`)
            .all(cutoff)
        : db
            .prepare(`SELECT substr(timestamp, 1, 10) AS day, COUNT(*) AS n FROM posts GROUP BY day`)
            .all();
    const subRows = cutoff
        ? db
            .prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
           FROM subscribers WHERE created_at >= ? GROUP BY day`)
            .all(cutoff)
        : db
            .prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM subscribers GROUP BY day`)
            .all();
    const byDate = new Map(days.map((p) => [p.date, p]));
    for (const r of commentRows) {
        const cell = byDate.get(r.day);
        if (cell) {
            cell.comments = Number(r.n) || 0;
        }
    }
    for (const r of postRows) {
        const cell = byDate.get(r.day);
        if (cell) {
            cell.posts = Number(r.n) || 0;
        }
    }
    for (const r of subRows) {
        const cell = byDate.get(r.day);
        if (cell) {
            cell.subscribers = Number(r.n) || 0;
        }
    }
    if (periodDays === 0) {
        return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-30);
    }
    return days;
}
//# sourceMappingURL=analyticsService.js.map