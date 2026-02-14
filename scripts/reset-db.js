#!/usr/bin/env node
/**
 * 重置数据库脚本
 * 用法: npx ts-node scripts/reset-db.ts
 * 或:   node scripts/reset-db.js (编译后)
 */

const fs = require('fs');
const path = require('path');

const DB_DIR = path.resolve(__dirname, '..', 'data');
const files = ['trading.db', 'trading.db-shm', 'trading.db-wal'];

console.log('=== 重置数据库 ===\n');

let deleted = 0;
for (const file of files) {
  const fp = path.join(DB_DIR, file);
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp);
    console.log(`已删除: ${fp}`);
    deleted++;
  }
}

if (deleted === 0) {
  console.log('数据库文件不存在，无需重置');
} else {
  console.log(`\n已删除 ${deleted} 个文件，下次启动时会自动重建数据库`);
}
