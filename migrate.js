/**
 * MongoDB Atlas → Railway migration (full database copy with indexes).
 * Preserves _id (ObjectIds), embedded dates, and index definitions.
 *
 * Usage:
 *   npm install
 *   node migrate.js
 *
 * Env:
 *   MIGRATION_CHUNK_SIZE   — docs per batch (default 500)
 *   MIGRATION_DROP_DEST    — if "1"/"true", drop each destination collection before copy (default true)
 */

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const SOURCE_URI =
  process.env.MIGRATION_SOURCE_URI ||
  'mongodb://hybridnova:123456%40@ac-1qfctr2-shard-00-00.tbvinjk.mongodb.net:27017,ac-1qfctr2-shard-00-01.tbvinjk.mongodb.net:27017,ac-1qfctr2-shard-00-02.tbvinjk.mongodb.net:27017/povanft?ssl=true&replicaSet=atlas-sn6u1m-shard-0&authSource=admin&retryWrites=true&w=majority';

const DEST_URI =
  process.env.MIGRATION_DEST_URI ||
  'mongodb://mongo:suYzsszeaRsrTZtyHOGOqDwoceLicXiJ@yamanote.proxy.rlwy.net:56289';

const SYSTEM_DBS = new Set(['admin', 'local', 'config']);
const LOG_FILE = path.join(__dirname, 'migration-log.json');

const CHUNK_SIZE = Math.max(
  1,
  parseInt(process.env.MIGRATION_CHUNK_SIZE || '500', 10) || 500,
);

const DROP_DEST =
  !['0', 'false', 'no'].includes(
    String(process.env.MIGRATION_DROP_DEST ?? 'true').toLowerCase(),
  );

function sanitizeIndexSpec(doc) {
  const clone = { ...doc };
  delete clone.v;
  delete clone.ns;
  return clone;
}

async function ensureDestCollection(destDb, meta) {
  const name = meta.name;
  const opts = { ...(meta.options || {}) };
  delete opts.viewOn;
  delete opts.pipeline;

  const capped = Boolean(opts.capped);
  const ts = opts.timeseries;

  const exists = (await destDb.listCollections({ name }).toArray()).length > 0;
  if (exists) return;

  const createOpts = {};
  if (capped) {
    createOpts.capped = true;
    if (opts.size != null) createOpts.size = opts.size;
    if (opts.max != null) createOpts.max = opts.max;
  }
  if (ts) createOpts.timeseries = ts;
  if (opts.collation) createOpts.collation = opts.collation;
  if (opts.changeStreamPreAndPostImages)
    createOpts.changeStreamPreAndPostImages = opts.changeStreamPreAndPostImages;
  if (opts.clusteredIndex) createOpts.clusteredIndex = opts.clusteredIndex;

  if (Object.keys(createOpts).length > 0) {
    await destDb.createCollection(name, createOpts);
  }
}

async function copyCollectionIndexes(sourceColl, destColl, ns, entry, errors) {
  const raw = await sourceColl.listIndexes().toArray();
  const specs = raw
    .filter((ix) => ix.name && ix.name !== '_id_')
    .map(sanitizeIndexSpec);

  if (specs.length === 0) {
    entry.indexesCreated = 0;
    return;
  }

  try {
    await destColl.createIndexes(specs);
    entry.indexesCreated = specs.length;
  } catch (err) {
    entry.indexError = { message: err.message, code: err.code };
    errors.push({
      phase: 'indexes',
      ns,
      message: err.message,
      code: err.code,
    });
  }
}

