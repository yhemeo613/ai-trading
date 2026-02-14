#!/usr/bin/env node
/**
 * 重置数据库脚本
 * 用法: node scripts/reset-db.js [testnet|mainnet|all]
 * 默认重置所有数据库
 */

const fs = require('fs');
const path = require('path');

const DB_DIR = path.resolve(__dirname, '..', 'data');
const arg = (process.argv[2] || 'all').toLowerCase();

const dbSets = {
  testnet: ['trading_testnet.db', 'trading_testnet.db-shm', 'trading_testnet.db-wal'],
  mainnet: ['trading_mainnet.db', 'trading_mainnet.db-shm', 'trading_mainnet.db-wal'],
  // 兼容旧版数据库文件
  legacy: ['trading.db', 'trading.db-shm', 'trading.db-wal'],
};

let targets;
if (arg === 'testnet') {
  targets = { testnet: dbSets.testnet };
  console.log('=== 重置测试网数据库 ===\n');
} else if (arg === 'mainnet') {
  targets = { mainnet: dbSets.mainnet };
  console.log('=== 重置实盘数据库 ===\n');
} else {
  targets = dbSets;
  console.log('=== 重置所有数据库 ===\n');
}

let deleted = 0;
for (const [name, files] of Object.entries(targets)) {
  for (const file of files) {
    const fp = path.join(DB_DIR, file);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
      console.log(`已删除: ${fp}`);
      deleted++;
    }
  }
}

if (deleted === 0) {
  console.log('数据库文件不存在，无需重置');
} else {
  console.log(`\n已删除 ${deleted} 个文件，下次启动时会自动重建数据库`);
}
