"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPostTemplates = listPostTemplates;
exports.getPostTemplateById = getPostTemplateById;
exports.createPostTemplate = createPostTemplate;
exports.updatePostTemplate = updatePostTemplate;
exports.deletePostTemplate = deletePostTemplate;
const node_crypto_1 = require("node:crypto");
const postsDatabase_1 = require("../db/postsDatabase");
function rowToTemplate(row) {
    let media = [];
    try {
        const parsed = JSON.parse(row.media_json);
        if (Array.isArray(parsed))
            media = parsed;
    }
    catch {
        /* ignore */
    }
    return {
        id: row.id,
        name: row.name,
        text: row.text,
        media,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}
function listPostTemplates() {
    const rows = (0, postsDatabase_1.getPostsDb)()
        .prepare('SELECT * FROM post_templates ORDER BY name ASC')
        .all();
    return rows.map(rowToTemplate);
}
function getPostTemplateById(id) {
    const row = (0, postsDatabase_1.getPostsDb)().prepare('SELECT * FROM post_templates WHERE id = ?').get(id);
    return row ? rowToTemplate(row) : null;
}
function createPostTemplate(input) {
    const id = (0, node_crypto_1.randomUUID)();
    const now = new Date().toISOString();
    (0, postsDatabase_1.getPostsDb)()
        .prepare(`INSERT INTO post_templates (id, name, text, media_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, input.name, input.text, JSON.stringify(input.media ?? []), now, now);
    return getPostTemplateById(id);
}
function updatePostTemplate(id, patch) {
    const current = getPostTemplateById(id);
    if (!current)
        return null;
    const now = new Date().toISOString();
    (0, postsDatabase_1.getPostsDb)()
        .prepare(`UPDATE post_templates SET name = ?, text = ?, media_json = ?, updated_at = ? WHERE id = ?`)
        .run(patch.name ?? current.name, patch.text ?? current.text, JSON.stringify(patch.media ?? current.media), now, id);
    return getPostTemplateById(id);
}
function deletePostTemplate(id) {
    const result = (0, postsDatabase_1.getPostsDb)().prepare('DELETE FROM post_templates WHERE id = ?').run(id);
    return result.changes > 0;
}
//# sourceMappingURL=postTemplateStore.js.map