async function migrateCollection(sourceDb, destDb, meta, log) {
  const collName = meta.name;
  const ns = `${sourceDb.databaseName}.${collName}`;
  const entry = {
    namespace: ns,
    database: sourceDb.databaseName,
    collection: collName,
    type: meta.type || 'collection',
    sourceCount: null,
    destCountAfter: null,
    batches: 0,
    docsCopied: 0,
    indexesCreated: null,
    skipped: false,
    error: null,
  };

  if (meta.type === 'view') {
    entry.skipped = true;
    entry.skipReason = 'views are not migrated (require manual createView)';
    console.log(`[skip] ${ns} — view (not supported by this script)`);
    log.collections.push(entry);
    return;
  }

  const sourceColl = sourceDb.collection(collName);
  let destColl = destDb.collection(collName);

  let sourceCount;
  try {
    try {
      sourceCount = await sourceColl.countDocuments({});
    } catch {
      sourceCount = await sourceColl.estimatedDocumentCount();
    }
    entry.sourceCount = sourceCount;
  } catch (err) {
    entry.error = { message: err.message, code: err.code };
    log.errors.push({ phase: 'count_source', ns, message: err.message });
    console.error(`[error] ${ns} — failed source count: ${err.message}`);
    log.collections.push(entry);
    return;
  }

  console.log(
    `[start] ${ns} — copying ~${sourceCount} document(s), chunk=${CHUNK_SIZE}`,
  );

  try {
    await ensureDestCollection(destDb, meta);

    if (DROP_DEST) {
      await destColl.drop().catch(() => {});
      destColl = destDb.collection(collName);
      await ensureDestCollection(destDb, meta);
    }

    const cursor = sourceColl.find({}, { batchSize: CHUNK_SIZE });
    let batch = [];

    const flush = async () => {
      if (batch.length === 0) return;
      entry.batches += 1;
      try {
        await destColl.insertMany(batch, { ordered: false });
        entry.docsCopied += batch.length;
      } catch (err) {
        if (err.code === 11000 || err.writeErrors) {
          const nonDup = (err.writeErrors || []).filter((e) => e.code !== 11000);
          if (nonDup.length > 0) throw err;
          const inserted =
            batch.length - (err.writeErrors || []).filter((e) => e.code === 11000).length;
          entry.docsCopied += inserted;
        } else {
          throw err;
        }
      }
      batch = [];
    };

    for await (const doc of cursor) {
      batch.push(doc);
      if (batch.length >= CHUNK_SIZE) {
        await flush();
        process.stdout.write(
          `\r[progress] ${ns} — ${entry.docsCopied}/${sourceCount} docs`,
        );
      }
    }
    await flush();
    process.stdout.write(`\r[progress] ${ns} — ${entry.docsCopied}/${sourceCount} docs\n`);

    await copyCollectionIndexes(sourceColl, destColl, ns, entry, log.errors);

    const destCount = await destColl.countDocuments({});
    entry.destCountAfter = destCount;

    const ok = destCount === sourceCount;
    entry.countMatch = ok;
    if (!ok) {
      const msg = `count mismatch: source=${sourceCount} dest=${destCount}`;
      log.errors.push({ phase: 'verify_count', ns, message: msg });
      console.warn(`[warn] ${ns} — ${msg}`);
    } else {
      const ixNote = entry.indexError
        ? ` (index build failed — ${entry.indexError.message})`
        : '';
      console.log(
        `[done] ${ns} — counts OK (${destCount}), secondary indexes: ${entry.indexesCreated ?? 0}${ixNote}`,
      );
    }
  } catch (err) {
    entry.error = { message: err.message, code: err.code };
    log.errors.push({
      phase: 'migrate_collection',
      ns,
      message: err.message,
      code: err.code,
    });
    console.error(`[error] ${ns} — ${err.message}`);
  }

  log.collections.push(entry);
}

async function migrateDatabase(sourceClient, destClient, dbName, log) {
  const sourceDb = sourceClient.db(dbName);
  const destDb = destClient.db(dbName);

  let metas;
  try {
    metas = await sourceDb.listCollections().toArray();
  } catch (err) {
    log.errors.push({
      phase: 'list_collections',
      ns: dbName,
      message: err.message,
    });
    console.error(`[error] listCollections ${dbName}: ${err.message}`);
    return;
  }

  metas.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  log.databases.push({
    name: dbName,
    collectionCount: metas.filter((m) => m.type !== 'view').length,
  });

  console.log(`\n=== Database: ${dbName} (${metas.length} namespace(s)) ===`);

  for (const meta of metas) {
    try {
      await migrateCollection(sourceDb, destDb, meta, log);
    } catch (err) {
      log.errors.push({
        phase: 'migrate_collection_unhandled',
        ns: `${dbName}.${meta.name}`,
        message: err.message,
      });
      console.error(
        `[error] ${dbName}.${meta.name} — unhandled: ${err.message}`,
      );
    }
  }
}

async function main() {
  const log = {
    generatedAt: new Date().toISOString(),
    sourceUriHost: (() => {
      try {
        return new URL(SOURCE_URI.replace(/^mongodb(\+srv)?:\/\//, 'http://'))
          .hostname;
      } catch {
        return null;
      }
    })(),
    destUriHost: (() => {
      try {
        return new URL(DEST_URI.replace(/^mongodb(\+srv)?:\/\//, 'http://'))
          .hostname;
      } catch {
        return null;
      }
    })(),
    chunkSize: CHUNK_SIZE,
    dropDestBeforeCopy: DROP_DEST,
    databases: [],
    collections: [],
    errors: [],
  };

  let sourceClient;
  let destClient;

  try {
    console.log('Connecting to source (Atlas)...');
    sourceClient = new MongoClient(SOURCE_URI, {
      serverSelectionTimeoutMS: 60_000,
    });
    await sourceClient.connect();
    await sourceClient.db().command({ ping: 1 });
    console.log('Source connected.');

    console.log('Connecting to destination (Railway)...');
    destClient = new MongoClient(DEST_URI, {
      serverSelectionTimeoutMS: 60_000,
    });
    await destClient.connect();
    await destClient.db().command({ ping: 1 });
    console.log('Destination connected.');

    const { databases } = await sourceClient.db().admin().listDatabases();
    const userDbs = databases
      .map((d) => d.name)
      .filter((n) => !SYSTEM_DBS.has(n))
      .sort();

    console.log(
      `\nUser databases to migrate: ${userDbs.length ? userDbs.join(', ') : '(none)'}`,
    );

    for (const name of userDbs) {
      await migrateDatabase(sourceClient, destClient, name, log);
    }

    log.summary = {
      databases: log.databases.length,
      collectionsTotal: log.collections.length,
      collectionsDataOk: log.collections.filter(
        (c) => !c.skipped && !c.error && c.countMatch === true,
      ).length,
      collectionsWithErrors: log.collections.filter((c) => c.error).length,
      collectionsIndexIssues: log.collections.filter((c) => c.indexError).length,
      skippedViews: log.collections.filter((c) => c.skipped).length,
      errorEvents: log.errors.length,
    };

    log.finishedAt = new Date().toISOString();
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2), 'utf8');
    console.log(`\nMigration log written to ${LOG_FILE}`);
    console.log('Summary:', JSON.stringify(log.summary, null, 2));

    const blocking =
      log.collections.some((c) => !c.skipped && c.countMatch === false) ||
      log.collections.some((c) => c.error && !c.skipped) ||
      log.collections.some((c) => !c.skipped && c.indexError);
    if (blocking) {
      console.error(
        '\nMigration finished with mismatches or errors — see migration-log.json',
      );
      process.exitCode = 1;
      return;
    }

    console.log('\nMIGRATION SUCCESSFUL');
  } catch (err) {
    log.errors.push({ phase: 'main', message: err.message, stack: err.stack });
    log.finishedAt = new Date().toISOString();
    try {
      fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2), 'utf8');
    } catch {
      // ignore
    }
    console.error('Fatal migration error:', err.message);
    process.exitCode = 1;
  } finally {
    try {
      await sourceClient?.close();
    } catch {
      // ignore
    }
    try {
      await destClient?.close();
    } catch {
      // ignore
    }
    console.log('Connections closed.');
  }
}

main();
